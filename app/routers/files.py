"""Выдача файлов: аватары, вложения личных сообщений."""
import os
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from ..config import get_settings
from ..db import db_conn
from ..deps import require_user_short
from ..ids import is_id

router = APIRouter(prefix="/files", tags=["files"])


def _roots() -> set[str]:
    settings = get_settings()
    return {
        str(Path(settings.storage_path).resolve()),
        str(Path(settings.versions_root).resolve()),
        str(Path(settings.projects_root).resolve()),
    }


def _file_response(row, request=None, user=None) -> FileResponse:
    file_path = Path(row["storage_path"]).resolve()
    if not any(str(file_path).startswith(root) for root in _roots()):
        raise HTTPException(403, "Access denied")
    if not file_path.exists():
        raise HTTPException(404, "File does not exist on disk")
    return FileResponse(
        path=str(file_path),
        filename=row["original_name"],
        media_type=row.get("mime_type") or "application/octet-stream",
        content_disposition_type="inline",
        headers={
            "cache-control": "private, max-age=31536000, immutable",
        },
    )


@router.get("/{file_id}")
def get_file(file_id: str, request: Request,
             user=Depends(require_user_short)):
    if not is_id(file_id):
        raise HTTPException(404, "File not found")
    with db_conn() as db:
        row = db.execute(
            "SELECT * FROM file_objects WHERE id = %s", (file_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    return _file_response(row, request=request, user=user)


def _avatar_thumb_path(photo_id: str, row) -> Path:
    settings = get_settings()
    src = Path(row["storage_path"]).resolve()
    if not any(str(src).startswith(root) for root in _roots()):
        raise HTTPException(403, "Access denied")
    if not src.exists():
        raise HTTPException(404, "Photo file not found")
    version = (row.get("sha256") or "")[:16]
    if not version:
        try:
            version = str(src.stat().st_mtime_ns)
        except OSError:
            version = "0"
    out_dir = Path(settings.storage_path) / "_avatar_thumbs"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{photo_id}_{version}.jpg"
    if out.exists() and out.stat().st_size > 0:
        try:
            with out.open("rb") as fh:
                if fh.read(2) == b"\xff\xd8":
                    return out
        except OSError:
            pass
        try:
            out.unlink()
        except OSError:
            pass
    tmp = out.with_name(out.name + ".tmp.jpg")
    convert = shutil.which("convert") or shutil.which("magick")
    ffmpeg = shutil.which("ffmpeg")
    try:
        if convert:
            cmd = [convert, str(src), "-auto-orient",
                   "-thumbnail", "96x96^", "-gravity", "center",
                   "-extent", "96x96", "-strip", "-quality", "82",
                   str(tmp)]
        elif ffmpeg:
            cmd = [ffmpeg, "-y", "-i", str(src),
                   "-vf", "scale=96:96:force_original_aspect_ratio=increase,"
                          "crop=96:96",
                   "-frames:v", "1", "-q:v", "4", str(tmp)]
        else:
            raise HTTPException(503, "Image thumbnailer is not available")
        subprocess.run(cmd, check=True, timeout=20,
                       stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        os.replace(tmp, out)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(404, "Photo thumbnail failed")
    return out


@router.get("/{photo_id}/avatar")
def avatar_thumb(photo_id: str, user=Depends(require_user_short)):
    if not is_id(photo_id):
        raise HTTPException(404, "File not found")
    with db_conn() as db:
        row = db.execute(
            "SELECT * FROM file_objects WHERE id=%s", (photo_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    path = _avatar_thumb_path(photo_id, row)
    return FileResponse(
        str(path), media_type="image/jpeg",
        headers={
            "cache-control": "private, max-age=31536000, immutable",
        },
    )
