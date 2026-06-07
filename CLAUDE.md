# Construct v6 — context для Claude Code

> Этот файл автоматически загружается Claude при работе в этом репо.
> Подробная история и решения: `docs/architecture.md`, `docs/telegram-setup.md`,
> а также handoff-заметка в Obsidian: `~/Documents/Обсидиан/notes/Construct-v6-handoff-2026-05-23.md`.

## 🔀 Параллельная работа — кто на чём (план: `docs/improvement-plan.md`)

Идёт генеральный план доработок (фазы 0→5, цель — общая оценка ~7.25). Несколько сессий могут идти параллельно в git worktree. **Прежде чем менять файл — проверь эту таблицу, чтобы не пересечься.**

| Ветка / worktree | Зона ответственности (трогать только это) | Статус |
|---|---|---|
| `v6` (основной репо) | Фаза 0 (CI/деплой), Фаза 4 (миграции — ТОЛЬКО здесь, по одной), мёрж PR | активно |
| `phase3-dto` | Ф3 п.14+16: `apps/api/src/category/*`, `apps/api/src/transaction/*` | не начато |
| `phase3-cogs` | Ф3 п.15: `apps/api/src/reports/pnl.service.ts`, `apps/api/src/orders/order.service.ts` | не начато |

**Правила параллели:**
- `schema.prisma`, миграции, локальная БД, `apps/api/src/main.ts` — общие ресурсы, меняются **только в `v6`**, никогда параллельно.
- Каждая ветка → отдельный PR → зелёный CI → мёрж. Не пушить в `v6` напрямую (пуш триггерит прод-деплой).
- Фазы 3/5 стартуют **после** мёржа Фазы 0. Перед стартом: `git rebase v6` в своём worktree.

## Что это

Финансовый учёт для малого бизнеса / самозанятых. Веб-приложение (mobile+desktop) + Telegram Mini App. Полная пересборка с нуля; старая версия v5.2.1 живёт в `~/Documents/Legacy/Construct/` (рабочая, можно подсматривать алгоритмы, но **переносить код напрямую нельзя**).

## Состояние (на 2026-05-23)

- **Ветка:** `v6` (orphan) в `Keylol/construct-fin`, 8 коммитов, последний `2ea75ee`
- **Фазы 0–2 закрыты:** монорепо, БД, auth (Login Widget + Mini App), workspaces, accounts, categories (2 уровня), counterparties, transactions (CRUD + фильтры + summary), attachments
- **Mini App логин работает end-to-end:** `@ConstructFinance_bot` → ngrok → авто-логин → /dashboard
- **Тесты:** 21 unit зелёный, 14 e2e проверок против живой БД пройдены

## Стек (фиксирован, не менять без явного согласия)

- pnpm workspaces (apps/api, apps/web, packages/db, packages/shared)
- **API:** NestJS 10 + Fastify + Prisma 5
- **Web:** Next.js 14 App Router + Tailwind + минималистичные UI-обёртки (без shadcn-cli)
- **БД:** Postgres 16 в Docker через Colima, порт `5433` (не 5432 — занят v5.2.1)
- **Auth:** Telegram Login Widget + Telegram Mini App initData → JWT в HTTP-only cookie
- **TypeScript:** strict end-to-end, `no any`, валидация через zod

## Правила работы (важно)

1. **Спрашивать на каждой архитектурной развилке** — формат блица Q-A через AskUserQuestion.
2. **Коммиты по логическим вехам** — не каждый файл, не один в конце. Группировать в feat/fix с осмысленным сообщением.
3. **Не коммитить без явного запроса.** Пользователь говорит «коммить» — тогда коммит.
4. **Бэк хороший, фронт — рабочий минимум.** Не уходить в полировку фронта.
5. **TS strict, money как Decimal-строка.** Никогда `number` для денег.
6. **Soft-delete везде.** `deletedAt`, не физическое удаление.
7. **Workspace-scoped:** каждый запрос проходит `WorkspaceGuard` через `:wsId` в URL.
8. **Telegram bot token** живёт на новом прод-VPS в `/srv/construct-v6/.env.production`, читать через `ssh -i ~/.ssh/deploy_ferrum root@195.133.1.13`. Локальный мог устареть. (Старый VPS `45.82.254.230`/`/srv/construct/app` мёртв с ~05.06 — хостер обанкротился.)

## Что НЕ делаем в MVP

- Двойная запись (есть таблица `IdempotencyKey`, но `JournalEntry` модель не создана)
- Склад / заказы / COGS (выкинуто из скоупа — был специфичен для сборки ПК)
- Двусторонний Google Sheets sync
- AI-аналитика расходов
- Push-уведомления (только in-app)
- Мультивалютность (только ₽)
- Точка безубыточности (флаг `Category.isFixedCost` есть, endpoint — post-MVP)
- Долги / кредиты, цели / накопления

## Что дальше

**Фаза 3 (приоритет):** CSV/Excel импорт с wizard (маппинг колонок), `RecurringRule` cron-runner (BullMQ или pg_cron, идемпотентность по `(ruleId, nextRunAtBefore)`).

**Фаза 4:** P&L / Cash flow / по категориям / по контрагентам / сравнение периодов / PDF + Excel экспорт.

**Фаза 5:** PWA manifest, Telegram theme params интеграция, Playwright e2e, деплой staging на `v6.aleksandrantropov.ru`.

## Запуск

```bash
colima start                                          # один раз
docker-compose up -d                                  # Postgres :5433
export $(grep -v '^#' .env | xargs)
pnpm --filter @construct/db exec prisma generate
pnpm db:migrate                                       # если первый запуск
# 3 терминала:
cd apps/api && pnpm dev                               # :4000
cd apps/web && pnpm dev                               # :3000
ngrok http 3000                                       # публичный HTTPS
# затем setChatMenuButton на ngrok URL — см. docs/telegram-setup.md
```

## Ключевые файлы

| Где | Что |
|---|---|
| `packages/db/prisma/schema.prisma` | Модель данных (10 моделей) |
| `apps/api/src/app.module.ts` | Корень NestJS, список модулей |
| `apps/api/src/auth/telegram-verify.ts` | HMAC проверка Widget + Mini App |
| `apps/api/src/common/workspace.guard.ts` | Проверка членства в workspace |
| `apps/api/src/transaction/transaction.service.ts` | Самая сложная бизнес-логика (фильтры, summary) |
| `apps/web/src/app/layout.tsx` | Telegram SDK Script (beforeInteractive) |
| `apps/web/src/app/login/page.tsx` | Mini App auto-login + Widget fallback |
| `apps/web/src/components/transactions/TransactionFormDialog.tsx` | FAB-форма быстрого ввода |
| `apps/web/src/lib/periods.ts` | rangeFor() для today/week/month/quarter/year/all |

## Известные грабли

- **`localhost:5432` уже занят** v5.2.1, мы на `127.0.0.1:5433`
- **Cloudflared** в РФ не работает (TLS блокируется), используем **ngrok**
- **Per-chat menu button** перекрывает глобальную — обновлять для каждого user_id отдельно
- **Telegram SDK** грузить через `<Script strategy="beforeInteractive">`, иначе `window.Telegram.WebApp` пустой
- **HMAC sort** — по ключу `pair[0]`, не по полной строке `key=value`
- **@construct/shared** и **@construct/db** должны быть собраны в `dist/` (CommonJS), Node 25 ESM не резолвит `.ts`
- **AuthModule** должен быть `@Global()`, иначе JwtAuthGuard не виден другим модулям
- **HMR EADDRINUSE:** иногда nest start --watch не убивает старый процесс. `pkill -f "nest start" && lsof -ti :4000 | xargs kill -9`
