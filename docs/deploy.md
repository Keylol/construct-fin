# Construct v6 — deploy

## Production топология

```
constructfin.aleksandrantropov.ru → VPS 195.133.1.13 (RUVDS, Королёв) → nginx :443
                                      ├ /api/v1/* → 127.0.0.1:4000 (api контейнер)
                                      └ /         → 127.0.0.1:3000 (web контейнер)
                                    docker compose stack at /srv/construct-v6:
                                      ├ postgres:16-alpine (volume pgdata)
                                      ├ api (ghcr.io/keylol/construct-v6-api:latest)
                                      └ web (ghcr.io/keylol/construct-v6-web:latest)
```

## Адрес прода

Единственный адрес — `constructfin.aleksandrantropov.ru`: A-запись reg.ru прямо на `195.133.1.13`, без Cloudflare. Сертификат Let's Encrypt `/etc/letsencrypt/live/constructfin.aleksandrantropov.ru/` (до 14.12.2026), конфиг `deploy/nginx/constructfin.conf`, продление общим `certbot.timer` с `renew_hook = systemctl reload nginx`.

**Почему съехали с `miniapp.aleksandrantropov.online`.** Домен стоял за Cloudflare, а часть провайдеров РФ режет её диапазоны — симптом «с VPN заходит, без VPN нет». 19.09.2026 старый адрес снят целиком: nginx-конфиг удалён, `PUBLIC_ORIGIN` и Telegram Mini App переведены на новый адрес, DNS-запись удалена владельцем.

### Как снимался старый адрес (для истории и для повторения на другом домене)

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 '
  cd /srv/construct-v6 &&
  cp .env.production .env.production.bak-$(date +%F) &&
  sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://constructfin.aleksandrantropov.ru|" .env.production &&
  docker compose up -d --no-deps web api &&
  rm -f /etc/nginx/sites-enabled/construct-v6.conf &&
  nginx -t && systemctl reload nginx'
```

Затем — Mini App на новый адрес (бот берёт токен из `.env.production`):

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 '
  cd /srv/construct-v6 &&
  TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" .env.production | cut -d= -f2-) &&
  curl -s -X POST "https://api.telegram.org/bot$TOKEN/setChatMenuButton" \
    -H "Content-Type: application/json" \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Construct\",\"web_app\":{\"url\":\"https://constructfin.aleksandrantropov.ru\"}}}"'
```

Руками у владельца остаётся: в BotFather `/setdomain` на новый адрес (Login Widget), удаление DNS-записи `miniapp` и смена URL в мониторинге. Сертификат старого домена можно оставить до истечения или снять `certbot delete --cert-name miniapp.aleksandrantropov.online`.

Кука `construct_jwt` привязана к хосту: после переезда нужно войти заново.

## Деплой

**Автоматический (рекомендуется):** push в ветку `v6` → GitHub Actions `.github/workflows/deploy.yml` собирает образы в GHCR, пуллит на VPS, рестартит compose, прогоняет миграции. Цикл ~5 минут.

**Ручной с локали:**

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 'cd /srv/construct-v6 && docker compose pull && docker compose up -d'
```

**Если CI упал и нужно собрать прямо на VPS:**

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 'cd /srv/construct-v6/src && git fetch origin && git reset --hard origin/v6 && docker build -f deploy/api.Dockerfile -t ghcr.io/keylol/construct-v6-api:latest . && docker build -f deploy/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=/api/v1 -t ghcr.io/keylol/construct-v6-web:latest . && cd /srv/construct-v6 && docker compose up -d'
```

## Миграции БД

CI прогоняет `prisma migrate deploy` автоматически после `up -d`. Ручной запуск:

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 \
  'cd /srv/construct-v6 && docker compose exec -T api sh -c "cd /app/node_modules/@construct/db && npx prisma migrate deploy"'
```

## Логи и отладка

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 'cd /srv/construct-v6 && docker compose logs api -f --tail=100'
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 'cd /srv/construct-v6 && docker compose logs web -f --tail=100'
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 'docker exec construct-v6-postgres-1 psql -U construct -d construct_v6 -c "SELECT count(*) FROM \"Workspace\";"'
```

## Известные грабли

- **VPS — QEMU virtual CPU v1 baseline.** Нет SSE4/AVX/POPCNT. `pdf-parse@2` (использует pdfjs-dist 4.x) падает с SIGILL — поэтому в [apps/api/package.json](../apps/api/package.json) зафиксирован `pdf-parse@1.1.1`. При апгрейде до v2 проверять что VPS заменили.
- **`pnpm deploy` кладёт содержимое api напрямую в `/app`**, а не `/app/apps/api`. CMD в [deploy/api.Dockerfile](../deploy/api.Dockerfile) — `node dist/main.js`, не `node apps/api/dist/main.js`.
- **VPS 961 МБ RAM + 2 ГБ swap.** Билд Next.js на VPS впритык — CI на GitHub runners делает его быстрее и без OOM-рисков.
- **15 ГБ диск.** `docker system prune -af` перед каждым релизом не нужен — CI делает `docker image prune -f` для висящих слоёв.
- **Правки `deploy/nginx/*.conf` не деплоятся автоматически** (в отличие от compose) — `/etc/nginx/sites-available/` на VPS раскладывается вручную: `scp` нужного файла → `nginx -t` → `systemctl reload nginx`. Правь оба файла (`construct-v6.conf`, `constructfin.conf`) синхронно с VPS, иначе репо и прод расходятся.

## Секреты репозитория (Settings → Secrets and variables → Actions)

| Имя | Что |
|---|---|
| `VPS_SSH_KEY` | Приватный SSH-ключ `deploy_ferrum` для root@195.133.1.13 |

GHCR работает через `secrets.GITHUB_TOKEN` (auto), отдельный PAT не нужен.

## Откат

Все теги остаются: `latest` (последний) + `<short-sha>`. Откат на предыдущий релиз:

```bash
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 \
  'cd /srv/construct-v6 && \
   docker compose pull && \
   API_IMAGE=ghcr.io/keylol/construct-v6-api:<sha> \
   WEB_IMAGE=ghcr.io/keylol/construct-v6-web:<sha> \
   docker compose up -d'
```

Миграции v6 в большинстве случаев необратимы — откат БД отдельной задачей через `prisma migrate resolve`.

## Бэкап uploads и внешний мониторинг (12.09.2026)

- **uploads** (чеки, вложения) — сервис `uploads-backup` в compose: раз в
  сутки (04:17) `tar.gz` в том `backups` (`/backups/uploads/uploads-<дата>.tar.gz`),
  ротация `UPLOADS_BACKUP_KEEP_DAYS` (по умолчанию 14). Деплой снимает снимок
  и перед миграцией (не блокирующий). Достать вместе с дампами:
  `docker cp construct-v6-uploads-backup-1:/backups <local>`. Восстановить:
  `docker run --rm -v construct-v6_uploads:/data/uploads -v construct-v6_backups:/backups alpine tar -xzf /backups/uploads/uploads-<дата>.tar.gz -C /data`.
  Off-site копии по-прежнему нет — оба тома на том же диске VPS.
- **Внешний мониторинг** — `.github/workflows/uptime.yml`: раз в 15 минут
  GitHub дёргает `/api/v1/health`; при падении одно сообщение в Telegram
  владельцу, при восстановлении — второе. Провал деплоя тоже пишет в Telegram.
  Нужны секрет `TELEGRAM_BOT_TOKEN` и переменная репо `ALERT_TELEGRAM_CHAT_ID`;
  проверка канала — ручной запуск workflow с галкой «test».
