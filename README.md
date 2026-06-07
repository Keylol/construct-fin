# Construct v6

Финансовый учёт для малого бизнеса и самозанятых. Веб-приложение (mobile + desktop) + Telegram Mini App.

## Стек

- **Монорепо:** pnpm workspaces
- **Backend:** NestJS 10 (Fastify), Prisma 5, PostgreSQL 16
- **Frontend:** Next.js 14 (App Router), Tailwind, shadcn/ui (планируется)
- **Auth:** Telegram Login Widget + Telegram Mini App initData
- **Язык:** TypeScript strict end-to-end

## Структура

```
apps/
  api/        — NestJS API
  web/        — Next.js frontend
packages/
  db/         — Prisma schema + client re-export
  shared/     — DTO, zod-схемы, общие хелперы
  ui/         — (зарезервировано под shadcn/ui компоненты)
```

## Запуск локально

### 1. Подготовка

```bash
cp .env.example .env
# Заполни TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_ALLOWED_IDS, JWT_SECRET
```

### 2. Установка зависимостей

```bash
pnpm install
```

### 3. Поднять Postgres

```bash
pnpm docker:up
```

### 4. Применить миграции и сгенерировать Prisma client

```bash
pnpm db:migrate    # создаст первую миграцию init
pnpm db:generate
```

### 5. Запустить dev-серверы

```bash
pnpm dev           # параллельно запустит api (4000) и web (3000)
```

Откой http://localhost:3000.

## Скрипты

| Команда | Что делает |
|---|---|
| `pnpm dev` | dev-режим api + web параллельно |
| `pnpm build` | production-сборка всего |
| `pnpm typecheck` | TS-проверка всех пакетов |
| `pnpm lint` | ESLint всех пакетов |
| `pnpm test` | unit-тесты всех пакетов |
| `pnpm db:migrate` | Prisma migrate dev |
| `pnpm db:studio` | Prisma Studio (GUI для БД) |
| `pnpm docker:up` | Запустить Postgres в Docker |
| `pnpm docker:down` | Остановить Postgres |

## Telegram

Для локальной разработки Login Widget требует **HTTPS-домен**. Используй один из:
- `cloudflared tunnel` (рекомендуется): `cloudflared tunnel --url http://localhost:3000`
- `ngrok http 3000`

Полученный URL пропиши:
1. В `@BotFather` → твой бот → Bot Settings → Domain
2. В `.env` как часть `NEXT_PUBLIC_API_URL` (если нужно)

`TELEGRAM_ALLOWED_IDS` — comma-separated список Telegram user-ID. Если пусто — открытая регистрация (для dev). На проде всегда задавай.

## Учётная модель и осознанные ограничения

Эти упрощения — **сознательный выбор для текущего скоупа**, а не недоработки. Пересмотр возможен, но вне MVP.

### Учёт по кассовому методу (cash-basis)

Доходы и расходы признаются **в момент движения денег**, а не по начислению:

- Закупка товара = расход в момент оплаты (COGS отражается через закупку), **капитализация запасов не делается** — стоимость склада не превращается в актив на балансе.
- В P&L каждая сумма попадает в **одну** классификацию (бакет): дедупликация COGS сделана в Фазе 3 (см. `docs/improvement-plan.md` п.15), отчёт сходится сам с собой.
- Следствие: P&L отражает денежный поток по категориям, а не accrual-прибыль. Для малого бизнеса/самозанятых это ожидаемо и корректно.

Двойная запись и `JournalEntry` намеренно не реализованы (есть только `IdempotencyKey`).

### Модель доступа — плоская

Роли (`OWNER / ADMIN / MEMBER / VIEWER`) **хранятся, но не ограничивают операции**: любой участник workspace может вносить изменения.

- Это осознанное решение под текущий контекст — **малый доверенный круг пользователей** (по сути 1–2 владельца), где гранулярные права избыточны.
- `WorkspaceGuard` уже резолвит роль в `req.workspace.role`, а enum сохранён в схеме — если понадобится разграничение, гейтинг навешивается `@MinRole`-декоратором поверх `WorkspaceGuard` без миграций.
- Изоляция данных между workspace при этом строгая: `WorkspaceGuard` проверяет членство на каждом запросе (`:wsId` в URL).

## Документация

- [Аудит и план пересборки](docs/architecture.md)
- [Модель данных](packages/db/prisma/schema.prisma)

## Статус

🚧 Фаза 0 (каркас) — готова. Идём в фазу 1 (workspaces + справочники).
