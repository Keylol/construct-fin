#!/usr/bin/env bash
set -euo pipefail

APP_DB="${APP_DB:-construct_miniapp}"
APP_USER="${APP_USER:-construct}"
APP_PASSWORD="${APP_PASSWORD:-}"

if [ -z "$APP_PASSWORD" ]; then
  echo "APP_PASSWORD is required"
  exit 1
fi

sudo -u postgres psql postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_USER}') THEN
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}';
  ELSE
    ALTER ROLE ${APP_USER} WITH LOGIN PASSWORD '${APP_PASSWORD}';
  END IF;
END
\$\$;
SQL

sudo -u postgres psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${APP_DB}'" | grep -q 1 || \
  sudo -u postgres createdb -O "${APP_USER}" "${APP_DB}"

echo "PostgreSQL ready:"
echo "  DB:   ${APP_DB}"
echo "  USER: ${APP_USER}"
