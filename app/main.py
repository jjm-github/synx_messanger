from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .audio_mixer import start_audio_mixer
from .db import close_pool, init_pool
from .direct_messages import start_cleanup_worker
from .routers import (
    api_audio,
    api_direct,
    api_presence,
    api_ui_state,
    files,
    web,
)
from .schema import ensure_schema


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    ensure_schema()
    api_audio.ensure_audio_schema()
    start_cleanup_worker()
    start_audio_mixer()
    try:
        yield
    finally:
        close_pool()


app = FastAPI(title="synx messenger", version="0.1.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)


@app.middleware("http")
async def no_cache_html(request, call_next):
    response = await call_next(request)
    content_type = response.headers.get("content-type", "")
    if content_type.startswith("text/html"):
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


app.include_router(web.router)
app.include_router(api_audio.router)
app.include_router(api_direct.router)
app.include_router(api_presence.router)
app.include_router(api_ui_state.router)
app.include_router(files.router)

STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
