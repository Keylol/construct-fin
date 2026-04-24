#!/usr/bin/env bash
# Server-side git post-receive hook for /srv/construct/repo.git.
# Replaces the previous hook and adds dependency install + Alembic migrations.
#
# Install on the production server as:
#   cp deploy/ferrum/post-receive.sh /srv/construct/repo.git/hooks/post-receive
#   chmod +x /srv/construct/repo.git/hooks/post-receive

set -euo pipefail
# set -euo pipefail is intentional: any failed backup, preflight, or migration
# command aborts the deploy immediately. No silent failures in this hook.

APP_DIR=/srv/construct/app
REPO_DIR=/srv/construct/repo.git
VENV="$APP_DIR/.venv"

# Read refs from stdin so we can diff what changed.
OLD_REV=""
NEW_REV=""
while read -r old new ref; do
    if [[ "$ref" == "refs/heads/main" ]]; then
        OLD_REV="$old"
        NEW_REV="$new"
    fi
done

if [[ -z "$NEW_REV" ]]; then
    echo "=== [deploy] main not in push, skipping ==="
    exit 0
fi

echo "=== [deploy] Checking out $NEW_REV to $APP_DIR ==="
git --work-tree="$APP_DIR" --git-dir="$REPO_DIR" checkout -f main

echo "=== [deploy] Creating PostgreSQL backup before migrations ==="
if [[ -x "$APP_DIR/scripts/backup_postgres.sh" ]]; then
    cd "$APP_DIR"
    sudo -u construct -E "$APP_DIR/scripts/backup_postgres.sh"
else
    echo "Backup script missing or not executable: $APP_DIR/scripts/backup_postgres.sh"
    exit 1
fi

echo "=== [deploy] Running financial preflight before migrations ==="
if [[ -f "$APP_DIR/scripts/preflight_financial_release.py" ]]; then
    cd "$APP_DIR"
    sudo -u construct -E "$VENV/bin/python" scripts/preflight_financial_release.py
else
    echo "Preflight script missing: $APP_DIR/scripts/preflight_financial_release.py"
    exit 1
fi

# Detect what changed (if we have a previous rev).
CHANGED_FILES=""
if [[ "$OLD_REV" =~ ^0+$ || -z "$OLD_REV" ]]; then
    CHANGED_FILES="(first push, assume all changed)"
    DEPS_CHANGED=1
    MIGRATIONS_CHANGED=1
else
    CHANGED_FILES=$(git --git-dir="$REPO_DIR" diff --name-only "$OLD_REV" "$NEW_REV" || true)
    DEPS_CHANGED=0
    MIGRATIONS_CHANGED=0
    echo "$CHANGED_FILES" | grep -qE "^requirements.*\.txt$" && DEPS_CHANGED=1 || true
    echo "$CHANGED_FILES" | grep -qE "^miniapp_api/alembic/versions/" && MIGRATIONS_CHANGED=1 || true
fi

if [[ "$DEPS_CHANGED" == "1" ]]; then
    echo "=== [deploy] Installing Python dependencies ==="
    sudo -u construct "$VENV/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
    sudo -u construct "$VENV/bin/pip" install --quiet -r "$APP_DIR/miniapp_api/requirements.txt"
else
    echo "=== [deploy] requirements.txt unchanged, skipping pip install ==="
fi

if [[ "$MIGRATIONS_CHANGED" == "1" ]]; then
    echo "=== [deploy] Running Alembic migrations ==="
    cd "$APP_DIR"
    sudo -u construct -E "$VENV/bin/alembic" -c miniapp_api/alembic.ini upgrade head
else
    echo "=== [deploy] No new migrations, skipping alembic upgrade ==="
fi

echo "=== [deploy] Fixing permissions ==="
chown -R construct:construct "$APP_DIR"

echo "=== [deploy] Restarting services ==="
systemctl restart construct-bot construct-miniapp-api

sleep 3
echo "=== [deploy] Status ==="
systemctl is-active construct-bot construct-miniapp-api
curl -fsS http://127.0.0.1:8080/healthz

echo ""
echo "=== [deploy] Done ==="
