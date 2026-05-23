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

## Документация

- [Аудит и план пересборки](docs/architecture.md)
- [Модель данных](packages/db/prisma/schema.prisma)

## Статус

🚧 Фаза 0 (каркас) — готова. Идём в фазу 1 (workspaces + справочники).
