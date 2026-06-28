export const meta = {
  name: 'construct-fin-audit-phase1',
  description: 'Построчный аудит construct-fin по 4 веткам с адверсариальной верификацией (Opus 4.8)',
  phases: [
    { title: 'Review', detail: 'глубокий аудит каждой единицы кода, файл за файлом' },
    { title: 'Verify', detail: 'адверсариальная верификация каждой находки (refute-by-default)' },
  ],
}

const R = '/Users/alexander/Documents/construct-fin/'

const APP = `construct-fin — финансовое/бухгалтерское приложение (Telegram Mini App + web) для малого бизнеса (учёт денег клиентов).
Монорепо pnpm: apps/api (NestJS 10 + Fastify + Prisma 5 / Postgres 16), apps/web (Next.js 14 App Router + React Query v5), packages/shared (zod + формат денег), packages/db (Prisma).
ИНВАРИАНТЫ ДОМЕНА:
- Деньги ВСЕГДА Prisma.Decimal с ROUND_HALF_UP (apps/api/src/common/money.ts); на фронте — строки, formatRub рисует минус скобками. НИКОГДА number для денег.
- Учёт cash-basis. Правила корректности R1–R5: R1 COGS признаётся при продаже только для P&L/маржи (деньги ушли при закупке); R2 COGS неденежный (исключён из остатка/cashflow/сверки); R3 маржа услуг (услуга без затрат=100%); R4 возврат сторнирует COGS отрицательной проводкой против оригинала; R5 период UTC+5 фикс без DST (reports/period.ts + interval '5 hours' в cashflow SQL); округление half-up.
- Мультитенант = Workspace. Каждый запрос: JwtAuthGuard + WorkspaceGuard по :wsId. Cross-tenant guard в сервисах = findFirst({id, workspaceId, deletedAt:null}).
- Транзакции через UnitOfWork.run = prisma.$transaction (изоляция READ COMMITTED по умолчанию!). Конкурентность защищена ТОЛЬКО ручными SELECT ... FOR UPDATE (order.repository, warehouse.repository). Нет Serializable.
- Идемпотентность: глобальный IdempotencyInterceptor по заголовку Idempotency-Key (POST/PUT/PATCH/DELETE), резерв через PK + lease/TTL.
- Soft-delete (deletedAt) везде. Остаток счёта НЕ материализован (opening + Σtx). Кэш-поля Order.paidAmount/subtotal/totalAmount пересчитываются сервисом под локом.
- Валидация входа: zod через ZodPipe (class-validator НЕ используется).`

const SEV = `Severity:
- Critical: потеря/искажение денег, двойное списание, oversell, cross-tenant утечка/запись, обход auth, потеря данных, неверный расчёт остатка/COGS/маржи/cashflow, float в деньгах.
- High: гонки под конкуренцией (недостаточный лок), рассинхрон кэш-полей, отсутствие валидации на границе системы, утечка чувствительных данных в ошибках, неверный HTTP-код ломающий флоу, дыра в идемпотентности, неверная инвалидация кэша ведущая к показу неверных денег.
- Medium: пропущенный edge-case, неполная обработка ошибок, хрупкость к некорректным данным, потенциальный N+1/деградация на объёме.
- Low: стиль, мелкие неточности, документация, незначительные улучшения.`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['unitId', 'filesRead', 'findings'],
  properties: {
    unitId: { type: 'string' },
    filesRead: { type: 'array', items: { type: 'string' }, description: 'Полные пути всех файлов, которые ты реально открыл и прочитал целиком' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'category', 'file', 'title', 'evidence', 'why_it_matters', 'suggested_fix'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
          category: { type: 'string', description: 'напр. money-correctness, concurrency, multi-tenant, auth, validation, flow-contract, frontend' },
          file: { type: 'string', description: 'путь относительно корня репо' },
          line: { type: ['integer', 'null'] },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'точная цитата кода + почему это дефект (не догадка)' },
          why_it_matters: { type: 'string', description: 'конкретное последствие для денег/данных/безопасности' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason', 'adjusted_severity'],
  properties: {
    refuted: { type: 'boolean', description: 'true если дефект НЕ реален / не воспроизводится / уже защищён кодом' },
    reason: { type: 'string', description: 'доказательство из кода: почему опровергнут или подтверждён' },
    adjusted_severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'NotADefect'] },
  },
}

// ── Единицы аудита: {id, branch, focus, files[]} ──
const f = (...p) => p.map((x) => R + x)
const UNITS = [
  // ВЕТКА A — Ядро вычислений и деньги
  { id: 'A1-money-core', branch: 'A', focus: 'Decimal half-up без float, корректность обёрток add/sub/mul/div/money/cost/qty, формат строк, WAVG (applyPurchase меняет avgCost, applySale НЕ меняет, applyReturn, applySupplierReturn clamp≥0, InsufficientStock), классификация kind и NON_CASH (COGS), пагинация-курсор.', files: f('apps/api/src/common/money.ts','apps/api/src/common/wavg.ts','apps/api/src/common/transaction-kinds.ts','apps/api/src/common/pagination.ts') },
  { id: 'A2-pnl-period', branch: 'A', focus: 'ОПиУ: бакеты REVENUE/COGS/PURCHASES/FIXED/VARIABLE/TAX/CAPITAL/OTHER, знаки, валовая прибыль; период UTC+5 фикс без DST, границы месяца/квартала/года, отсутствие зависимости от process.env.TZ.', files: f('apps/api/src/reports/pnl.service.ts','apps/api/src/reports/period.ts') },
  { id: 'A3-cashflow-breakdown', branch: 'A', focus: 'ОДДС raw SQL с interval 5 hours: совпадение с period.ts, running balance, исключение неденежных (COGS) и ног перевода; разбивка по категориям/контрагентам; SQL-инъекции в Prisma.sql.', files: f('apps/api/src/reports/cashflow.service.ts','apps/api/src/reports/breakdown.service.ts') },
  { id: 'A4-trade-reports', branch: 'A', focus: 'Маржа by-product/by-client: себестоимость unitCostAtSale ?? unitCost ?? 0, netQty=qty−returnedQty, услуга 100% маржи, деление на ноль; дебиторка/aging корректность сумм и корзин старения.', files: f('apps/api/src/trade-reports/margin.service.ts','apps/api/src/trade-reports/receivables.service.ts','apps/api/src/trade-reports/trade-reports.dto.ts') },
  { id: 'A5-reconciliation', branch: 'A', focus: 'Сверка: computedBalance = opening + Σtx до asOf (исключая неденежные), discrepancy = actual − computed, граница asOf (включительно/исключительно), append-only AccountBalanceCheck.', files: f('apps/api/src/reconciliation/reconciliation.service.ts','apps/api/src/reconciliation/reconciliation.dto.ts') },
  { id: 'A6-export', branch: 'A', focus: 'Экспорт отчётов CSV/XLSX: совпадение чисел с источником, формат денег, отсутствие искажений округления/локали, CSV-инъекции (формулы).', files: f('apps/api/src/reports/export/builders.ts','apps/api/src/reports/export/csv.ts','apps/api/src/reports/export/xlsx.ts','apps/api/src/reports/export/report-table.ts','apps/api/src/reports/export/index.ts') },
  { id: 'A7-shared-money', branch: 'A', focus: 'Формат денег на фронте: formatRub (скобки для минуса, разделители, ₽), parseAmountInput (парсинг ввода, потеря точности, отрицательные), periods клиента (rangeFor TZ-устойчивость). Согласованность с backend money.ts.', files: f('packages/shared/src/money.ts','packages/shared/src/telegram.ts','packages/shared/src/index.ts','apps/web/src/lib/periods.ts') },

  // ВЕТКА B — Конкурентность, транзакции, идемпотентность
  { id: 'B1-uow-prisma', branch: 'B', focus: 'UnitOfWork.run = $transaction: уровень изоляции, отсутствие вложенных транзакций, обработка отката, переиспользование TxClient; PrismaService жизненный цикл/коннекшн-пул.', files: f('apps/api/src/common/unit-of-work.ts','apps/api/src/prisma/prisma.service.ts','apps/api/src/prisma/prisma.module.ts') },
  { id: 'B2-idempotency', branch: 'B', focus: 'IdempotencyInterceptor: атомарность резерва (create→P2002), lease/TTL, хэш запроса (method+url+stableStringify body), окна гонок при двойном POST, кэш ответа, поведение при краше in-flight.', files: f('apps/api/src/common/idempotency.interceptor.ts') },
  { id: 'B3-orders', branch: 'B', focus: 'OrderService (766 строк) + repo: lockAndLoad (FOR UPDATE) до мутаций, finalize (списание+COGS), ship (oversell remaining=qty−shipped), returnItem (over-return, сторно COGS против оригинала), addPayment (paymentStatus), reopen/cancel, syncPaymentState консистентность кэш-полей под гонками, nextNumber+retry P2002. assertAccount ВНЕ tx — окно гонки.', files: f('apps/api/src/orders/order.service.ts','apps/api/src/orders/order.repository.ts') },
  { id: 'B4-warehouse', branch: 'B', focus: 'WarehouseService + repo: FOR UPDATE перед каждым read-modify-write (decrementForSale/restock/applyPurchase/supplier-return), lost-update на qty/avgCost, WAVG пересчёт, recordMovement append-only журнал, adjust/set-cost инварианты (set-cost только avgCost=0&qty>0).', files: f('apps/api/src/warehouse/warehouse.service.ts','apps/api/src/warehouse/warehouse.repository.ts') },
  { id: 'B5-purchase', branch: 'B', focus: 'PurchaseService.register: атомарность (Transaction PURCHASE + Purchase + PurchaseLine + WAVG в одной UoW), assertRefs cross-tenant, идемпотентность, согласованность суммы Σ lineTotal.', files: f('apps/api/src/purchase/purchase.service.ts','apps/api/src/purchase/purchase.dto.ts') },
  { id: 'B6-transfer', branch: 'B', focus: 'TransferService: атомарность (Transfer + TRANSFER_OUT + TRANSFER_IN + опц VARIABLE_COST fee, одна UoW, общий transferGroupId), ноги сходятся, softDelete гасит все ноги, assertAccounts cross-tenant, перевод на тот же счёт.', files: f('apps/api/src/transfer/transfer.service.ts','apps/api/src/transfer/transfer.dto.ts') },
  { id: 'B7-transaction-svc', branch: 'B', focus: 'TransactionService: CRUD + summary (net денег), соответствие type↔kind, фильтры, isolation от неденежных, корректность summary под soft-delete, аудит внутри tx.', files: f('apps/api/src/transaction/transaction.service.ts') },

  // ВЕТКА C — Безопасность, multi-tenant, auth, валидация
  { id: 'C1-auth', branch: 'C', focus: 'Telegram HMAC (initData widget+miniapp, sort по pair[0]), JWT issue/verify, TTL, извлечение токена из Bearer/cookie, ThrottlerGuard на login, upsert User, отсутствие подделки tg-подписи, secure/httpOnly/sameSite cookie.', files: f('apps/api/src/auth/auth.service.ts','apps/api/src/auth/auth.controller.ts','apps/api/src/auth/jwt.guard.ts','apps/api/src/auth/jwt-ttl.ts','apps/api/src/auth/telegram-verify.ts','apps/api/src/auth/current-user.decorator.ts','apps/api/src/auth/auth.module.ts') },
  { id: 'C2-guards-bootstrap', branch: 'C', focus: 'WorkspaceGuard (членство по :wsId, кладёт контекст), порядок гардов, config-валидация env, main.ts bootstrap (CORS, глобальные интерсепторы/фильтры, лимиты загрузки, helmet/безопасные заголовки).', files: f('apps/api/src/common/workspace.guard.ts','apps/api/src/common/current-workspace.decorator.ts','apps/api/src/config.ts','apps/api/src/main.ts','apps/api/src/app.module.ts') },
  { id: 'C3-pipe-filter', branch: 'C', focus: 'ZodPipe (валидация, формат ошибок, отсутствие утечки внутренних деталей), AllExceptionsFilter (маппинг ошибок, не светит stack/SQL клиенту, коды).', files: f('apps/api/src/common/zod-pipe.ts','apps/api/src/common/all-exceptions.filter.ts') },
  { id: 'C4-attachments', branch: 'C', focus: 'Загрузка файлов: path traversal в имени, валидация типа/размера (file-validation), cross-tenant ensureTxBelongs/ensureOrderBelongs, download авторизация, хранение пути, MIME-spoofing.', files: f('apps/api/src/attachment/attachment.service.ts','apps/api/src/attachment/attachment.controller.ts','apps/api/src/attachment/file-validation.ts','apps/api/src/attachment/attachment.module.ts') },
  { id: 'C5-import-svc', branch: 'C', focus: 'ImportService preview/commit: дедуп по importHash (partial-unique), createMany контрагентов, ImportBatch, атомарность commit, cross-tenant accountId, авто-категоризация по CategoryRule, обработка больших файлов.', files: f('apps/api/src/import/import.service.ts','apps/api/src/import/import.dto.ts','apps/api/src/import/import.types.ts','apps/api/src/import/import.controller.ts') },
  { id: 'C6-import-parsers', branch: 'C', focus: 'Парсеры выписок: alfa-xlsx, generic-csv/xlsx, wb-pdf, detector, encoding, mapping, values — корректность парсинга сумм (Decimal, не float), дат, кодировок (cp1251), устойчивость к битым данным, отсутствие краша на вредоносном файле.', files: f('apps/api/src/import/parsers/alfa-xlsx.ts','apps/api/src/import/parsers/detector.ts','apps/api/src/import/parsers/encoding.ts','apps/api/src/import/parsers/generic-csv.ts','apps/api/src/import/parsers/generic-xlsx.ts','apps/api/src/import/parsers/mapping.ts','apps/api/src/import/parsers/values.ts','apps/api/src/import/parsers/wb-pdf.ts','apps/api/src/import/parsers/types.ts','apps/api/src/import/parsers/index.ts') },
  { id: 'C7-category-rules', branch: 'C', focus: 'Category (дерево 2 уровня, cross-tenant, циклы parent), CategoryRule + matcher (корректность матчинга, инъекции в правилах), DTO-валидация zod.', files: f('apps/api/src/category/category.service.ts','apps/api/src/category/category.dto.ts','apps/api/src/category/category.controller.ts','apps/api/src/category-rule/category-rule.service.ts','apps/api/src/category-rule/category-rule.dto.ts','apps/api/src/category-rule/matcher.ts','apps/api/src/category-rule/category-rule.controller.ts') },
  { id: 'C8-crud-tenant', branch: 'C', focus: 'Account/Counterparty/Workspace сервисы+DTO+контроллеры: cross-tenant guards, soft-delete, валидация, членство в workspace при создании, archive/delete каскады, openingBalance.', files: f('apps/api/src/account/account.service.ts','apps/api/src/account/account.dto.ts','apps/api/src/account/account.controller.ts','apps/api/src/counterparty/counterparty.service.ts','apps/api/src/counterparty/counterparty.dto.ts','apps/api/src/counterparty/counterparty.controller.ts','apps/api/src/workspace/workspace.service.ts','apps/api/src/workspace/workspace.dto.ts','apps/api/src/workspace/workspace.controller.ts') },

  // ВЕТКА D — Флоу, API-контракты, фронт
  { id: 'D1-controllers-domain', branch: 'D', focus: 'Контроллеры: коды ответов (@HttpCode 200/201/204), маршруты, проброс Idempotency-Key, DTO-привязка, отсутствие бизнес-логики в контроллерах. Согласованность контракта с фронтом.', files: f('apps/api/src/orders/order.controller.ts','apps/api/src/orders/order.dto.ts','apps/api/src/warehouse/warehouse.controller.ts','apps/api/src/warehouse/warehouse.dto.ts','apps/api/src/transaction/transaction.controller.ts','apps/api/src/transaction/transaction.dto.ts','apps/api/src/transfer/transfer.controller.ts','apps/api/src/reconciliation/reconciliation.controller.ts','apps/api/src/reports/reports.controller.ts','apps/api/src/reports/reports.dto.ts','apps/api/src/trade-reports/trade-reports.controller.ts','apps/api/src/audit/audit.controller.ts','apps/api/src/audit/audit.service.ts','apps/api/src/health/health.controller.ts') },
  { id: 'D2-hooks', branch: 'D', focus: 'React Query хуки: КОРРЕКТНОСТЬ инвалидации кэша после мутаций (показ неверных денег если не инвалидировать accounts/reports/summary), Idempotency-Key на payment/finalize/purchase, обработка ошибок. ВАЖНО: есть ли хуки useShip/useReturn — эндпоинты ship/returns существуют, проверь подключены ли.', files: f('apps/web/src/hooks/useOrders.ts','apps/web/src/hooks/useTransactions.ts','apps/web/src/hooks/useTransfers.ts','apps/web/src/hooks/useWarehouse.ts','apps/web/src/hooks/usePurchases.ts','apps/web/src/hooks/useReconciliation.ts','apps/web/src/hooks/useTradeReports.ts','apps/web/src/hooks/useReports.ts','apps/web/src/hooks/useImport.ts','apps/web/src/hooks/useAccounts.ts','apps/web/src/hooks/useCategories.ts','apps/web/src/hooks/useCategoryRules.ts','apps/web/src/hooks/useCounterparties.ts','apps/web/src/hooks/useAudit.ts','apps/web/src/hooks/useWorkspaces.ts','apps/web/src/hooks/useCurrentWorkspace.ts') },
  { id: 'D3-lib', branch: 'D', focus: 'lib/api.ts (fetch credentials:include, обработка ошибок ApiError, парсинг 204, деньги-как-строка), types.ts (соответствие backend DTO, деньги string не number), query-client, chart (цвета/семантика), cn.', files: f('apps/web/src/lib/api.ts','apps/web/src/lib/types.ts','apps/web/src/lib/query-client.ts','apps/web/src/lib/chart.ts','apps/web/src/lib/cn.ts') },
  { id: 'D4-pages-trade', branch: 'D', focus: 'Сложные торговые флоу UI: orders (создать/оплатить/отгрузить/возврат/finalize/cancel/reopen — все ли кнопки подключены к API, подтверждения деструктивных действий), transactions (создать/edit/delete, аттачменты), warehouse (закупка/adjust/set-cost/supplier-return).', files: f('apps/web/src/app/(app)/orders/page.tsx','apps/web/src/app/(app)/transactions/page.tsx','apps/web/src/app/(app)/warehouse/page.tsx') },
  { id: 'D5-pages-reports', branch: 'D', focus: 'transfers (создать/удалить), reconciliation (создать проверку/удалить), reports/* (cashflow/margin/receivables/categories/counterparties/rules + layout), import (wizard preview→commit). Корректность отображения денег, скобок, состояний загрузки/ошибок.', files: f('apps/web/src/app/(app)/transfers/page.tsx','apps/web/src/app/(app)/reconciliation/page.tsx','apps/web/src/app/(app)/reports/page.tsx','apps/web/src/app/(app)/reports/layout.tsx','apps/web/src/app/(app)/reports/cashflow/page.tsx','apps/web/src/app/(app)/reports/margin/page.tsx','apps/web/src/app/(app)/reports/receivables/page.tsx','apps/web/src/app/(app)/reports/categories/page.tsx','apps/web/src/app/(app)/reports/counterparties/page.tsx','apps/web/src/app/(app)/reports/rules/page.tsx','apps/web/src/app/(app)/import/page.tsx','apps/web/src/app/(app)/import/batches/page.tsx') },
  { id: 'D6-pages-crud-auth', branch: 'D', focus: 'accounts/categories/counterparties/clients/suppliers/audit/dashboard CRUD-страницы + (app)/layout (server-gate redirect /login) + login/page (только password, Telegram SDK НЕ подключён — расхождение с CLAUDE.md), app/layout, providers, page. Auth-флоу фронта, защита маршрутов.', files: f('apps/web/src/app/(app)/accounts/page.tsx','apps/web/src/app/(app)/categories/page.tsx','apps/web/src/app/(app)/counterparties/page.tsx','apps/web/src/app/(app)/clients/page.tsx','apps/web/src/app/(app)/suppliers/page.tsx','apps/web/src/app/(app)/audit/page.tsx','apps/web/src/app/(app)/dashboard/page.tsx','apps/web/src/app/(app)/layout.tsx','apps/web/src/app/login/page.tsx','apps/web/src/app/login/error.tsx','apps/web/src/app/layout.tsx','apps/web/src/app/providers.tsx','apps/web/src/app/page.tsx') },
  { id: 'D7-components', branch: 'D', focus: 'Компоненты: TransactionFormDialog/Filters/ListItem (ввод денег, валидация), reports (ExportButtons, PeriodPicker), layout (AppShell/Header/Sidebar/WorkspaceSwitcher/CommandPalette/nav-items), ключевые ui (Button/Card/KpiCard/DataTable/Dialog/Modal/Pagination/Select/Input). Фокус на формах денег и согласованности, не на стиле.', files: f('apps/web/src/components/transactions/TransactionFormDialog.tsx','apps/web/src/components/transactions/TransactionFilters.tsx','apps/web/src/components/transactions/TransactionListItem.tsx','apps/web/src/components/reports/ExportButtons.tsx','apps/web/src/components/reports/PeriodPicker.tsx','apps/web/src/components/layout/AppShell.tsx','apps/web/src/components/layout/Header.tsx','apps/web/src/components/layout/Sidebar.tsx','apps/web/src/components/layout/WorkspaceSwitcher.tsx','apps/web/src/components/layout/GlobalCommandPalette.tsx','apps/web/src/components/layout/nav-items.ts','apps/web/src/components/ui/Button.tsx','apps/web/src/components/ui/KpiCard.tsx','apps/web/src/components/ui/DataTable.tsx','apps/web/src/components/ui/Pagination.tsx','apps/web/src/components/ui/Input.tsx','apps/web/src/components/ui/Select.tsx') },
]

const reviewPrompt = (u) => `<role>
Ты — старший аудитор ПО финансового и бухгалтерского учёта. Это деньги реальных клиентов: пропущенный дефект (ложноотрицательный) стоит дороже, чем лишний сигнал. Твой вывод — это данные для реестра дефектов, а не сообщение человеку.
</role>

<context>
${APP}
</context>

<unit>
Единица аудита: ${u.id} (ветка ${u.branch}).
ФОКУС ПРОВЕРКИ: ${u.focus}
</unit>

<files>
Ты ОБЯЗАН открыть и прочитать ЦЕЛИКОМ каждый из этих файлов перед любым суждением (используй Read). Читай также смежные файлы (импорты, схему Prisma packages/db/prisma/schema.prisma), если нужно для вывода. Никогда не делай выводов о коде, который не открыл.
${u.files.map((p, i) => `${i + 1}. ${p}`).join('\n')}
</files>

<what_to_check>
Найди РЕАЛЬНЫЕ дефекты с доказательством из кода (не догадки, не «можно улучшить»). Категории по приоритету для фин-ПО:
1. Корректность денег и расчётов (Decimal/half-up, без float, знаки, округление, R1–R5, агрегации, границы периодов).
2. Конкурентность и транзакции (достаточность локов FOR UPDATE под READ COMMITTED, окна гонок, атомарность, lost update, идемпотентность).
3. Мультитенантность и безопасность (cross-tenant чтение/запись, обход auth, валидация на границе, утечки в ошибках, path traversal/инъекции).
4. Контракт и флоу (коды ответов, инвалидация кэша ведущая к неверным деньгам на экране, неподключённые действия).
${SEV}
</what_to_check>

<rules>
- Сообщай ТОЛЬКО дефекты, которые можешь обосновать цитатой кода. Не предлагай рефакторинг ради красоты, не выдумывай гипотетические сценарии, которые код уже предотвращает.
- Если файл чист — это нормально, не выдавливай находки.
- Для каждой находки укажи точные file и line.
- filesRead должен перечислить ВСЕ реально прочитанные файлы (доказательство охвата).
</rules>

<output_format>
Верни строго JSON по схеме (StructuredOutput): unitId="${u.id}", filesRead[], findings[].
</output_format>`

const verifyPrompt = (finding, unit) => `<role>
Ты — независимый скептик-верификатор в аудите ПО финансового учёта. Твоя задача — ОПРОВЕРГНУТЬ заявленный дефект, открыв реальный код. По умолчанию refuted=true, если не можешь доказать реальность дефекта цитатой кода. Не доверяй формулировке находки — проверяй сам.
</role>

<context>
${APP}
</context>

<claimed_defect>
Файл: ${finding.file}${finding.line ? ':' + finding.line : ''}
Severity (заявлена): ${finding.severity}
Категория: ${finding.category}
Заголовок: ${finding.title}
Доказательство автора: ${finding.evidence}
Почему важно: ${finding.why_it_matters}
Единица: ${unit.id} (ветка ${unit.branch})
</claimed_defect>

<task>
1. Открой указанный файл (Read) и все смежные, нужные чтобы проверить (схема Prisma, вызывающий код, тесты, которые могли бы это покрывать).
2. Попытайся опровергнуть: возможно, код уже защищён (лок, guard, валидация, транзакция, проверка), возможно поведение корректно по дизайну (cash-basis, R1–R5, soft-delete), возможно автор неверно понял поток.
3. Реши: refuted=true (дефект НЕ реален / уже предотвращён / по дизайну) или refuted=false (дефект подтверждён, с доказательством из кода).
4. Скорректируй severity, если завышена/занижена (adjusted_severity, или NotADefect).
</task>

<rules>
Никаких догадок. Только то, что видно в открытом коде. Если сомневаешься и не можешь доказать реальность — refuted=true.
</rules>

<output_format>
Верни строго JSON по схеме (StructuredOutput): refuted, reason (с цитатой кода), adjusted_severity.
</output_format>`

// ── Pipeline: review → verify (по находке; Critical/High — 3 голоса, иначе 1) ──
const results = await pipeline(
  UNITS,
  (u) => agent(reviewPrompt(u), { label: `review:${u.id}`, phase: 'Review', effort: 'high', schema: FINDINGS_SCHEMA }),
  async (review, u) => {
    if (!review || !review.findings || review.findings.length === 0) {
      return { unitId: u.id, branch: u.branch, filesRead: review?.filesRead ?? [], confirmed: [], reviewedCount: 0 }
    }
    const verified = await parallel(
      review.findings.map((finding) => async () => {
        const isHot = finding.severity === 'Critical' || finding.severity === 'High'
        const voters = isHot ? 3 : 1
        const votes = await parallel(
          Array.from({ length: voters }, (_, i) => () =>
            agent(verifyPrompt(finding, u) + `\n<!-- независимый голос ${i + 1}/${voters} -->`, {
              label: `verify:${u.id}:${finding.severity}`,
              phase: 'Verify',
              effort: isHot ? 'high' : 'medium',
              schema: VERDICT_SCHEMA,
            })
          )
        )
        const valid = votes.filter(Boolean)
        const notRefuted = valid.filter((v) => !v.refuted).length
        const real = valid.length > 0 && notRefuted >= Math.ceil(valid.length / 2)
        // итоговая severity = большинство adjusted (берём первую не-NotADefect при подтверждении)
        const adj = valid.find((v) => !v.refuted)?.adjusted_severity
        return {
          ...finding,
          verdict: { real, votes: valid.length, notRefuted, severity: real ? (adj && adj !== 'NotADefect' ? adj : finding.severity) : 'NotADefect', reasons: valid.map((v) => v.reason) },
        }
      })
    )
    const confirmed = verified.filter(Boolean).filter((x) => x.verdict.real)
    return { unitId: u.id, branch: u.branch, filesRead: review.filesRead, confirmed, reviewedCount: review.findings.length }
  }
)

const clean = results.filter(Boolean)
const allConfirmed = clean.flatMap((r) => r.confirmed.map((c) => ({ ...c, unitId: r.unitId, branch: r.branch })))
const bySev = (s) => allConfirmed.filter((x) => x.verdict.severity === s).length
const filesReadCount = clean.flatMap((r) => r.filesRead || []).filter((v, i, a) => a.indexOf(v) === i).length

log(`Аудит завершён: единиц ${clean.length}, файлов прочитано ${filesReadCount}, найдено сырых ${clean.reduce((a, r) => a + r.reviewedCount, 0)}, подтверждено ${allConfirmed.length} (Critical ${bySev('Critical')}, High ${bySev('High')}, Medium ${bySev('Medium')}, Low ${bySev('Low')})`)

return {
  summary: {
    units: clean.length,
    filesRead: filesReadCount,
    rawFindings: clean.reduce((a, r) => a + r.reviewedCount, 0),
    confirmed: allConfirmed.length,
    bySeverity: { Critical: bySev('Critical'), High: bySev('High'), Medium: bySev('Medium'), Low: bySev('Low') },
  },
  perUnit: clean.map((r) => ({ unitId: r.unitId, branch: r.branch, filesRead: (r.filesRead || []).length, confirmed: r.confirmed.length })),
  findings: allConfirmed,
}