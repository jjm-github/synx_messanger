"""Защита входа от подбора пароля: 3 ошибки на пару логин+IP — блок на час."""
from __future__ import annotations

from fastapi import Request

MAX_ATTEMPTS = 3
BLOCK_SECONDS = 60 * 60


def client_ip(request: Request) -> str:
    return (request.client.host if request.client else "") or "unknown"


def block_remaining(conn, short_name: str, ip: str) -> int:
    row = conn.execute(
        """SELECT blocked_until,
                  GREATEST(0, CEIL(EXTRACT(EPOCH FROM
                      (blocked_until - now()))))::int AS retry
             FROM login_attempts
            WHERE short_name=%s AND ip=%s""",
        ((short_name or "").lower(), ip),
    ).fetchone()
    if not row or row["blocked_until"] is None:
        return 0
    return max(0, int(row["retry"] or 0))


def record_failure(conn, short_name: str, ip: str) -> None:
    key = (short_name or "").lower()
    conn.execute(
        """UPDATE login_attempts
              SET attempts=0, blocked_until=NULL
            WHERE short_name=%s AND ip=%s
              AND blocked_until IS NOT NULL AND blocked_until <= now()""",
        (key, ip),
    )
    row = conn.execute(
        "SELECT attempts FROM login_attempts WHERE short_name=%s AND ip=%s",
        (key, ip),
    ).fetchone()
    attempts = (int(row["attempts"]) if row else 0) + 1
    if attempts >= MAX_ATTEMPTS:
        blocked = "now() + interval '1 hour'"
    else:
        blocked = "NULL"
    conn.execute(
        f"""INSERT INTO login_attempts
                (short_name, ip, attempts, blocked_until, last_attempt)
            VALUES (%s, %s, %s, {blocked}, now())
            ON CONFLICT (short_name, ip) DO UPDATE SET
                attempts=EXCLUDED.attempts,
                blocked_until=EXCLUDED.blocked_until,
                last_attempt=now()""",
        (key, ip, attempts),
    )
    conn.commit()


def clear_failures(conn, short_name: str, ip: str) -> None:
    conn.execute(
        "DELETE FROM login_attempts WHERE short_name=%s AND ip=%s",
        ((short_name or "").lower(), ip),
    )
    conn.commit()
