"""TCP/WebSocket-микшер аудио.

Один процесс на всю установку принимает от участников комнаты 8-битный
µ-law PCM, приводит его к внутренней частоте, складывает голоса и
раздаёт каждому участнику обратно.  Браузер общается с FastAPI по
WebSocket (это тот же TCP), а FastAPI проксирует поток в этот локальный
микшер.  Благодаря отдельному порту микшер один для всех uvicorn-воркеров.

Поток данных:
    браузер --ws--> FastAPI --ws--> mixer --ws--> FastAPI --> браузер

Внутри микшера звук хранится как signed 16-bit little-endian mono.
Снаружи — µ-law 8 bit, поэтому 8 кГц занимает ~64 кбит/с, 16 кГц —
~128 кбит/с.  Частоту входа/выхода можно менять на лету; небольшая
автоподстройка по переполнению WebSocket-буфера помогает медленным
каналам.
"""
from __future__ import annotations

import asyncio
import audioop
import json
import logging
import threading
import time
from array import array
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlparse

from websockets.asyncio.server import serve

from .config import get_settings

log = logging.getLogger("synx.audio_mixer")

RATE_STEPS = (4000, 8000, 12000, 16000)   # 32 / 64 / 96 / 128 кбит/с
FRAME_SECONDS = 0.02
# Частота фиксируется при старте процесса; файл настроек не читаем
# на каждом 20-мс такте.
MIX_RATE = get_settings().audio_mix_rate
FRAME_BYTES = max(2, int(MIX_RATE * FRAME_SECONDS) * 2)

_rooms: dict[str, set["Peer"]] = {}
_started = False


@dataclass(eq=False)
class Peer:
    ws: object
    room: str
    user: str
    in_rate: int
    out_rate: int
    auto_out: bool = True
    in_state: object = None
    out_state: object = None
    pending: int = 0
    buffered: int = 0
    latency_ms: int = 0
    good_streak: int = 0
    pcm_buf: bytes = b""
    level: int = 0
    send_task: asyncio.Task | None = field(default=None, repr=False)


def _clamp_rate(value, fallback: int = 8000) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(RATE_STEPS, key=lambda x: abs(x - n))


def _frame_bytes() -> int:
    return FRAME_BYTES


def _resample(data: bytes, src: int, dst: int, state):
    if not data or src == dst:
        return data, state
    return audioop.ratecv(data, 2, 1, src, dst, state)


def _mix_frames(items: list[bytes]) -> bytes:
    """Сложить несколько PCM16-фрагментов одной длины с клиппингом."""
    frame_bytes = _frame_bytes()
    if not items:
        return b"\x00" * frame_bytes
    if len(items) == 1:
        data = items[0][:frame_bytes]
        return data.ljust(frame_bytes, b"\x00")
    acc = [0] * (frame_bytes // 2)
    for data in items:
        if not data:
            continue
        chunk = data[:frame_bytes].ljust(frame_bytes, b"\x00")
        vals = array("h")
        vals.frombytes(chunk)
        for i, v in enumerate(vals):
            acc[i] += v
    # Только ограничение диапазона. Автоматическое усиление/нормализация
    # на каждом кадре даёт «качели» громкости и треск на согласных.
    out = array("h", (max(-32768, min(32767, v)) for v in acc))
    return out.tobytes()


def _peer_audio(peer: Peer, mixed: bytes) -> bytes:
    pcm, peer.out_state = _resample(
        mixed, MIX_RATE, peer.out_rate, peer.out_state)
    return audioop.lin2ulaw(pcm, 2)


async def _safe_send(peer: Peer, data) -> None:
    """Не блокируем миксер медленным клиентом."""
    if peer.pending >= 8:
        return
    peer.pending += 1

    async def send():
        try:
            await asyncio.wait_for(peer.ws.send(data), timeout=0.5)
        except Exception:
            pass
        finally:
            peer.pending = max(0, peer.pending - 1)

    peer.send_task = asyncio.create_task(send())


async def _send_settings(peer: Peer) -> None:
    await _safe_send(peer, json.dumps({
        "type": "settings",
        "in_rate": peer.in_rate,
        "out_rate": peer.out_rate,
        "in_kbps": peer.in_rate * 8 // 1000,
        "out_kbps": peer.out_rate * 8 // 1000,
        "auto": peer.auto_out,
    }))


def _adjust_out_rate(peer: Peer) -> bool:
    if not peer.auto_out:
        return False
    idx = RATE_STEPS.index(peer.out_rate) if peer.out_rate in RATE_STEPS else 1
    # Буфер отправки у клиента — признак перегрузки его канала.
    # Задержка воспроизведения показывает, что исходящий поток не
    # успевает проигрываться. По ним и двигаем исходящий битрейт.
    if peer.latency_ms > 260 or peer.buffered > 64_000:
        if idx > 0:
            peer.out_rate = RATE_STEPS[idx - 1]
            peer.good_streak = 0
            peer.out_state = None
            return True
        peer.good_streak = 0
    elif peer.latency_ms < 90 and peer.buffered < 8_000:
        peer.good_streak += 1
        if peer.good_streak >= 3 and idx < len(RATE_STEPS) - 1:
            peer.out_rate = RATE_STEPS[idx + 1]
            peer.good_streak = 0
            peer.out_state = None
            return True
    else:
        peer.good_streak = 0
    return False


async def _mix_loop() -> None:
    tick = 0
    while True:
        await asyncio.sleep(FRAME_SECONDS)
        tick += 1
        for room, peers in list(_rooms.items()):
            if not peers:
                _rooms.pop(room, None)
                continue
            frames = []
            levels = {}
            for peer in peers:
                # Не режем каждый входной блок «как получилось»: держим
                # остаток и выдаём ровно 20-мс кадры. Иначе на стыках
                # 48→8→16 кГц теряются куски и слышны щелчки/рывки.
                if len(peer.pcm_buf) >= FRAME_BYTES:
                    frame = peer.pcm_buf[:FRAME_BYTES]
                    peer.pcm_buf = peer.pcm_buf[FRAME_BYTES:]
                    frames.append((peer, frame))
                    levels[peer.user] = max(levels.get(peer.user, 0), peer.level)
                else:
                    levels[peer.user] = max(levels.get(peer.user, 0), 0)
            if not frames:
                continue
            for peer in peers:
                # Свой голос не возвращаем: иначе получается эхо.
                others = [pcm for owner, pcm in frames if owner is not peer]
                if not others:
                    continue
                try:
                    payload = _peer_audio(peer, _mix_frames(others))
                    await _safe_send(peer, payload)
                except Exception:
                    pass
            if tick % 5 == 0:
                msg = json.dumps({"type": "levels", "levels": levels})
                for peer in peers:
                    await _safe_send(peer, msg)


async def _handle(conn) -> None:
    parsed = urlparse(conn.request.path)
    qs = parse_qs(parsed.query)
    room = (qs.get("room") or [""])[0].strip()
    user = (qs.get("user") or [""])[0].strip()
    if not room or not user:
        await conn.close(code=4400, reason="room and user required")
        return
    in_rate = _clamp_rate((qs.get("in_rate") or ["8000"])[0])
    out_rate = _clamp_rate((qs.get("out_rate") or ["8000"])[0])
    auto = (qs.get("auto") or ["1"])[0] not in ("0", "false", "no")
    peer = Peer(ws=conn, room=room, user=user, in_rate=in_rate,
                out_rate=out_rate, auto_out=auto)
    peers = _rooms.setdefault(room, set())
    # Если у пользователя осталась старая вкладка/зависшее соединение,
    # закрываем её. Иначе сервер будет пересылать человеку его же голос
    # с задержкой — это и слышно как эхо примерно через секунду.
    for old in list(peers):
        if old is not peer and old.user == user:
            print(f"[audio-mixer] replace {room}/{user}: {old.ws.remote_address} -> {conn.remote_address}", flush=True)
            peers.discard(old)
            asyncio.create_task(old.ws.close(
                code=4001, reason="replaced by newer connection"))
    peers.add(peer)
    print(f"[audio-mixer] join {room}/{user} in={in_rate} out={out_rate}", flush=True)
    await _send_settings(peer)
    try:
        async for msg in conn:
            if isinstance(msg, bytes):
                if not msg:
                    continue
                try:
                    pcm = audioop.ulaw2lin(msg, 2)
                    pcm, peer.in_state = _resample(
                        pcm, peer.in_rate, MIX_RATE, peer.in_state)
                    # Накапливаем без потерь; микшер сам нарежет 20-мс кадры.
                    peer.pcm_buf += pcm
                    max_buf = _frame_bytes() * 6
                    if len(peer.pcm_buf) > max_buf:
                        peer.pcm_buf = peer.pcm_buf[-max_buf:]
                    try:
                        peer.level = min(100, round(audioop.rms(pcm, 2) / 328))
                    except Exception:
                        peer.level = 0
                except Exception:
                    pass
                continue
            if isinstance(msg, str):
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                kind = str(data.get("type") or "")
                if kind == "stats":
                    try:
                        peer.buffered = int(data.get("buffered") or 0)
                    except (TypeError, ValueError):
                        peer.buffered = 0
                    try:
                        peer.latency_ms = int(data.get("latency") or 0)
                    except (TypeError, ValueError):
                        peer.latency_ms = 0
                    if _adjust_out_rate(peer):
                        await _send_settings(peer)
                elif kind == "in_rate":
                    rate = _clamp_rate(data.get("value"), peer.in_rate)
                    if rate != peer.in_rate:
                        peer.in_rate = rate
                        peer.in_state = None
                        peer.pcm_buf = b""
                        await _send_settings(peer)
                elif kind == "out_rate":
                    if isinstance(data.get("auto"), bool):
                        peer.auto_out = data["auto"]
                    rate = _clamp_rate(data.get("value"), peer.out_rate)
                    if rate != peer.out_rate:
                        peer.out_rate = rate
                        peer.out_state = None
                        peer.good_streak = 0
                    await _send_settings(peer)
                elif kind == "ping":
                    await _safe_send(peer, json.dumps({"type": "pong"}))
    except Exception:
        pass
    finally:
        peers = _rooms.get(room)
        if peers is not None:
            peers.discard(peer)
            print(f"[audio-mixer] leave {room}/{user}", flush=True)
            if not peers:
                _rooms.pop(room, None)


async def _serve() -> None:
    settings = get_settings()
    async with serve(
        _handle,
        settings.audio_host,
        settings.audio_port,
        max_size=2 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=20,
        compression=None,
    ):
        mixer_task = asyncio.create_task(_mix_loop())
        try:
            await asyncio.Future()
        finally:
            mixer_task.cancel()


def _run_forever() -> None:
    while True:
        try:
            asyncio.run(_serve())
        except OSError as exc:
            # Второй uvicorn-воркер не должен падать: порт уже занят
            # первым микшером. Через несколько секунд пробуем снова —
            # так микшер переживёт перезапуск воркера-владельца.
            log.debug("audio mixer is not owner yet: %s", exc)
            time.sleep(5)
        except Exception as exc:
            log.warning("audio mixer stopped: %s", exc)
            time.sleep(5)


def start_audio_mixer() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(
        target=_run_forever,
        name="synx-audio-mixer",
        daemon=True,
    ).start()
