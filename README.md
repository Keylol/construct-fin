# ConstructPC Bot

Telegram-бот для управленческого учета сборок ПК без кнопок:
- распознает операции из свободного текста через OpenAI-совместимый API (`gpt-5.4-mini` по умолчанию);
- ведет учет в SQLite;
- синхронизирует Google Sheets с помесячными листами и дашбордом.

## Что умеет

- Карточка клиента по телефону (`1 карточка = 1 телефон`).
- Заказы по клиенту (один телефон может иметь много заказов).
- Операции:
  - `продажа`
  - `закупка`
  - `расход`
  - `предоплата`
  - `постоплата`
- Мягкое подтверждение текстом:
  - `ок`
  - `исправь сумма 55000`
- Документы по активному заказу: только `pdf/doc/docx`.
- Отчеты через `/report`.
- Google Sheets:
  - `Справочник расходов`
  - `Журнал расходов <месяц>`
  - `Доход <месяц>`
  - `Итог <месяц>`
  - `Дашборд`

## Быстрый старт

1. Установка:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Создайте `.env` из шаблона `.env.example` и заполните минимум:
- `TELEGRAM_BOT_TOKEN`
- `OWNER_USER_IDS`

Для старого текстового бота `ALLOWED_USER_IDS` можно оставить как legacy allow-list, но для Mini App безопасная схема доступа строится через:
- `OWNER_USER_IDS`
- `OPERATOR_USER_IDS`

3. Запуск:

```bash
python -m bot.main
```

## Основные команды

- `/order +79991234567 Иванов Иван` — открыть/создать карточку и новый заказ.
- `/app` — открыть Telegram Mini App.
- `/card` — показать активный заказ.
- `/closeorder` — закрыть активный заказ.
- `/report profit month` — отчет.
- `/sheetsetup` — синхронизация Google Sheets.

## Тесты

```bash
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

## Автозапуск через launchd (macOS)

Установить и сразу запустить сервис:

```bash
./scripts/install_launchd.sh
```

Проверить статус:

```bash
launchctl print gui/$(id -u)/com.constructpc.bot
```

Перезапустить:

```bash
launchctl kickstart -k gui/$(id -u)/com.constructpc.bot
```

Остановить и отключить:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.constructpc.bot.plist
launchctl disable gui/$(id -u)/com.constructpc.bot
```

## Mini App (Day 1-4)

Backend API:

```bash
source .venv/bin/activate
pip install -r miniapp_api/requirements.txt
alembic -c miniapp_api/alembic.ini upgrade head
MINIAPP_RELOAD=1 ./scripts/run_miniapp_api.sh
```

React Mini App UI:

```bash
source .venv/bin/activate
pip install nodeenv
nodeenv .nodeenv --node=22.12.0
PATH="/Users/alexander/Documents/Construct/.nodeenv/bin:$PATH"
cd miniapp_web
npm ci
npm run build
npm run serve
```

UX layer in Mini App now includes:
- Telegram native controls (`MainButton`, `BackButton`, haptic feedback)
- inline validation and input normalization (phone, amount, text)
- local UX metrics panel for quick product diagnostics

API autostart via launchd (macOS):

```bash
./scripts/install_launchd_miniapp_api.sh
launchctl print gui/$(id -u)/com.constructpc.miniapp.api
```

Mini App web autostart via launchd (macOS):

```bash
./scripts/install_launchd_miniapp_web.sh
launchctl print gui/$(id -u)/com.constructpc.miniapp.web
```

Local PostgreSQL (no brew, binaries in project):

```bash
./scripts/postgres_local.sh bootstrap
```

Local PostgreSQL autostart via launchd (macOS):

```bash
./scripts/install_launchd_postgres_local.sh
launchctl print gui/$(id -u)/com.constructpc.postgres.local
```

Temporary HTTPS tunnel for Mini App web (after tunnel tool install):

```bash
./scripts/start_temp_tunnel.sh
```

`start_temp_tunnel.sh` auto-detects:
- global `cloudflared`
- local `.setup/tools/bin/cloudflared`
- global `ngrok`

If backend is not on default URL, set in browser console before app init:

```js
window.CONSTRUCT_API_BASE = "http://127.0.0.1:8082/api/v1";
```

Quick check:

```bash
curl http://127.0.0.1:8080/healthz
./.venv/bin/python scripts/smoke_miniapp_release.py
```

Before financial releases, run the read-only DB preflight:

```bash
./.venv/bin/python scripts/preflight_financial_release.py
```

It blocks on closed orders with broken sale/payment/COGS invariants, invalid operation dates, missing order links, non-kopiyka precision and other data risks. Use `--json` for CI/deploy automation.

`smoke_miniapp_release.py` validates:
- health + public MINIAPP_URL
- Telegram auth
- orders/operations/documents/reports full flow
- server-side atomic order finalization

Reliability hardening:

```bash
# rotate JWT secret in .env
./scripts/harden_jwt_secret.sh

# install daily PostgreSQL backup (04:30 local time)
./scripts/install_launchd_postgres_backup.sh

# run backup immediately (manual)
launchctl kickstart -k gui/$(id -u)/com.constructpc.postgres.backup

# restore backup into separate DB (safe mode)
./scripts/restore_postgres_backup.sh backups/postgres/<file>.sql.gz
```

Backup output:
- dumps: `backups/postgres/*.sql.gz`
- checksums: `backups/postgres/*.sha256`
- launchd logs:
  - `data/launchd.postgres.backup.out.log`
  - `data/launchd.postgres.backup.err.log`

Main Mini App API features now:

- `GET /api/v1/meta/options` - dictionaries for form selectors
- `GET/POST /api/v1/orders`, `POST /api/v1/orders/{order_id}/finalize`, `POST /api/v1/orders/{order_id}/close`
- `GET /api/v1/operations`
- `POST /api/v1/operations/preview/manual`
- `POST /api/v1/operations/preview/from-text`
- `POST /api/v1/operations/manual`
- `POST /api/v1/operations/from-text`
- `GET /api/v1/reports/summary`, `GET /api/v1/reports/timeseries`
- `GET /api/v1/reports/export.csv` (CSV export)
- `GET/POST /api/v1/documents` (upload/list by order)

Current release policy (Day 5 decisions):

- soft launch: owner-only Mini App access (`MINIAPP_SOFT_LAUNCH_OWNER_ONLY=1`)
- optional pilot override for 1 operator: `MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS=<telegram_id>`
- quick switch:
  - owner-only: `./scripts/switch_soft_launch_mode.sh owner-only`
  - owner+1: `./scripts/switch_soft_launch_mode.sh owner-plus-one <telegram_id>`
  - open: `./scripts/switch_soft_launch_mode.sh open`
- operator model after soft launch: only own data scope
- destructive order deletion: owner-only
- operation deletion: owner everywhere, operator only within own scope
- default report period: 7 days
- max document size: 50 MB
- notification mode: critical only

Security notes:

- Mini App prefers explicit roles: `OWNER_USER_IDS` / `OPERATOR_USER_IDS`
- if these roles are configured, `ALLOWED_USER_IDS` is ignored by Mini App API
- legacy fallback from `ALLOWED_USER_IDS` to Mini App owner is kept only for single-user bootstrap setups without explicit roles
- in `production`, API startup is blocked if `JWT_SECRET` is weak
