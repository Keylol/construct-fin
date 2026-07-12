# Внешний мониторинг (Фаза 1 п.7)

Аптайм-пинг прод-эндпоинта `/health` с алертом. Сам монитор живёт во внешнем
сервисе (UptimeRobot / healthchecks.io) — в репозитории только эта инструкция,
аккаунт и алерт-контакты заводятся в дашборде сервиса.

## Что мониторить

- **URL:** `https://miniapp.aleksandrantropov.online/api/v1/health`
  (nginx проксирует `/api/v1/` → `127.0.0.1:4000/`, т.е. на бэкендовый `/health`)
- **Ожидаемо:** HTTP `200`, тело `{"status":"ok","db":"ok"}`,
  `Content-Type: application/json`.

## UptimeRobot

1. Add New Monitor → **HTTP(s)** (или **Keyword**).
2. URL — см. выше. Interval — **5 минут** (free-план; платный — 1 мин).
3. Тип **Keyword**, keyword = `"db":"ok"` (matches when keyword **exists**).
   Так алерт сработает не только на «сайт лёг», но и на «API жив, а БД отвалилась»
   — `/health` тогда вернёт другое тело, keyword не найдётся.
4. Alert Contacts — e-mail и/или Telegram-бот UptimeRobot.

## healthchecks.io (альтернатива / дополнение)

healthchecks.io — это «dead man's switch» (ждёт пинг ОТ нас), а не активный
опрос. Подходит для контроля cron-задач (напр. ночной бэкап), не для HTTP-аптайма.
Для аптайма `/health` берём UptimeRobot. Если захотим контролировать бэкап:
после успешного `/backup.sh` слать `curl -fsS https://hc-ping.com/<uuid>`; молчание
> периода → алерт.

## Связка со структурным логом (L5)

API в проде пишет единый JSON-лог на stdout через **nestjs-pino** (конфиг —
`apps/api/src/common/logger.config.ts`): и request-логи Fastify, и логи Nest
(`Logger.*`) в одном потоке. Каждый запрос несёт **`x-request-id`** — входящий
уважается (можно проставить nginx'ом), иначе генерируется UUID; тот же id
возвращается заголовком ответа. Любой **5xx** логируется с контекстом
(`METHOD url → status [reqId=…]`) и полным стеком (`AllExceptionsFilter`) — по
`x-request-id` из ответа находится вся история запроса в логе.

Request-логи `/health` заглушены (`autoLogging.ignore`), чтобы health-пинги
(docker каждые 20s + внешний монитор) не зашумляли лог; ошибки/5xx логируются
всегда. Уровень — `LOG_LEVEL` (по умолчанию `info` в проде).

**Форензика после инцидента:** логи собирает docker `json-file` с ротацией (L4,
`docker-compose.prod.yml`). Достать: `docker compose logs api --tail=… | grep <reqId>`.
Следующий шаг (вне этого PR) — L5-алертинг на error-rate/5xx и переживание логов
между релизами (шиппинг во внешний сервис/volume).

## После активации заголовков безопасности (п.5)

Монитор бьёт по HTTP-ответу, заголовки CSP/HSTS на него не влияют. Но при ручной
активации nginx-конфига на VPS проверь, что `/health` всё ещё 200 (curl выше).
