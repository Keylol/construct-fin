#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN_DIR="${PG_BIN_DIR:-$PROJECT_DIR/.setup/tools/postgres/pgsql/bin}"

PG_HOST="${PG_HOST:-/tmp}"
PG_PORT="${PG_PORT:-5432}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"

usage() {
  cat <<'EOF'
Usage:
  scripts/restore_postgres_backup.sh <backup.sql.gz> [target_db]

Defaults:
  target_db = construct_miniapp_restore_YYYYmmdd_HHMMSS

This script restores into a separate DB by default (safe mode),
so production DB is not overwritten.
EOF
}

backup_file="${1:-}"
if [ -z "$backup_file" ]; then
  usage
  exit 1
fi

if [ ! -f "$backup_file" ]; then
  echo "Backup file not found: $backup_file"
  exit 1
fi

if [ ! -x "$PG_BIN_DIR/psql" ] || [ ! -x "$PG_BIN_DIR/createdb" ]; then
  echo "PostgreSQL client tools are missing in: $PG_BIN_DIR"
  exit 1
fi

target_db="${2:-construct_miniapp_restore_$(date '+%Y%m%d_%H%M%S')}"

if ! "$PG_BIN_DIR/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" -tAc "SELECT 1 FROM pg_database WHERE datname='${target_db}'" postgres | grep -q 1; then
  "$PG_BIN_DIR/createdb" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" "$target_db"
fi

echo "Restoring $backup_file -> database $target_db ..."
gzip -dc "$backup_file" | "$PG_BIN_DIR/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" -d "$target_db" >/dev/null

echo "Restore completed."
echo "Target DB: $target_db"
