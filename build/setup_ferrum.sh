#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/srv/construct/app
APP_USER=construct
DB_NAME=construct_miniapp
DB_USER=construct
DB_PASS=construct_prod_password

echo "=== [1/7] Installing system packages ==="
apt-get update -qq
apt-get install -y -qq \
    python3.12 python3.12-venv python3-pip \
    postgresql postgresql-client \
    nginx \
    curl git

echo "=== [2/7] Creating system user ==="
id $APP_USER &>/dev/null || useradd -r -m -s /bin/bash $APP_USER

echo "=== [3/7] Setting up PostgreSQL ==="
systemctl enable postgresql
systemctl start postgresql
# Create DB user and database
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || sudo -u postgres createdb -O $DB_USER $DB_NAME

echo "=== [4/7] Deploying application ==="
mkdir -p $APP_DIR
tar -xzf /root/construct_ferrum_release.tar.gz -C $APP_DIR
mkdir -p $APP_DIR/data/documents $APP_DIR/data/miniapp_documents
cp /root/env.production $APP_DIR/.env
cp /root/credentials.json $APP_DIR/data/credentials.json
chown -R $APP_USER:$APP_USER $APP_DIR

echo "=== [5/7] Creating Python virtualenv ==="
sudo -u $APP_USER python3.12 -m venv $APP_DIR/.venv
sudo -u $APP_USER $APP_DIR/.venv/bin/pip install --quiet --upgrade pip
sudo -u $APP_USER $APP_DIR/.venv/bin/pip install --quiet -r $APP_DIR/requirements.txt
sudo -u $APP_USER $APP_DIR/.venv/bin/pip install --quiet -r $APP_DIR/miniapp_api/requirements.txt

echo "=== [6/7] Installing systemd services ==="
cp $APP_DIR/deploy/ferrum/systemd/construct-miniapp-api.service /etc/systemd/system/
cp $APP_DIR/deploy/ferrum/systemd/construct-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable construct-miniapp-api construct-bot

echo "=== [7/7] Configuring nginx ==="
cp $APP_DIR/deploy/ferrum/nginx/app.pckonstruct.com.conf /etc/nginx/sites-available/construct.conf
ln -sf /etc/nginx/sites-available/construct.conf /etc/nginx/sites-enabled/construct.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "=== Setup complete ==="
