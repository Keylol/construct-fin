#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN_DIR="${PG_BIN_DIR:-$PROJECT_DIR/.setup/tools/postgres/pgsql/bin}"
PG_DATA_DIR="${PG_DATA_DIR:-$PROJECT_DIR/.setup/postgres-data}"
PG_PORT="${PG_PORT:-5432}"
PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp}"
PG_LOG_FILE="${PG_LOG_FILE:-$PG_DATA_DIR/server.log}"

PGSUPERUSER="${PGSUPERUSER:-postgres}"
APP_DB="${APP_DB:-construct_miniapp}"
APP_USER="${APP_USER:-construct}"
APP_PASSWORD="${APP_PASSWORD:-construct_local_password}"

usage() {
  cat <<'EOF'
Usage:
  scripts/postgres_local.sh init
  scripts/postgres_local.sh start
  scripts/postgres_local.sh stop
  scripts/postgres_local.sh restart
  scripts/postgres_local.sh status
  scripts/postgres_local.sh setup-app
  scripts/postgres_local.sh bootstrap

Environment overrides:
  PG_BIN_DIR, PG_DATA_DIR, PG_PORT, PG_SOCKET_DIR, PG_LOG_FILE,
  PGSUPERUSER, APP_DB, APP_USER, APP_PASSWORD
EOF
}

require_bin() {
  local bin="$1"
  if [ ! -x "$PG_BIN_DIR/$bin" ]; then
    echo "Missing binary: $PG_BIN_DIR/$bin"
    echo "Install PostgreSQL binaries into .setup/tools/postgres first."
    exit 1
  fi
}

cmd_init() {
  require_bin initdb
  if [ -d "$PG_DATA_DIR/base" ]; then
    echo "PostgreSQL data dir already initialized: $PG_DATA_DIR"
    return 0
  fi
  mkdir -p "$PG_DATA_DIR"
  "$PG_BIN_DIR/initdb" \
    -D "$PG_DATA_DIR" \
    -U "$PGSUPERUSER" \
    --auth-local=trust \
    --auth-host=scram-sha-256
}

cmd_start() {
  require_bin pg_ctl
  mkdir -p "$(dirname "$PG_LOG_FILE")"
  "$PG_BIN_DIR/pg_ctl" \
    -D "$PG_DATA_DIR" \
    -l "$PG_LOG_FILE" \
    -o "-p $PG_PORT -k $PG_SOCKET_DIR -c listen_addresses=127.0.0.1" \
    start
}

cmd_stop() {
  require_bin pg_ctl
  "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA_DIR" stop
}

cmd_status() {
  require_bin pg_ctl
  "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA_DIR" status
}

cmd_setup_app() {
  require_bin psql
  PATH="$PG_BIN_DIR:$PATH" \
  PGHOST="$PG_SOCKET_DIR" \
  PGPORT="$PG_PORT" \
  PGSUPERUSER="$PGSUPERUSER" \
  APP_DB="$APP_DB" \
  APP_USER="$APP_USER" \
  APP_PASSWORD="$APP_PASSWORD" \
  "$PROJECT_DIR/scripts/setup_postgres_local.sh"
}

cmd_bootstrap() {
  cmd_init
  if ! cmd_status >/dev/null 2>&1; then
    cmd_start
  else
    echo "PostgreSQL already running."
  fi
  cmd_setup_app
  echo
  echo "Set this in .env:"
  echo "MINIAPP_DATABASE_URL=postgresql+asyncpg://${APP_USER}:${APP_PASSWORD}@127.0.0.1:${PG_PORT}/${APP_DB}"
}

case "${1:-}" in
  init)
    cmd_init
    ;;
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_stop || true
    cmd_start
    ;;
  status)
    cmd_status
    ;;
  setup-app)
    cmd_setup_app
    ;;
  bootstrap)
    cmd_bootstrap
    ;;
  *)
    usage
    exit 1
    ;;
esac
