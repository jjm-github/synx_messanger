"""Состояние интерфейса пользователя: тема, цветовые схемы, статус."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..db import get_db
from ..deps import require_user

router = APIRouter(prefix="/api/me", tags=["ui-state"])


class UiStateUpdate(BaseModel):
    theme: str | None = Field(default=None, max_length=64)
    theme_colors: str | None = Field(default=None, max_length=128)
    lang: str | None = Field(default=None, max_length=8)
    presence_status: str | None = Field(default=None, max_length=16)


@router.get("/ui-state")
def read_ui_state(user=Depends(require_user), db=Depends(get_db)):
    row = db.execute(
        "SELECT ui_state FROM users WHERE id = %s", (user["id"],),
    ).fetchone()
    return {"state": (row["ui_state"] if row else None) or {}}


@router.put("/ui-state")
def save_ui_state(payload: UiStateUpdate, user=Depends(require_user),
                  db=Depends(get_db)):
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not patch:
        return {"ok": True}
    if "presence_status" in patch and patch["presence_status"] not in (
            "online", "away", "dnd", "offline"):
        patch.pop("presence_status")
    if not patch:
        return {"ok": True}
    patch["ts"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.execute(
        """UPDATE users
              SET ui_state = coalesce(ui_state, '{}'::jsonb) || %s::jsonb
            WHERE id = %s""",
        (json.dumps(patch, ensure_ascii=False), user["id"]),
    )
    db.commit()
    return {"ok": True}
