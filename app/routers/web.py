from pathlib import Path

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from ..config import get_settings
from ..db import get_db
from ..deps import get_current_user_optional
from ..login_guard import (
    block_remaining,
    clear_failures,
    client_ip,
    record_failure,
)
from ..security import create_session, verify_password

router = APIRouter(include_in_schema=False)
TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates"
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))


@router.get("/login")
def login_page(request: Request, user=Depends(get_current_user_optional)):
    if user:
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"user": None, "error": None},
    )


@router.post("/login")
def login_action(
    request: Request,
    short_name: str = Form(...),
    password: str = Form(...),
    db=Depends(get_db),
):
    ip = client_ip(request)
    short_name = short_name.strip().lower()
    retry = block_remaining(db, short_name, ip)
    if retry > 0:
        minutes = max(1, (retry + 59) // 60)
        return templates.TemplateResponse(
            request, "login.html",
            {"user": None,
             "error": f"Слишком много попыток. Повторите через {minutes} мин.",
             "short_name": short_name},
            status_code=429,
        )
    row = db.execute(
        "SELECT * FROM users WHERE short_name = %s", (short_name,),
    ).fetchone()
    if (not row or not verify_password(password, row["password_hash"])
            or not row["active"]):
        record_failure(db, short_name, ip)
        return templates.TemplateResponse(
            request, "login.html",
            {"user": None, "error": "Неверный логин или пароль",
             "short_name": short_name},
            status_code=401,
        )
    clear_failures(db, short_name, ip)
    settings = get_settings()
    session_id = create_session(
        db, row["id"],
        ip=(request.client.host if request.client else None),
        user_agent=request.headers.get("user-agent"),
    )
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        key=settings.session_cookie,
        value=session_id,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=settings.session_hours * 3600,
    )
    return response


@router.get("/logout")
def logout(request: Request, db=Depends(get_db)):
    settings = get_settings()
    session_id = request.cookies.get(settings.session_cookie)
    if session_id:
        db.execute(
            "UPDATE auth_sessions SET revoked_at=now() WHERE id=%s",
            (session_id,),
        )
        db.commit()
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(settings.session_cookie)
    return response


@router.get("/")
def index(request: Request, user=Depends(get_current_user_optional)):
    if not user:
        return RedirectResponse("/login", status_code=303)
    state = user.get("ui_state") or {}
    return templates.TemplateResponse(
        request, "index.html",
        {"user": user, "synx_ui_state": state},
    )
