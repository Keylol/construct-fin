# Postgres backup & restore — runbook

Бэкап-сервис описан в `deploy/docker-compose.prod.yml` (`service: backup`).
Образ — `prodrigestivill/postgres-backup-local:16`.

## Расписание и ротация

Управляется переменными окружения в `.env` на VPS:

| ENV | Значение по умолчанию | Что значит |
|---|---|---|
| `BACKUP_SCHEDULE` | `17 3 * * *` | Cron-выражение. Запуск в 03:17 каждый день. |
| `BACKUP_KEEP_DAYS` | `14` | Сколько daily-дампов хранить. |
| `BACKUP_KEEP_WEEKS` | `8` | Сколько недельных. |
| `BACKUP_KEEP_MONTHS` | `12` | Сколько месячных. |

Дампы лежат в volume `backups` (на VPS — обычно `/var/lib/docker/volumes/construct-v6_backups/_data/`).

## Запуск

После `git pull` на VPS просто пересоберите стек:

```sh
cd /srv/construct-v6
docker compose pull
docker compose up -d
```

Если сервис уже бежит, первый дамп сделается в ближайший `SCHEDULE`.
Чтобы прогнать вручную сразу:

```sh
docker compose exec backup /backup.sh
```

## Проверить содержимое

```sh
docker compose exec backup ls -lh /backups/daily/
docker compose exec backup ls -lh /backups/weekly/
docker compose exec backup ls -lh /backups/monthly/
```

## Скачать дамп на свой компьютер

```sh
ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13 \
  "docker compose -f /srv/construct-v6/docker-compose.yml exec -T backup cat /backups/daily/construct_v6-$(date +%Y%m%d).sql.gz" \
  > construct_v6-$(date +%Y%m%d).sql.gz
```

(Имя файла шаблон: `<DB>-YYYYMMDD-HHMMSS.sql.gz`. Проверьте `ls` сначала.)

## Восстановление

В отдельную БД (на dev-машине):

```sh
gunzip -c construct_v6-YYYYMMDD.sql.gz | \
  psql "postgresql://construct:****@127.0.0.1:5433/construct_v6_restored"
```

Прямо в прод (ОСТОРОЖНО — это перезатрёт текущие данные):

```sh
# 1. Остановить api/web, чтобы не было записей во время restore.
docker compose stop api web

# 2. Залить дамп. --clean -c снесёт существующие таблицы, потом восстановит.
docker compose exec -T postgres pg_restore \
  --clean --if-exists \
  -U construct -d construct_v6 \
  < some-pre-extracted-dump.sql

# Или из .sql.gz:
docker compose exec -T backup sh -c 'gunzip -c /backups/daily/construct_v6-YYYYMMDD-HHMMSS.sql.gz' | \
  docker compose exec -T postgres psql -U construct -d construct_v6

# 3. Поднять обратно.
docker compose up -d api web
```

## Off-site copy (опционально)

Если хочется иметь копию вне VPS, добавь на хост cron-задачу, которая раз в
день rsync'ит `/var/lib/docker/volumes/construct-v6_backups/_data/` на S3/B2/
другой VPS. Подойдёт, например, `rclone`.
