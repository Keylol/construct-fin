#!/usr/bin/env bash
set -euo pipefail

# Starts temporary HTTPS tunnel to local Mini App web server.
# Priority: cloudflared -> ngrok.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_PORT="${LOCAL_PORT:-8081}"
LOCAL_CLOUDFLARED="$PROJECT_DIR/.setup/tools/bin/cloudflared"

if command -v cloudflared >/dev/null 2>&1; then
  echo "Starting cloudflared tunnel to http://127.0.0.1:${LOCAL_PORT}"
  exec cloudflared tunnel --url "http://127.0.0.1:${LOCAL_PORT}"
fi

if [ -x "$LOCAL_CLOUDFLARED" ]; then
  echo "Starting local cloudflared tunnel to http://127.0.0.1:${LOCAL_PORT}"
  exec "$LOCAL_CLOUDFLARED" tunnel --url "http://127.0.0.1:${LOCAL_PORT}"
fi

if command -v ngrok >/dev/null 2>&1; then
  echo "Starting ngrok tunnel to http://127.0.0.1:${LOCAL_PORT}"
  exec ngrok http "${LOCAL_PORT}"
fi

echo "No tunnel tool found."
echo "Install one:"
echo "  - cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
echo "  - ngrok: https://ngrok.com/download"
exit 1
