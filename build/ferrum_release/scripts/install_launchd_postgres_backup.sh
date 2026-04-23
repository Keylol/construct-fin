#!/usr/bin/env bash
set -euo pipefail

LABEL="com.constructpc.postgres.backup"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

if [ ! -x "$PROJECT_DIR/.venv/bin/python" ]; then
  echo "Python not found: $PROJECT_DIR/.venv/bin/python"
  exit 1
fi

if [ ! -f "$PROJECT_DIR/scripts/backup_postgres.py" ]; then
  echo "Backup runner missing: $PROJECT_DIR/scripts/backup_postgres.py"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/data"
cp "$PLIST_SRC" "$PLIST_DST"

launchctl bootout "$GUI_DOMAIN" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootstrap "$GUI_DOMAIN" "$PLIST_DST"
launchctl enable "$GUI_DOMAIN/$LABEL"

echo "Installed schedule: $LABEL"
echo "Plist: $PLIST_DST"
echo "Status:"
launchctl print "$GUI_DOMAIN/$LABEL" | sed -n '1,120p'
echo
echo "Run backup now (manual):"
echo "launchctl kickstart -k $GUI_DOMAIN/$LABEL"
