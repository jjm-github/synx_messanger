"""Онлайн-присутствие: кто в сети, кто говорит, у кого есть аудио-комната."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from ..config import get_settings
from ..db import get_db
from ..deps import require_user
from ..login_guard import client_ip

router = APIRouter(tags=["presence"])


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


@router.post("/api/presence/heartbeat")
def presence_heartbeat(
    payload: dict = Body(...),
    request: Request = None,
    db=Depends(get_db),
    user=Depends(require_user),
):
    session_id = request.cookies.get(get_settings().session_cookie)
    if not session_id:
        raise HTTPException(401, "No session")
    db.execute(
        """INSERT INTO user_presence
               (session_id, user_id, page, title, activity, ip, user_agent,
                visible, last_seen)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,now())
           ON CONFLICT (session_id) DO UPDATE SET
               user_id=EXCLUDED.user_id,
               page=EXCLUDED.page,
               title=EXCLUDED.title,
               activity=EXCLUDED.activity,
               ip=EXCLUDED.ip,
               user_agent=EXCLUDED.user_agent,
               visible=EXCLUDED.visible,
               last_seen=now()""",
        (
            session_id,
            str(user["id"]),
            _text(payload.get("page"), 1000),
            _text(payload.get("title"), 300),
            _text(payload.get("activity"), 800),
            client_ip(request),
            _text(request.headers.get("user-agent"), 500),
            bool(payload.get("visible", True)),
        ),
    )
    db.commit()
    return {"ok": True}


@router.get("/api/presence/users")
def presence_users(db=Depends(get_db), user=Depends(require_user)):
    """Все активные пользователи + онлайн-статус и последнее сообщение."""
    rows = db.execute(
        """WITH latest AS (
               SELECT DISTINCT ON (p.user_id)
                      p.user_id, p.activity, p.last_seen
                 FROM user_presence p
                ORDER BY p.user_id, p.last_seen DESC
           )
           SELECT u.id AS user_id, u.short_name, u.full_name, u.photo_id,
                  f.sha256 AS photo_sha,
                  COALESCE(u.ui_state->>'presence_status', 'online')
                      AS presence_status,
                  l.activity, l.last_seen,
                  COALESCE(l.last_seen > now() - interval '60 seconds',
                           false) AS online,
                  (SELECT count(*) FROM user_presence p2
                     JOIN auth_sessions s2 ON s2.id=p2.session_id
                    WHERE p2.user_id=u.id
                      AND p2.last_seen > now() - interval '60 seconds'
                      AND s2.revoked_at IS NULL AND s2.expires_at > now()
                  ) AS connections
             FROM users u
             LEFT JOIN latest l ON l.user_id=u.id
             LEFT JOIN file_objects f ON f.id=u.photo_id
            WHERE u.active
            ORDER BY online DESC, lower(u.short_name)""",
    ).fetchall()

    room_rows = db.execute(
        """SELECT id, name, creator_id, audio FROM audio_rooms
            WHERE active ORDER BY created_at DESC""",
    ).fetchall()
    rooms = {str(r["id"]): r for r in room_rows}
    user_room = {}
    for rid, r in rooms.items():
        user_room.setdefault(str(r["creator_id"]), rid)
    member_rows = db.execute(
        """SELECT broadcaster_id, user_id FROM audio_room_peers
            WHERE updated_at > now() - interval '2 minutes'""",
    ).fetchall()
    for r in member_rows:
        rid = str(r["broadcaster_id"])
        if rid in rooms:
            user_room.setdefault(str(r["user_id"]), rid)

    last_rows = db.execute(
        """WITH m AS (
               SELECT CASE WHEN sender_id=%s THEN recipient_id
                           ELSE sender_id END AS other_id,
                      body, created_at
                 FROM direct_messages
                WHERE sender_id=%s OR recipient_id=%s
           )
           SELECT DISTINCT ON (other_id) other_id, body, created_at
             FROM m ORDER BY other_id, created_at DESC""",
        (str(user["id"]), str(user["id"]), str(user["id"])),
    ).fetchall()
    last_by_user = {str(r["other_id"]): r for r in last_rows}

    audio_link_rows = db.execute(
        """SELECT COALESCE(r.creator_id, a.broadcaster_id) AS broadcaster_id,
                  a.user_id AS viewer_id
             FROM audio_room_peers a
             LEFT JOIN audio_rooms r
                    ON r.id=a.broadcaster_id AND r.active
             JOIN users bu
               ON bu.id=COALESCE(r.creator_id, a.broadcaster_id)
              AND bu.active
             JOIN users vu ON vu.id=a.user_id AND vu.active
            WHERE NOT a.host
              AND a.updated_at > now() - interval '2 minutes'
              AND r.id IS NOT NULL
            ORDER BY 1, a.user_id""",
    ).fetchall()

    out = []
    for r in rows:
        uid = str(r["user_id"])
        status = r["presence_status"] or "online"
        online = bool(r["online"]) and status != "offline"
        photo_id = str(r["photo_id"]) if r.get("photo_id") else None
        photo_ver = str(r.get("photo_sha") or "")[:16]
        room_id = user_room.get(uid)
        out.append({
            "user_id": uid,
            "short_name": r["short_name"],
            "full_name": r["full_name"],
            "photo_id": photo_id,
            "photo_url": f"/files/{photo_id}" if photo_id else None,
            "photo_thumb_url": (
                f"/files/{photo_id}/avatar"
                + (f"?v={photo_ver}" if photo_ver else "")
                if photo_id else None),
            "presence_status": status if r["online"] else "offline",
            "connections": int(r["connections"] or 0),
            "activity": r["activity"],
            "last_seen": (r["last_seen"].isoformat()
                          if r["last_seen"] else None),
            "online": online,
            "mic": bool(room_id),
            "audio_room_id": room_id,
            "last_message": (last_by_user.get(uid) or {}).get("body") or "",
        })
    return {
        "online": sum(1 for r in out if r["online"]),
        "connections_total": sum(
            r["connections"] for r in out if r["online"]),
        "connections": out,
        "audio_links": [{
            "broadcaster_id": str(r["broadcaster_id"]),
            "viewer_id": str(r["viewer_id"]),
        } for r in audio_link_rows],
    }
