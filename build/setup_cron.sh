#!/usr/bin/env bash
chmod +x /usr/local/bin/construct-healthcheck.sh
CRON_LINE='*/5 * * * * . /srv/construct/app/.env 2>/dev/null; /usr/local/bin/construct-healthcheck.sh >> /var/log/construct-healthcheck.log 2>&1'
(crontab -l 2>/dev/null | grep -v healthcheck; echo "$CRON_LINE") | crontab -
echo "=== CRON INSTALLED ==="
crontab -l
