# Construct v6 — архитектура

## Принципы

1. **TypeScript strict end-to-end.** Один язык от Postgres-схемы до UI. Все DTO в `packages/shared` через zod.
2. **Workspace-scoped data.** Каждая сущность принадлежит workspace; пользователь может быть в нескольких. RBAC через `WorkspaceMember.role`.
3. **Soft-delete + audit log.** Никаких физических удалений финансовых данных. Все мутации пишутся в `AuditLog`.
4. **Деньги — `Decimal(14,2)`.** Никогда не `Float`. На транспорте — строка.
5. **Идемпотентность POST'ов.** Через заголовок `Idempotency-Key` (24ч TTL в таблице `IdempotencyKey`).
6. **Cursor pagination.** Не offset.

## Слои бэка (NestJS)

```
Controllers (HTTP, валидация zod) 
   → Services (бизнес-логика, транзакции Prisma)
      → PrismaService (singleton)
         → PostgreSQL
```

Cross-cutting:
- `JwtAuthGuard` — проверка cookie/Bearer токена
- `WorkspaceGuard` (фаза 1) — проверка членства в ws
- `AuditInterceptor` (фаза 2) — автоматическая запись в `AuditLog`
- `IdempotencyInterceptor` (фаза 2) — кэширование ответа по ключу

## Аутентификация

```
Browser (desktop)              Telegram Mini App
   │                                  │
   ▼                                  ▼
Login Widget (HMAC-SHA256)    initData (HMAC-SHA256, WebAppData)
   │                                  │
   └─────────────┬────────────────────┘
                 ▼
         POST /auth/telegram/*
                 │
                 ▼
       AuthService.verify + upsert User
                 │
                 ▼
       JWT в HTTP-only cookie (construct_jwt, 30d)
```

Allowlist: `TELEGRAM_ALLOWED_IDS` в `.env`. Пустой = открытая регистрация (только для dev).

## Дизайн (web)

iOS-glass:
- Полупрозрачные карточки `rgba(glass, 0.6)` + `backdrop-filter: blur(24px)`
- Углы 16–24px
- Системные шрифты SF Pro / `-apple-system`
- Touch-targets ≥ 44px
- Светлая + тёмная тема через `data-theme` атрибут на `<html>`

Адаптивность:
- `<768px`: bottom-nav + FAB
- `≥768px`: sidebar + topbar

## Не делаем в MVP

- Двойная запись (`JournalEntry`) — отдельный пост-MVP модуль.
- Склад, заказы, COGS — выкинуто из текущего скоупа (универсальный учёт без специфики сборки ПК).
- Google Sheets двусторонний sync — заменён экспортом CSV/Excel/PDF.
- AI-аналитика — отложена.
- Push-нотификации — только in-app.
- Мультивалютность — отложена.
- Точка безубыточности — отложена (поле `Category.isFixedCost` заложено).

См. полный аудит и план в корневом отчёте сессии.
