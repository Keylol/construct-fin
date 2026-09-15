# Construct v6 — deploy

## Production топология

```
miniapp.aleksandrantropov.online      ⇘
                                        VPS 195.133.1.13 (RUVDS, Королёв) → nginx :443
constructfin.aleksandrantropov.ru     ⇗   ├ /api/v1/* → 127.0.0.1:4000 (api контейнер)
                                           └ /         → 127.0.0.1:3000 (web контейнер)
                                         docker compose stack at /srv/construct-v6:
                                           ├ postgres:16-alpine (volume pgdata)
                                           ├ api (ghcr.io/keylol/construct-v6-api:latest)
                                           └ web (ghcr.io/keylol/construct-v6-web:latest)
```

Оба адреса ведут на один и тот же стек контейнеров — разные `server_name` в nginx, разные сертификаты, разные DNS. Один деплой обновляет оба.

## Два адреса

С 15.09.2026 у прода два входа, оба поддерживаются:

| Адрес | DNS / защита | Сертификат | Файл nginx |
|---|---|---|---|
| `miniapp.aleksandrantropov.online` | Cloudflare (проксирован) | `/etc/letsencrypt/live/miniapp.aleksandrantropov.online/`, до 04.11.2026 | `deploy/nginx/construct-v6.conf` |
| `constructfin.aleksandrantropov.ru` | reg.ru NS, без прокси — A-запись прямо на `195.133.1.13` | `/etc/letsencrypt/live/constructfin.aleksandrantropov.ru/`, до 14.12.2026 | `deploy/nginx/constructfin.conf` |

**Зачем второй.** Часть провайдеров РФ режет диапазоны Cloudflare — симптом «с VPN заходит, без VPN нет» на некоторых устройствах/сетях. `constructfin` идёт напрямую на российский сервер в обход Cloudflare и служит запасным входом для таких случаев. `miniapp` остаётся основным (защита и кэш Cloudflare для всех, кого не блокируют).

**Оба сертификата — Let's Encrypt через certbot** (`authenticator=nginx` для miniapp, `authenticator=webroot` для constructfin — challenge на порту 80 идёт даже после появления редиректа на https). Продление — общий `certbot.timer`, `deploy-hook`/`renew_hook` = `systemctl reload nginx`. Проверить сроки: `certbot certificates`.

Кука `construct_jwt` привязана к хосту — вход на одном адресе не переносится на другой, логиниться заново.

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
