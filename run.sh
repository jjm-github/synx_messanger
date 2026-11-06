#!/usr/bin/env bash
# Запуск мессенджера. Ожидает активированный venv с requirements.txt.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi
exec uvicorn app.main:app \
    --host "${SYNX_MESSENGER_HOST:-0.0.0.0}" \
    --port "${SYNX_MESSENGER_PORT:-8020}" \
    "$@"
