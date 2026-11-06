"""Небольшая консольная утилита для отдельной установки мессенджера.

    python -m app.manage init-db
    python -m app.manage create-user v.dolgih "Василий Долгих" пароль
    python -m app.manage create-user a.admin "Админ Админов" пароль --admin
    python -m app.manage set-password v.dolgih новый-пароль
"""
from __future__ import annotations

import argparse
import sys

from .db import close_pool, db_conn, init_pool
from .schema import ensure_schema
from .security import hash_password


def cmd_init_db(_args) -> int:
    init_pool()
    try:
        ensure_schema()
    finally:
        close_pool()
    print("schema ok")
    return 0


def cmd_create_user(args) -> int:
    init_pool()
    try:
        ensure_schema()
        with db_conn() as db:
            exists = db.execute(
                "SELECT 1 FROM users WHERE short_name=%s",
                (args.short_name.lower(),),
            ).fetchone()
            if exists:
                print("user already exists", file=sys.stderr)
                return 1
            db.execute(
                """INSERT INTO users
                       (short_name, full_name, password_hash,
                        permission_group, active)
                   VALUES (%s,%s,%s,%s,true)""",
                (
                    args.short_name.lower(),
                    args.full_name,
                    hash_password(args.password),
                    "admin" if args.admin else "artist",
                ),
            )
            db.commit()
    finally:
        close_pool()
    print("user created:", args.short_name.lower())
    return 0


def cmd_set_password(args) -> int:
    init_pool()
    try:
        with db_conn() as db:
            row = db.execute(
                "SELECT id FROM users WHERE short_name=%s",
                (args.short_name.lower(),),
            ).fetchone()
            if not row:
                print("user not found", file=sys.stderr)
                return 1
            db.execute(
                "UPDATE users SET password_hash=%s, updated_at=now() "
                "WHERE id=%s",
                (hash_password(args.password), row["id"]),
            )
            db.commit()
    finally:
        close_pool()
    print("password updated:", args.short_name.lower())
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="synx-messenger")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init-db", help="создать минимальную схему")
    p.set_defaults(func=cmd_init_db)

    p = sub.add_parser("create-user", help="создать пользователя")
    p.add_argument("short_name")
    p.add_argument("full_name")
    p.add_argument("password")
    p.add_argument("--admin", action="store_true")
    p.set_defaults(func=cmd_create_user)

    p = sub.add_parser("set-password", help="сменить пароль")
    p.add_argument("short_name")
    p.add_argument("password")
    p.set_defaults(func=cmd_set_password)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
