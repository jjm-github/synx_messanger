"""Аудио-комнаты: серверный µ-law-микшер + WebRTC fallback.

Медиа в основном режиме идёт через локальный WebSocket-микшер
(app/audio_mixer.py), а FastAPI проксирует его браузеру. WebRTC mesh
остаётся запасным вариантом, если микшер недоступен.
"""
from __future__ import annotations

import asyncio
import secrets
from urllib.parse import urlencode

from fastapi import APIRouter, Body, Depends, HTTPException, WebSocket
from psycopg.types.json import Jsonb
from websockets.asyncio.client import connect as ws_connect

from ..config import get_settings
from ..db import db_conn, get_db
from ..deps import require_user
from ..ids import is_id
from ..security import get_session_user

router = APIRouter(tags=["audio"])

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audio_room_peers (
    broadcaster_id text NOT NULL,
    peer_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL DEFAULT '',
    host boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (broadcaster_id, peer_id)
);
CREATE INDEX IF NOT EXISTS ix_audio_room_peers_bid
    ON audio_room_peers(broadcaster_id, updated_at);
CREATE TABLE IF NOT EXISTS audio_signals (
    id bigserial PRIMARY KEY,
    broadcaster_id text NOT NULL,
    from_peer text NOT NULL,
    to_peer text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audio_signals_target
    ON audio_signals(broadcaster_id, to_peer, id);
CREATE INDEX IF NOT EXISTS ix_audio_signals_created
    ON audio_signals(created_at);
CREATE TABLE IF NOT EXISTS audio_rooms (
    id text PRIMARY KEY,
    name text NOT NULL,
    creator_id text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audio_rooms
    ADD COLUMN IF NOT EXISTS audio boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS audio_room_invites (
    room_id text NOT NULL REFERENCES audio_rooms(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
"""


def ensure_audio_schema() -> None:
    with db_conn() as db:
        db.execute("SELECT pg_advisory_xact_lock(918273645)")
        db.execute(_SCHEMA)
        db.commit()


def _cleanup(db) -> None:
    db.execute(
        """DELETE FROM audio_room_peers
            WHERE updated_at < now() - interval '2 minutes'""")
    db.execute(
        """UPDATE audio_rooms r SET active=false
            WHERE r.active AND r.audio
              AND r.created_at < now() - interval '2 minutes'
              AND NOT EXISTS (
                  SELECT 1 FROM audio_room_peers p
                   WHERE p.broadcaster_id=r.id AND p.host
                     AND p.updated_at > now() - interval '2 minutes'
              )""")
    db.execute(
        """DELETE FROM audio_signals
            WHERE created_at < now() - interval '1 hour'""")


def _validate_peer(db, broadcaster_id, peer_id, user_id):
    return db.execute(
        """SELECT peer_id, user_id, host FROM audio_room_peers
            WHERE broadcaster_id=%s AND peer_id=%s AND user_id=%s""",
        (str(broadcaster_id), str(peer_id), str(user_id)),
    ).fetchone()


def _peers(db, broadcaster_id):
    rows = db.execute(
        """SELECT peer_id, user_id, name, host
             FROM audio_room_peers
            WHERE broadcaster_id=%s
              AND updated_at > now() - interval '2 minutes'
            ORDER BY host DESC, name, peer_id""",
        (str(broadcaster_id),),
    ).fetchall()
    return [{
        "peer_id": str(r["peer_id"]),
        "user_id": str(r["user_id"]),
        "name": r["name"] or "",
        "host": bool(r["host"]),
    } for r in rows]


@router.post("/api/audio/rooms")
def audio_create_room(payload: dict = Body(...),
                      db=Depends(get_db), user=Depends(require_user)):
    name = str(payload.get("name") or "").strip()[:100]
    if not name:
        raise HTTPException(422, "Room name is required")
    invite_ids = [str(x) for x in (payload.get("invite_ids") or []) if x]
    with_audio = bool(payload.get("audio", True))
    notify = payload.get("notify", True) is not False
    room_id = secrets.token_hex(8)
    creator = db.execute(
        "SELECT id, short_name, full_name FROM users WHERE id=%s",
        (str(user["id"]),),
    ).fetchone()
    if not creator:
        raise HTTPException(403, "User not found")
    db.execute(
        """INSERT INTO audio_rooms(id, name, creator_id, audio)
           VALUES (%s,%s,%s,%s)""",
        (room_id, name, str(user["id"]), with_audio),
    )
    from ..direct_messages import send as dm_send
    creator_name = creator["short_name"] or creator["full_name"] or "Пользователь"
    for uid in dict.fromkeys(invite_ids):
        if not uid or uid == str(user["id"]):
            continue
        exists = db.execute(
            "SELECT 1 FROM users WHERE id=%s AND active=true", (uid,)
        ).fetchone()
        if not exists:
            continue
        db.execute(
            """INSERT INTO audio_room_invites(room_id, user_id)
               VALUES (%s,%s) ON CONFLICT DO NOTHING""",
            (room_id, uid),
        )
        text = (f"{creator_name} приглашает вас присоединиться к {name}, "
                f"если вы хотите присоединиться прямо сейчас, нажмите "
                f"[[здесь]](synx-audio:{room_id}).")
        if notify:
            dm_send(db, str(user["id"]), uid, text, [])
    db.commit()
    return {"room": {
        "id": room_id, "name": name, "creator_id": str(user["id"]),
        "audio": with_audio,
    }}


@router.get("/api/audio/rooms/{room_id}")
def audio_room_info(room_id: str, db=Depends(get_db),
                    user=Depends(require_user)):
    room = db.execute(
        """SELECT id, name, creator_id, audio, active
             FROM audio_rooms WHERE id=%s""",
        (str(room_id),),
    ).fetchone()
    if not room:
        raise HTTPException(404, "Audio room not found")
    if str(room["creator_id"]) != str(user["id"]):
        invited = db.execute(
            """SELECT 1 FROM audio_room_invites
                WHERE room_id=%s AND user_id=%s""",
            (str(room_id), str(user["id"])),
        ).fetchone()
        if not invited:
            raise HTTPException(403, "Not invited to this room")
    return {"room": {
        "id": str(room["id"]), "name": room["name"],
        "creator_id": str(room["creator_id"]),
        "audio": bool(room["audio"]), "active": bool(room["active"]),
    }}


@router.post("/api/audio/{room_id}/join")
def audio_join(room_id: str, payload: dict = Body(...),
               db=Depends(get_db), user=Depends(require_user)):
    room_id = str(room_id)
    peer_id = str(payload.get("peer_id") or "").strip()
    name = str(payload.get("name") or "").strip()[:80]
    host = bool(payload.get("host"))
    if not peer_id or len(peer_id) > 120:
        raise HTTPException(422, "Bad peer_id")
    room = db.execute(
        "SELECT id, creator_id, active FROM audio_rooms WHERE id=%s",
        (room_id,),
    ).fetchone()
    if not room:
        raise HTTPException(404, "Audio room not found")
    if not room["active"]:
        raise HTTPException(404, "Audio room is not active")
    if host and str(room["creator_id"]) != str(user["id"]):
        raise HTTPException(403, "Only room creator can host audio")
    _cleanup(db)
    db.execute(
        """INSERT INTO audio_room_peers
               (broadcaster_id, peer_id, user_id, name, host, updated_at)
           VALUES (%s,%s,%s,%s,%s,now())
           ON CONFLICT (broadcaster_id, peer_id) DO UPDATE
             SET user_id=EXCLUDED.user_id, name=EXCLUDED.name,
                 host=EXCLUDED.host, updated_at=now()""",
        (room_id, peer_id, str(user["id"]), name or "Гость", host),
    )
    db.commit()
    return {"peer_id": peer_id, "peers": _peers(db, room_id)}


@router.post("/api/audio/{room_id}/leave")
def audio_leave(room_id: str, payload: dict = Body(...),
                db=Depends(get_db), user=Depends(require_user)):
    room_id = str(room_id)
    peer_id = str(payload.get("peer_id") or "").strip()
    if not peer_id:
        return {"ok": True}
    was_host = db.execute(
        """SELECT host FROM audio_room_peers
            WHERE broadcaster_id=%s AND peer_id=%s AND user_id=%s""",
        (room_id, peer_id, str(user["id"])),
    ).fetchone()
    db.execute(
        """DELETE FROM audio_room_peers
            WHERE broadcaster_id=%s AND peer_id=%s AND user_id=%s""",
        (room_id, peer_id, str(user["id"])),
    )
    if was_host and was_host.get("host"):
        db.execute(
            """UPDATE audio_rooms SET active=false
                WHERE id=%s AND creator_id=%s""",
            (room_id, str(user["id"])),
        )
        db.execute(
            "DELETE FROM audio_room_peers WHERE broadcaster_id=%s",
            (room_id,),
        )
    db.execute(
        """DELETE FROM audio_signals
            WHERE broadcaster_id=%s AND (from_peer=%s OR to_peer=%s)""",
        (room_id, peer_id, peer_id),
    )
    db.commit()
    return {"ok": True}


@router.post("/api/audio/{room_id}/signal")
def audio_signal(room_id: str, payload: dict = Body(...),
                 db=Depends(get_db), user=Depends(require_user)):
    room_id = str(room_id)
    from_peer = str(payload.get("from_peer") or "").strip()
    to_peer = str(payload.get("to_peer") or "").strip()
    kind = str(payload.get("kind") or "")
    if kind not in ("offer", "answer", "ice"):
        raise HTTPException(422, "Bad signal kind")
    if not from_peer or not to_peer:
        raise HTTPException(422, "Bad peers")
    if not _validate_peer(db, room_id, from_peer, user["id"]):
        raise HTTPException(403, "Not a member of this room")
    if not db.execute(
        """SELECT 1 FROM audio_room_peers
            WHERE broadcaster_id=%s AND peer_id=%s
              AND updated_at > now() - interval '2 minutes'""",
        (room_id, to_peer),
    ).fetchone():
        raise HTTPException(404, "Peer not found")
    _cleanup(db)
    db.execute(
        """INSERT INTO audio_signals
               (broadcaster_id, from_peer, to_peer, kind, payload)
           VALUES (%s,%s,%s,%s,%s)""",
        (room_id, from_peer, to_peer, kind,
         Jsonb(payload.get("payload") or {})),
    )
    db.commit()
    return {"ok": True}


@router.websocket("/api/audio/{room_id}/ws")
async def audio_ws(websocket: WebSocket, room_id: str):
    """Прокси браузерного WebSocket в локальный TCP/WS-микшер."""
    settings = get_settings()
    session_id = websocket.cookies.get(settings.session_cookie)
    if not session_id or not is_id(session_id):
        await websocket.close(code=4401, reason="Not authenticated")
        return
    with db_conn() as db:
        user = get_session_user(db, session_id)
        if not user or not user.get("active"):
            await websocket.close(code=4401, reason="Not authenticated")
            return
        room = db.execute(
            "SELECT id, active FROM audio_rooms WHERE id=%s",
            (str(room_id),),
        ).fetchone()
        if not room or not room["active"]:
            await websocket.close(code=4404, reason="Room not found")
            return

    peer_id = str(websocket.query_params.get("peer") or "")[:120]
    if not peer_id:
        peer_id = secrets.token_hex(8)

    def rate(name, default):
        try:
            value = int(websocket.query_params.get(name) or default)
        except (TypeError, ValueError):
            value = default
        return max(4000, min(16000, value))

    query = urlencode({
        "room": str(room_id),
        "user": str(user["id"]),
        "peer": peer_id,
        "in_rate": rate("in_rate", 8000),
        "out_rate": rate("out_rate", 8000),
        "auto": "1" if str(websocket.query_params.get("auto") or "1")
        not in ("0", "false", "no") else "0",
    })
    mixer_uri = (f"ws://{settings.audio_host}:{settings.audio_port}/mix"
                 f"?{query}")
    await websocket.accept()
    try:
        mixer = await ws_connect(
            mixer_uri, max_size=2 * 1024 * 1024,
            ping_interval=None, compression=None, proxy=None,
        )
    except Exception:
        await websocket.close(code=1011, reason="Audio mixer unavailable")
        return

    async def browser_to_mixer():
        try:
            while True:
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await mixer.send(msg["bytes"])
                elif msg.get("text") is not None:
                    await mixer.send(msg["text"])
        except Exception:
            pass
        finally:
            await mixer.close()

    async def mixer_to_browser():
        try:
            async for msg in mixer:
                if isinstance(msg, (bytes, bytearray)):
                    await websocket.send_bytes(bytes(msg))
                else:
                    await websocket.send_text(str(msg))
        except Exception:
            pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    await asyncio.gather(browser_to_mixer(), mixer_to_browser(),
                         return_exceptions=True)
    try:
        await mixer.close()
    except Exception:
        pass
    try:
        await websocket.close()
    except Exception:
        pass


@router.get("/api/audio/{room_id}/signals")
def audio_signals(room_id: str, peer_id: str, after: int = 0,
                  db=Depends(get_db), user=Depends(require_user)):
    room_id = str(room_id)
    if not _validate_peer(db, room_id, peer_id, user["id"]):
        raise HTTPException(403, "Not a member of this room")
    db.execute(
        """UPDATE audio_room_peers SET updated_at=now()
            WHERE broadcaster_id=%s AND peer_id=%s AND user_id=%s""",
        (room_id, peer_id, str(user["id"])),
    )
    rows = db.execute(
        """SELECT id, from_peer, kind, payload
             FROM audio_signals
            WHERE broadcaster_id=%s AND to_peer=%s AND id > %s
            ORDER BY id LIMIT 200""",
        (room_id, peer_id, max(0, int(after or 0))),
    ).fetchall()
    db.commit()
    return {
        "signals": [{
            "id": int(r["id"]),
            "from_peer": str(r["from_peer"]),
            "kind": r["kind"],
            "payload": r["payload"] or {},
        } for r in rows],
        "peers": _peers(db, room_id),
    }
