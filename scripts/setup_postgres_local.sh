#!/usr/bin/env bash
set -euo pipefail

# Bootstrap local PostgreSQL role/database for Mini App.
# Requires working local postgres + psql client.

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGSUPERUSER="${PGSUPERUSER:-postgres}"
APP_DB="${APP_DB:-construct_miniapp}"
APP_USER="${APP_USER:-construct}"
APP_PASSWORD="${APP_PASSWORD:-construct_local_password}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install PostgreSQL locally first, then rerun."
  exit 1
fi

echo "Using server ${PGHOST}:${PGPORT}, superuser=${PGSUPERUSER}"

export PGPASSWORD="${PGPASSWORD:-}"

psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${APP_DB}'" | grep -q 1; then
  createdb -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" -O "$APP_USER" "$APP_DB"
fi

psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" postgres <<SQL
GRANT ALL PRIVILEGES ON DATABASE ${APP_DB} TO ${APP_USER};
SQL

echo
echo "Done."
echo "Use this in .env:"
echo "MINIAPP_DATABASE_URL=postgresql+asyncpg://${APP_USER}:${APP_PASSWORD}@${PGHOST}:${PGPORT}/${APP_DB}"
