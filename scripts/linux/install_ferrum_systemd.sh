#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

sudo cp "$PROJECT_DIR/deploy/ferrum/systemd/construct-miniapp-api.service" "$SYSTEMD_DIR/"
sudo cp "$PROJECT_DIR/deploy/ferrum/systemd/construct-bot.service" "$SYSTEMD_DIR/"
sudo systemctl daemon-reload
sudo systemctl enable construct-miniapp-api.service
sudo systemctl enable construct-bot.service

echo "Installed systemd units:"
echo "  - construct-miniapp-api.service"
echo "  - construct-bot.service"
