#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$PROJECT_DIR/.venv/bin/python}"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Python not found: $PYTHON_BIN"
  exit 1
fi

exec "$PYTHON_BIN" "$PROJECT_DIR/scripts/backup_postgres.py"
