#!/usr/bin/env bash
# Runs via cron every 5 minutes. Sends Telegram alert on first failure,
# then stays silent until service recovers.
set -euo pipefail

HEALTHZ_URL="http://127.0.0.1:8080/healthz"
STATE_FILE="/tmp/construct_healthcheck_state"

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
OWNER_IDS="${OWNER_USER_IDS:-}"

send_telegram() {
  local text="$1"
  if [[ -z "$BOT_TOKEN" || -z "$OWNER_IDS" ]]; then
    return
  fi
  IFS=',' read -ra IDS <<< "$OWNER_IDS"
  for chat_id in "${IDS[@]}"; do
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d "chat_id=${chat_id}" \
      -d "text=${text}" \
      -d "parse_mode=HTML" > /dev/null 2>&1 || true
  done
}

http_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTHZ_URL" 2>/dev/null || echo "000")

if [[ "$http_status" == "200" ]]; then
  if [[ -f "$STATE_FILE" ]]; then
    rm -f "$STATE_FILE"
    send_telegram "✅ <b>ConstructPC</b> — сервис восстановлен (API отвечает)"
  fi
else
  if [[ ! -f "$STATE_FILE" ]]; then
    touch "$STATE_FILE"
    send_telegram "🚨 <b>ConstructPC</b> — сервис недоступен!%0AHealthcheck вернул: ${http_status}%0AПроверьте: systemctl status construct-miniapp-api"
  fi
fi
