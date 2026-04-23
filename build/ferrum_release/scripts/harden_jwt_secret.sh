#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE"
  exit 1
fi

if command -v openssl >/dev/null 2>&1; then
  NEW_SECRET="$(openssl rand -hex 48)"
else
  NEW_SECRET="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64)"
fi

if grep -q '^JWT_SECRET=' "$ENV_FILE"; then
  sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=${NEW_SECRET}|" "$ENV_FILE"
else
  printf '\nJWT_SECRET=%s\n' "$NEW_SECRET" >> "$ENV_FILE"
fi

echo "JWT_SECRET updated in $ENV_FILE (length: ${#NEW_SECRET})."
echo "Restart Mini App API to apply:"
echo "launchctl kickstart -k gui/$(id -u)/com.constructpc.miniapp.api"
