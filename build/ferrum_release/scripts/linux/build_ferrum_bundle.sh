#!/usr/bin/env bash
set -euo pipefail

export COPYFILE_DISABLE=1

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build"
STAGING_DIR="$BUILD_DIR/ferrum_release"
ARCHIVE_PATH="$BUILD_DIR/construct_ferrum_release.tar.gz"
NODE_BIN_DIR="$PROJECT_DIR/.nodeenv/bin"
NODE_BIN="$NODE_BIN_DIR/node"
NPM_CLI="$PROJECT_DIR/.nodeenv/lib/node_modules/npm/bin/npm-cli.js"

mkdir -p "$BUILD_DIR"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

echo "[ferrum-bundle] building frontend"
(
  cd "$PROJECT_DIR/miniapp_web"
  PATH="$NODE_BIN_DIR:$PATH" "$NODE_BIN" "$NPM_CLI" run build
)

echo "[ferrum-bundle] copying project files"
mkdir -p "$STAGING_DIR/miniapp_web"
cp -R "$PROJECT_DIR/bot" "$STAGING_DIR/"
cp -R "$PROJECT_DIR/miniapp_api" "$STAGING_DIR/"
cp -R "$PROJECT_DIR/miniapp_web/dist" "$STAGING_DIR/miniapp_web/"
cp -R "$PROJECT_DIR/scripts" "$STAGING_DIR/"
cp -R "$PROJECT_DIR/deploy" "$STAGING_DIR/"
cp "$PROJECT_DIR/config.py" "$STAGING_DIR/"
cp "$PROJECT_DIR/requirements.txt" "$STAGING_DIR/"
cp "$PROJECT_DIR/requirements-dev.txt" "$STAGING_DIR/"
cp "$PROJECT_DIR/.env.example" "$STAGING_DIR/"
cp "$PROJECT_DIR/README.md" "$STAGING_DIR/"

find "$STAGING_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$STAGING_DIR" -name '.DS_Store' -type f -delete
find "$STAGING_DIR" -name '._*' -type f -delete

echo "[ferrum-bundle] creating archive"
tar -C "$STAGING_DIR" -czf "$ARCHIVE_PATH" .

echo "[ferrum-bundle] ready: $ARCHIVE_PATH"
