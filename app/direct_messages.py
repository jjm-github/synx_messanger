"""Личные сообщения пользователей и вложения к ним."""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from pathlib import Path

import psycopg
from fastapi import HTTPException, UploadFile
from psycopg.rows import dict_row

from .config import get_settings

log = logging.getLogger("synx.messenger.direct")

MAX_FILES = 10
MAX_FILE_BYTES = 50 * 1024 * 1024


def _lc(value) -> str:
    return str(value).strip().lower()


def _user_row(conn, user_id):
    return conn.execute(
        "SELECT id, short_name, full_name, active FROM users WHERE id=%s",
        (str(user_id),),
    ).fetchone()


def _pair_key(a, b):
    return "-".join(sorted([str(a), str(b)]))


def _file_name(value):
    name = Path(str(value or "file")).name
    return name or "file"


def _store_files(conn, sender_id, recipient_id, message_id, files):
    files = [f for f in (files or []) if f and getattr(f, "filename", None)]
    if not files:
        return []
    if len(files) > MAX_FILES:
        raise HTTPException(
            422, f"К одному сообщению — не больше {MAX_FILES} файлов")
    settings = get_settings()
    root = Path(settings.storage_path).resolve()
    dest_dir = root / "direct" / _pair_key(
        sender_id, recipient_id) / str(message_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for upload in files:
        orig_name = _file_name(upload.filename)
        name = _lc(orig_name)
        dest = dest_dir / name
        dup = 1
        while dest.exists():
            stem, suffix = Path(name).stem, Path(name).suffix
            dest = dest_dir / f"{stem}_{dup}{suffix}"
            dup += 1
        size = 0
        sha = hashlib.sha256()
        with dest.open("wb") as fh:
            while True:
                chunk = upload.file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    fh.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"Файл больше {MAX_FILE_BYTES // (1024 * 1024)} МБ",
                    )
                fh.write(chunk)
                sha.update(chunk)
        frow = conn.execute(
            """INSERT INTO file_objects
                   (kind, original_name, storage_path, mime_type, size_bytes,
                    sha256, created_by)
               VALUES ('attachment',%s,%s,%s,%s,%s,%s) RETURNING id""",
            (orig_name, str(dest), upload.content_type, size, sha.hexdigest(),
             str(sender_id)),
        ).fetchone()
        conn.execute(
            """INSERT INTO direct_message_attachments (message_id, file_id)
               VALUES (%s,%s)""",
            (str(message_id), str(frow["id"])),
        )
        saved.append(frow)
    return saved


def _attachments(conn, message_ids):
    if not message_ids:
        return {}
    rows = conn.execute(
        """SELECT dma.message_id, f.id, f.original_name, f.mime_type
             FROM direct_message_attachments dma
             JOIN file_objects f ON f.id=dma.file_id
            WHERE dma.message_id = ANY(%s::text[])
            ORDER BY f.original_name""",
        ([str(x) for x in message_ids],),
    ).fetchall()
    out = {}
    for row in rows:
        out.setdefault(str(row["message_id"]), []).append({
            "file_id": str(row["id"]),
            "name": row["original_name"],
            "mime": row.get("mime_type"),
            "url": f"/files/{row['id']}",
            "pretty_url": None,
        })
    return out


def public_messages(conn, rows, me=None):
    ids = [str(r["id"]) for r in rows]
    atts = _attachments(conn, ids)
    out = []
    for r in rows:
        out.append({
            "id": str(r["id"]),
            "body": r.get("body") or "",
            "created_at": (r["created_at"].isoformat()
                           if r.get("created_at") else None),
            "updated_at": (r["updated_at"].isoformat()
                           if r.get("updated_at") else None),
            "author_id": str(r["sender_id"]),
            "author": r.get("sender_short"),
            "author_full": (r.get("sender_full")
                            or r.get("sender_short") or "—"),
            "attachments": atts.get(str(r["id"]), []),
            "can_edit": bool(me is not None
                             and str(r["sender_id"]) == str(me)),
            "can_delete": False,
        })
    return out


def feed(conn, me, other_id, limit=300):
    other = _user_row(conn, other_id)
    if not other or not other["active"]:
        raise HTTPException(404, "User not found")
    rows = conn.execute(
        """SELECT dm.*, u.short_name AS sender_short,
                  u.full_name AS sender_full
             FROM direct_messages dm
             JOIN users u ON u.id=dm.sender_id
            WHERE (dm.sender_id=%s AND dm.recipient_id=%s)
               OR (dm.sender_id=%s AND dm.recipient_id=%s)
            ORDER BY dm.created_at, dm.id
            LIMIT %s""",
        (str(me), str(other_id), str(other_id), str(me), int(limit)),
    ).fetchall()
    # Открытие диалога — это прочтение входящих.
    conn.execute(
        """UPDATE direct_messages SET read_at=now()
            WHERE sender_id=%s AND recipient_id=%s AND read_at IS NULL""",
        (str(other_id), str(me)),
    )
    return {
        "comments": public_messages(conn, rows, me=me),
        "can_comment": True,
        "other": {
            "user_id": str(other["id"]),
            "short_name": other["short_name"],
            "full_name": other["full_name"],
        },
    }


def send(conn, sender_id, recipient_id, body, files):
    other = _user_row(conn, recipient_id)
    if not other or not other["active"]:
        raise HTTPException(422, "Получатель не найден или неактивен")
    body = str(body or "").strip()
    files = [f for f in (files or []) if f and getattr(f, "filename", None)]
    if not body and not files:
        raise HTTPException(422, "Сообщение пустое")
    row = conn.execute(
        """INSERT INTO direct_messages (sender_id, recipient_id, body)
           VALUES (%s,%s,%s) RETURNING id, created_at""",
        (str(sender_id), str(recipient_id), body),
    ).fetchone()
    _store_files(conn, sender_id, recipient_id, row["id"], files)
    return feed(conn, sender_id, recipient_id)


def edit_message(conn, message_id, user_id, body):
    row = conn.execute(
        "SELECT id, sender_id, recipient_id FROM direct_messages WHERE id=%s",
        (str(message_id),),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Message not found")
    if str(row["sender_id"]) != str(user_id):
        raise HTTPException(403, "Можно редактировать только свои сообщения")
    body = str(body or "").strip()
    if not body:
        raise HTTPException(422, "Сообщение не может быть пустым")
    conn.execute(
        "UPDATE direct_messages SET body=%s, updated_at=now() WHERE id=%s",
        (body, str(message_id)),
    )
    return feed(conn, user_id, row["recipient_id"])


def unread(conn, me):
    rows = conn.execute(
        """SELECT dm.sender_id, count(*)::int AS n,
                  u.short_name, u.full_name, u.photo_id,
                  f.sha256 AS photo_sha,
                  max(dm.created_at) AS last_at
             FROM direct_messages dm
             JOIN users u ON u.id=dm.sender_id
             LEFT JOIN file_objects f ON f.id=u.photo_id
            WHERE dm.recipient_id=%s AND dm.read_at IS NULL
            GROUP BY dm.sender_id, u.short_name, u.full_name, u.photo_id,
                     f.sha256
            ORDER BY last_at DESC""",
        (str(me),),
    ).fetchall()
    return {
        "unread": {str(r["sender_id"]): int(r["n"]) for r in rows},
        "senders": [{
            "user_id": str(r["sender_id"]),
            "short_name": r["short_name"],
            "full_name": r["full_name"],
            "photo_id": str(r["photo_id"]) if r.get("photo_id") else None,
            "photo_url": (f"/files/{r['photo_id']}"
                          if r.get("photo_id") else None),
            "photo_thumb_url": (
                f"/files/{r['photo_id']}/avatar"
                + (f"?v={str(r['photo_sha'])[:16]}"
                   if r.get("photo_sha") else "")
                if r.get("photo_id") else None),
            "unread": int(r["n"]),
            "last_at": (r["last_at"].isoformat()
                        if r.get("last_at") else None),
        } for r in rows],
        "total": sum(int(r["n"]) for r in rows),
    }


def purge_expired(conn, days=None):
    if days is None:
        days = int(get_settings().dm_retention_days or 14)
    days = int(days)
    if days <= 0:
        return 0
    rows = conn.execute(
        """SELECT dm.id, f.id AS file_id, f.storage_path
             FROM direct_messages dm
             LEFT JOIN direct_message_attachments dma
                    ON dma.message_id=dm.id
             LEFT JOIN file_objects f ON f.id=dma.file_id
            WHERE dm.created_at < now() - (%s * interval '1 day')""",
        (days,),
    ).fetchall()
    if not rows:
        return 0
    message_ids = {str(r["id"]) for r in rows}
    file_ids = {str(r["file_id"]) for r in rows if r.get("file_id")}
    paths = [str(r["storage_path"]) for r in rows if r.get("storage_path")]
    conn.execute(
        "DELETE FROM direct_messages WHERE id = ANY(%s::text[])",
        (list(message_ids),),
    )
    if file_ids:
        conn.execute(
            """DELETE FROM file_objects f
                WHERE f.id = ANY(%s::text[])
                  AND NOT EXISTS (
                      SELECT 1 FROM direct_message_attachments dma
                       WHERE dma.file_id=f.id)""",
            (list(file_ids),),
        )
    conn.commit()
    for path in paths:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass
    return len(message_ids)


def cleanup_once(days=None):
    try:
        with psycopg.connect(
                get_settings().db_dsn, row_factory=dict_row) as conn:
            return purge_expired(conn, days)
    except Exception as exc:
        log.warning("direct message cleanup failed: %s", exc)
        return 0


def start_cleanup_worker():
    def loop():
        while True:
            cleanup_once()
            time.sleep(6 * 3600)

    threading.Thread(
        target=loop, name="synx-messenger-direct-cleanup", daemon=True,
    ).start()
