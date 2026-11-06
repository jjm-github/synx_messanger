from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

_pool: ConnectionPool | None = None


def init_pool() -> None:
    global _pool
    settings = get_settings()
    pool_min = max(1, int(settings.db_pool_min))
    pool_max = max(pool_min, int(settings.db_pool_max))
    _pool = ConnectionPool(
        settings.db_dsn,
        min_size=pool_min,
        max_size=pool_max,
        kwargs={"row_factory": dict_row},
    )


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def db_conn():
    """Соединение на время запроса к БД, не на время отдачи файла."""
    if _pool is None:
        raise RuntimeError("DB pool is not initialized")
    with _pool.connection() as conn:
        yield conn


def get_db():
    with db_conn() as conn:
        yield conn
