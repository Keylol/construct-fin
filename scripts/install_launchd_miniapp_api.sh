#!/usr/bin/env bash
set -euo pipefail

LABEL="com.constructpc.miniapp.api"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/data"
cp "$PLIST_SRC" "$PLIST_DST"

launchctl bootout "$GUI_DOMAIN" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootstrap "$GUI_DOMAIN" "$PLIST_DST"
launchctl enable "$GUI_DOMAIN/$LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"

echo "Installed and started: $LABEL"
echo "Plist: $PLIST_DST"
echo "Status:"
launchctl print "$GUI_DOMAIN/$LABEL" | sed -n '1,120p'
