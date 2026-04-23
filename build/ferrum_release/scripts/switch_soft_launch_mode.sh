#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

usage() {
  cat <<'EOF'
Usage:
  scripts/switch_soft_launch_mode.sh owner-only
  scripts/switch_soft_launch_mode.sh owner-plus-one <telegram_user_id>
  scripts/switch_soft_launch_mode.sh open

Modes:
  owner-only                  owner access only
  owner-plus-one <user_id>    owner + one allow-listed operator
  open                        disable soft-launch restriction
EOF
}

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE"
  exit 1
fi

set_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

mode="${1:-}"
case "$mode" in
  owner-only)
    set_var "MINIAPP_SOFT_LAUNCH_OWNER_ONLY" "1"
    set_var "MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS" ""
    ;;
  owner-plus-one)
    operator_id="${2:-}"
    if ! [[ "$operator_id" =~ ^[0-9]+$ ]]; then
      echo "Provide numeric Telegram user id."
      usage
      exit 1
    fi
    set_var "MINIAPP_SOFT_LAUNCH_OWNER_ONLY" "1"
    set_var "MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS" "$operator_id"
    ;;
  open)
    set_var "MINIAPP_SOFT_LAUNCH_OWNER_ONLY" "0"
    set_var "MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS" ""
    ;;
  *)
    usage
    exit 1
    ;;
esac

echo "Updated $ENV_FILE:"
grep -E '^MINIAPP_SOFT_LAUNCH_OWNER_ONLY=|^MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS=' "$ENV_FILE"
echo
echo "Restart API service to apply:"
echo "launchctl kickstart -k gui/$(id -u)/com.constructpc.miniapp.api"
