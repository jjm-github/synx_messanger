import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    db_dsn: str
    session_hours: int
    cookie_secure: bool
    storage_path: str
    versions_root: str
    projects_root: str
    db_pool_min: int = 2
    db_pool_max: int = 20
    app_name: str = "synx messenger"
    session_cookie: str = "synx_session"
    audio_host: str = "127.0.0.1"
    audio_port: int = 8011
    audio_mix_rate: int = 16000
    dm_retention_days: int = 14


def get_settings() -> Settings:
    storage = os.getenv("SYNX_STORAGE_PATH", "/var/lib/synx_engine/files")
    return Settings(
        db_dsn=os.getenv(
            "SYNX_DB_DSN",
            "postgresql://synx:synx@127.0.0.1:5432/synx_engine",
        ),
        session_hours=int(os.getenv("SYNX_SESSION_HOURS", "12")),
        cookie_secure=os.getenv(
            "SYNX_COOKIE_SECURE", "false").lower() in {"1", "true", "yes"},
        storage_path=storage,
        versions_root=os.getenv("SYNX_VERSIONS_ROOT", storage),
        projects_root=os.getenv("SYNX_PROJECTS_ROOT", storage),
        db_pool_min=int(os.getenv("SYNX_DB_POOL_MIN", "2")),
        db_pool_max=int(os.getenv("SYNX_DB_POOL_MAX", "20")),
        audio_host=os.getenv("SYNX_AUDIO_HOST", "127.0.0.1"),
        audio_port=int(os.getenv("SYNX_AUDIO_PORT", "8011")),
        audio_mix_rate=int(os.getenv("SYNX_AUDIO_MIX_RATE", "16000")),
        dm_retention_days=int(os.getenv("SYNX_DM_RETENTION_DAYS", "14")),
    )
