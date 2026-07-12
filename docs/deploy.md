# Construct v6 — deploy

## Production топология

```
miniapp.aleksandrantropov.online  →  VPS 195.133.1.13  →  nginx :443
                                                            ├ /api/v1/* → 127.0.0.1:4000 (api контейнер)
                                                            └ /         → 127.0.0.1:3000 (web контейнер)
                                                          docker compose stack at /srv/construct-v6:
                                                            ├ postgres:16-alpine (volume pgdata)
                                                            ├ api (ghcr.io/keylol/construct-v6-api:latest)
                                                            └ web (ghcr.io/keylol/construct-v6-web:latest)
```

LE-сертификат `/etc/letsencrypt/live/constructpc.aleksandrantropov.ru/` имеет `miniapp.aleksandrantropov.online` в SAN (срок до 2026-08-02) — переиспользуется без отдельного выпуска. После 2026-07 — `certbot renew` подхватит автоматически.

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
