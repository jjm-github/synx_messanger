import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from .config import get_settings

_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_session(conn, user_id, ip: str | None = None,
                   user_agent: str | None = None) -> str:
    settings = get_settings()
    session_id = secrets.token_bytes(8).hex()
    expires_at = datetime.now(timezone.utc) + timedelta(
        hours=settings.session_hours)
    conn.execute(
        """INSERT INTO auth_sessions (id, user_id, expires_at, ip, user_agent)
           VALUES (%s, %s, %s, %s, %s)""",
        (str(session_id), str(user_id), expires_at, ip, user_agent),
    )
    conn.commit()
    return str(session_id)


def get_session_user(conn, session_id: str):
    row = conn.execute(
        """SELECT u.id, u.full_name, u.short_name, u.active,
                  u.permission_group, u.date_registred, u.phone, u.e_mail,
                  u.photo_id, u.ui_state, s.expires_at AS session_expires
             FROM auth_sessions s
             JOIN users u ON u.id = s.user_id
            WHERE s.id = %s
              AND s.revoked_at IS NULL
              AND s.expires_at > now()""",
        (session_id,),
    ).fetchone()
    if not row or not row["active"]:
        return None
    return row
