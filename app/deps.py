import time

from fastapi import Depends, HTTPException, Request, status

from .config import get_settings
from .db import db_conn, get_db
from .ids import is_id
from .security import get_session_user

_SESSION_CACHE = {}
_SESSION_TTL = 30.0


def _cached_session_user(session_id):
    hit = _SESSION_CACHE.get(session_id)
    if not hit:
        return None
    expires, user = hit
    if expires <= time.monotonic():
        _SESSION_CACHE.pop(session_id, None)
        return None
    return user


def _remember_session_user(session_id, user):
    now = time.monotonic()
    if len(_SESSION_CACHE) > 4096:
        for sid, (exp, _u) in list(_SESSION_CACHE.items()):
            if exp <= now:
                _SESSION_CACHE.pop(sid, None)
    if user:
        _SESSION_CACHE[session_id] = (now + _SESSION_TTL, user)
    else:
        _SESSION_CACHE.pop(session_id, None)


def _session_user(request: Request, db):
    session_id = request.cookies.get(get_settings().session_cookie)
    if not session_id or not is_id(session_id):
        return None
    cached = _cached_session_user(session_id)
    if cached is not None:
        return cached
    user = get_session_user(db, session_id)
    _remember_session_user(session_id, user)
    return user


def _check_user(user):
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    if not user.get("active"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is inactive",
        )
    return user


def get_current_user_optional(request: Request, db=Depends(get_db)):
    return _session_user(request, db)


def require_user(user=Depends(get_current_user_optional)):
    return _check_user(user)


def get_current_user_optional_short(request: Request):
    session_id = request.cookies.get(get_settings().session_cookie)
    if not session_id or not is_id(session_id):
        return None
    cached = _cached_session_user(session_id)
    if cached is not None:
        return cached
    with db_conn() as db:
        user = get_session_user(db, session_id)
    _remember_session_user(session_id, user)
    return user


def require_user_short(user=Depends(get_current_user_optional_short)):
    return _check_user(user)
