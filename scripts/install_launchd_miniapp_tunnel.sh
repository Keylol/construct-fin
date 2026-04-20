#!/usr/bin/env bash
set -euo pipefail

LABEL="com.constructpc.miniapp.tunnel"
PLIST_SRC="/Users/alexander/Documents/Construct/scripts/launchd/${LABEL}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"

launchctl bootout "$GUI_DOMAIN" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootstrap "$GUI_DOMAIN" "$PLIST_DST"
launchctl enable "$GUI_DOMAIN/$LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"

echo "Installed $LABEL"
launchctl print "$GUI_DOMAIN/$LABEL" | sed -n '1,120p'
