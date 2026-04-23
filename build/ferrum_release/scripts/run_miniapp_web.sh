#!/usr/bin/env bash
set -euo pipefail

cd /Users/alexander/Documents/Construct
PATH="/Users/alexander/Documents/Construct/.nodeenv/bin:$PATH"
cd miniapp_web
if [ ! -d node_modules ]; then
  npm ci
fi
npm run build
npm run serve
