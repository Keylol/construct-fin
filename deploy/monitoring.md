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

## Связка со структурным логом

С Фазы 1 п.7 API в проде пишет JSON-лог (pino, `logger` в `apps/api/src/main.ts`).
Healthcheck-пинги (docker каждые 20s + внешний монитор) попадают в request-лог —
если станет шумно, можно либо поднять `LOG_LEVEL=warn`, либо отключить
request-логи для `/health` (follow-up; в конфиг-фазе не делаем).

## После активации заголовков безопасности (п.5)

Монитор бьёт по HTTP-ответу, заголовки CSP/HSTS на него не влияют. Но при ручной
активации nginx-конфига на VPS проверь, что `/health` всё ещё 200 (curl выше).
