# Construct v6 — context для Claude Code

> Этот файл автоматически загружается Claude при работе в этом репо.
> Подробная история и решения: `docs/architecture.md`, `docs/telegram-setup.md`,
> а также handoff-заметка в Obsidian: `~/Documents/Обсидиан/notes/Construct-v6-handoff-2026-05-23.md`.

## 🔀 Модель ветвления (после консолидации 2026-07-05)

Репозиторий сведён к **одной ветке `v6`** — она же дефолтная на GitHub и с неё идёт прод-деплой. Все старые feature/wave/phase-ветки и worktree-и удалены (генплан фаз 0→5 и волны аудита закрыты).

- Новая работа → **feature-ветка от `v6` → PR в `v6` → зелёный CI → мёрж**. Не пушить в `v6` напрямую: **пуш в `v6` триггерит прод-деплой** (`deploy.yml`).
- `schema.prisma`, миграции, локальная БД, `apps/api/src/main.ts` — общие ресурсы, менять по одной миграции за раз.

## Что это

Финансовый учёт для малого бизнеса / самозанятых. Веб-приложение (mobile+desktop) + Telegram Mini App. Полная пересборка с нуля; старая версия v5.2.1 живёт в `~/Documents/Legacy/Construct/` (рабочая, можно подсматривать алгоритмы, но **переносить код напрямую нельзя**).

## Состояние (на 2026-07-18)

- **Все фазы генплана 0→5 закрыты**; поверх — council-аудит (~105 находок, волны 1–3 + движок правил Rule), UX-волны В1–В4, дизайн-волны Д1–Д4 («сухой гроссбух»: IBM Plex, navy+янтарь, display-цифры mono), мобильный таб-бар, drill-down отчётов.
- **IJ9 закрыт (2026-07-14):** ОПиУ и маржа — «по реализации» (`Order.closedAt`), возвраты — датированные события `OrderReturn` (минус в месяц возврата), «Закупки» — инфо-строка вне прибыли (склад = актив), ОДДС остаётся строго cash. Дизайн: `docs/ij9-accrual-design.md`.
- **Генплан «Полный автомат» без ключей закрыт (2026-07-17):** Ф1 фундамент + Ф6 закупки (WB/ДНС/ОТ/ручной) + Ф4 «Налог» (АУСН Д−Р, `/tax`) + Ф5 «Платежи» (регулярные/плановые + напоминания, `/planning`). Ф2 Альфа / Ф3 Т-Банк ждут банковских ключей.
- **Ревизия 2026-07-18:** лексика UI сведена к стандартной финансовой (Денежные средства / Дебиторская задолженность / Валовая прибыль / ОПиУ, «обработка/проведение» вместо «разбора», «вы»-формы); все плитки дашборда кликабельны (drill-down); раздел **«Зарплата» `/salary`** (сотрудники role=EMPLOYEE c должностью/окладом, разовые и регулярные выплаты, фильтр `txKind=SALARY`); общие компоненты платежей в `components/planning/`.
- **Прод:** VPS 195.133.1.13, https://miniapp.aleksandrantropov.online (TLS до 2026-09-05, серт только на живой домен); деплой = push в `v6` (см. ветвление выше).
- **Тесты:** ~399 unit + ~461 integration + ~149 functional (числа плывут вверх; все против `construct_v6_test` на :5433).
- **Mini App логин end-to-end:** `@ConstructFinance_bot`; локально для браузера можно подписать JWT секретом из `apps/api/.env` и положить cookie `construct_jwt` (API локально живёт БЕЗ префикса `/api/v1` — его добавляет прод-nginx).

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
- ~~Склад / заказы / COGS~~ — **вернулись в скоуп**: `OrderService`/`WarehouseService`/`PurchaseService`, **FIFO**-себестоимость (StockLot/LotConsumption, F0), сьют `money-flows.integration.test.ts`. Учёт: **ОПиУ и маржа — по реализации** (IJ9, `docs/ij9-accrual-design.md`), **ОДДС — cash**.
- Двусторонний Google Sheets sync
- AI-аналитика расходов
- Push-уведомления (только in-app)
- Мультивалютность (только ₽)
- Точка безубыточности (флаг `Category.isFixedCost` есть, endpoint — post-MVP)
- Долги / кредиты, цели / накопления

## Что дальше (бэклог на 2026-07-14)

- **Волна 4 (наблюдаемость):** L5 частично сделана (nestjs-pino, x-request-id, форензик 5xx) — остаётся алертинг error-rate и активация UptimeRobot.
- Сверка факта прод-БД по backfill `OrderReturn` (Σ qty событий == Σ returnedQty) — SSH требует запуска вне авто-режима.
- Summary-эндпоинт для карточек клиента/поставщика (сводка сейчас по загруженным страницам).
- Буклет-инструкция под новый UI; живой клик-тест редизайна в Mini App (только владелец).

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
| `apps/api/src/reports/pnl.service.ts` | ОПиУ по реализации (IJ9): признание по closedAt + события возвратов |
| `apps/api/src/trade-reports/margin.service.ts` | Маржа (та же семантика; ключ «без клиента» содержит NUL-байт — grep видит binary) |
| `apps/api/src/orders/order.service.ts` | Заказы: оплаты/отгрузка/finalize/RMA (пишет события OrderReturn) |
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
- **Partial-unique индексы (Фаза 4 п.17/21)** заведены сырым SQL в миграциях (`Transaction_workspaceId_importHash_active_key` и др. `..._active_key`), т.к. Prisma не умеет `WHERE deletedAt IS NULL` в `@@unique`. Их НЕТ в `schema.prisma` → `prisma migrate dev` видит их как **drift** и предлагает дропнуть. При новой миграции: `migrate dev --create-only`, **убрать из сгенерённого SQL `DROP INDEX ..._active_key`** и при необходимости вписать индекс обратно вручную. Не давать `migrate dev` применить дроп.
