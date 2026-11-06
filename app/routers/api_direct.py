"""Личные сообщения между пользователями."""
from fastapi import APIRouter, Body, Depends, File, Form, UploadFile

from ..db import get_db
from ..deps import require_user
from ..direct_messages import edit_message, feed, send, unread

router = APIRouter(tags=["direct"])


@router.get("/api/direct/unread")
def direct_unread(db=Depends(get_db), user=Depends(require_user)):
    return unread(db, user["id"])


@router.get("/api/direct/{other_id}/messages")
def direct_messages(other_id: str, db=Depends(get_db),
                    user=Depends(require_user)):
    data = feed(db, user["id"], other_id)
    db.commit()
    return data


@router.patch("/api/direct/messages/{message_id}")
def direct_edit(message_id: str, payload: dict = Body(...),
                db=Depends(get_db), user=Depends(require_user)):
    data = edit_message(db, message_id, user["id"], payload.get("body", ""))
    db.commit()
    return data


@router.post("/api/direct/{other_id}/messages", status_code=201)
def direct_send(other_id: str, body: str = Form(""),
                files: list[UploadFile] | None = File(None),
                db=Depends(get_db), user=Depends(require_user)):
    data = send(db, user["id"], other_id, body, files or [])
    db.commit()
    return data
