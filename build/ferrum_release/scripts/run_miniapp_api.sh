#!/usr/bin/env bash
set -euo pipefail

cd /Users/alexander/Documents/Construct
source .venv/bin/activate

if [ "${MINIAPP_APPLY_MIGRATIONS:-1}" = "1" ]; then
  PREPARE_ACTION="$(./.venv/bin/python scripts/prepare_miniapp_db.py)"
  if [[ "$PREPARE_ACTION" == STAMP_* ]]; then
    STAMP_REVISION="${PREPARE_ACTION#STAMP_}"
    alembic -c miniapp_api/alembic.ini stamp "$STAMP_REVISION"
  fi
  alembic -c miniapp_api/alembic.ini upgrade head
fi

UVICORN_ARGS=(
  "miniapp_api.app.main:app"
  "--host" "${MINIAPP_API_HOST:-0.0.0.0}"
  "--port" "${MINIAPP_API_PORT:-8080}"
)

if [ "${MINIAPP_RELOAD:-0}" = "1" ]; then
  UVICORN_ARGS+=("--reload")
fi

exec uvicorn "${UVICORN_ARGS[@]}"
