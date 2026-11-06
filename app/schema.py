"""Минимальная схема мессенджера.

Приложение рассчитано на работу с базой synx engine: таблицы users,
file_objects, auth_sessions и остальные уже существуют. Все операторы
ниже — IF NOT EXISTS, поэтому запуск на существующей базе ничего не
меняет. На пустой базе создаётся ровно тот минимум, который нужен
списку пользователей, личным сообщениям и аудио-комнатам.
"""
from __future__ import annotations

from .db import db_conn

_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN
    CREATE TYPE permission_group AS ENUM
        ('admin', 'supervizor', 'coordinator', 'artist', 'producer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS file_objects (
    id text PRIMARY KEY DEFAULT encode(gen_random_bytes(8), 'hex'),
    kind text NOT NULL CHECK (kind IN (
        'photo', 'avatar', 'thumbnail', 'version', 'attachment', 'publication'
    )),
    original_name text NOT NULL,
    storage_path text NOT NULL UNIQUE,
    mime_type text,
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    sha256 text,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY DEFAULT encode(gen_random_bytes(8), 'hex'),
    full_name text NOT NULL,
    short_name citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    permission_group permission_group NOT NULL DEFAULT 'artist',
    date_registred timestamptz NOT NULL DEFAULT now(),
    phone text,
    e_mail citext UNIQUE,
    photo_id text REFERENCES file_objects(id) ON DELETE SET NULL,
    birth_date date,
    rate_monthly numeric(14, 2),
    bot boolean NOT NULL DEFAULT false,
    ui_state jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_state jsonb;

CREATE TABLE IF NOT EXISTS auth_sessions (
    id text PRIMARY KEY DEFAULT encode(gen_random_bytes(8), 'hex'),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    ip inet,
    user_agent text,
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS ix_auth_sessions_user_id
    ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
    short_name text NOT NULL,
    ip text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    blocked_until timestamptz,
    last_attempt timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (short_name, ip)
);
CREATE INDEX IF NOT EXISTS ix_login_attempts_blocked
    ON login_attempts(blocked_until);

CREATE TABLE IF NOT EXISTS user_presence (
    session_id text PRIMARY KEY
        REFERENCES auth_sessions(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page text,
    title text,
    activity text,
    ip text,
    user_agent text,
    visible boolean NOT NULL DEFAULT true,
    last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_user_presence_seen
    ON user_presence(last_seen DESC);

CREATE TABLE IF NOT EXISTS direct_messages (
    id text PRIMARY KEY DEFAULT encode(gen_random_bytes(8), 'hex'),
    sender_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz,
    read_at timestamptz,
    CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS ix_direct_messages_pair
    ON direct_messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS ix_direct_messages_recipient_unread
    ON direct_messages(recipient_id, read_at) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS direct_message_attachments (
    message_id text NOT NULL
        REFERENCES direct_messages(id) ON DELETE CASCADE,
    file_id text NOT NULL REFERENCES file_objects(id) ON DELETE RESTRICT,
    PRIMARY KEY (message_id, file_id)
);

CREATE TABLE IF NOT EXISTS audio_room_peers (
    broadcaster_id text NOT NULL,
    peer_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL DEFAULT '',
    host boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (broadcaster_id, peer_id)
);
CREATE INDEX IF NOT EXISTS ix_audio_room_peers_bid
    ON audio_room_peers(broadcaster_id, updated_at);

CREATE TABLE IF NOT EXISTS audio_signals (
    id bigserial PRIMARY KEY,
    broadcaster_id text NOT NULL,
    from_peer text NOT NULL,
    to_peer text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audio_signals_target
    ON audio_signals(broadcaster_id, to_peer, id);
CREATE INDEX IF NOT EXISTS ix_audio_signals_created
    ON audio_signals(created_at);

CREATE TABLE IF NOT EXISTS audio_rooms (
    id text PRIMARY KEY,
    name text NOT NULL,
    creator_id text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audio_rooms
    ADD COLUMN IF NOT EXISTS audio boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS audio_room_invites (
    room_id text NOT NULL REFERENCES audio_rooms(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
"""


def ensure_schema() -> None:
    with db_conn() as db:
        db.execute("SELECT pg_advisory_xact_lock(918273646)")
        db.execute(_SCHEMA)
        db.commit()
