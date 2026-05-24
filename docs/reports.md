# Construct v6 — отчёты и экспорт

Фаза 4. Все ручки workspace-scoped, JWT + WorkspaceGuard.

## Эндпоинты

```
GET /workspaces/:wsId/reports/pnl
   ?preset=this-month|prev-month|this-quarter|prev-quarter|this-year|prev-year|ytd|last-30d|last-90d|last-12m
   &from=YYYY-MM-DD&to=YYYY-MM-DD            (вместо preset)
   &groupBy=month|quarter
   &compareWith=none|prev|yoy|custom
   &compareFrom=...&compareTo=...            (для compareWith=custom)

GET /workspaces/:wsId/reports/cashflow?<period>&accountId=<id?>
GET /workspaces/:wsId/reports/by-category?<period>&type=INCOME|EXPENSE|ALL
GET /workspaces/:wsId/reports/by-counterparty?<period>&type=INCOME|EXPENSE|ALL

GET /workspaces/:wsId/reports/:kind/export?format=csv|xlsx|pdf&<те же query>
   :kind ∈ {pnl, cashflow, by-category, by-counterparty}
```

`<period>` — комбинация `preset` или `from`+`to` (см. перечень пресетов выше).

### Сравнение периодов

`compareWith` управляет вторым рядом в `PnlReport.comparison`:
- `none` — только основной период
- `prev` — диапазон такой же длины, заканчивающийся прямо перед `from` основного
- `yoy` — тот же диапазон, сдвинутый на 1 год назад
- `custom` — берётся `compareFrom`/`compareTo`

### Формат ответа (P&L)

```ts
{
  primary: {
    period: { from, to },                       // ISO
    buckets: [{ label: '2026-01', from, to,
      income: '1234.56', expense, net,
      byCategory: [{ categoryId, categoryName, income, expense }, ...]
    }, ...],
    totals: { ... }
  },
  comparison: null | { ... }
}
```

`buckets` нарезаются по `groupBy`: месяцы (`enumerateMonths`) или кварталы (`enumerateQuarters`).

### Cash flow

`series` — массив по каждому аккаунту workspace'а (или одному, если `accountId` указан).
Каждый аккаунт содержит `openingBalance` на начало периода (учитывает исторические транзакции
до `period.from`) и точки `points` по месяцам с running balance.

### Breakdown

`rows` отсортированы по `total` desc. `share` — доля от соответствующего знаменателя
(`totalIncome` для type=INCOME, `totalExpense` для EXPENSE, сумма обоих для ALL).

## Экспорт

Бэк формирует универсальный `ReportTable` (`apps/api/src/reports/export/report-table.ts`)
с колонками типов `text|money|number|date|percent` и тремя рендерами:

| Формат | Рендер                                  | Mime                                |
|--------|-----------------------------------------|-------------------------------------|
| csv    | вручную, BOM UTF-8, RFC 4180            | `text/csv; charset=utf-8`           |
| xlsx   | `exceljs` со стилями + numFmt           | `application/vnd.openxmlformats-…`  |
| pdf    | `jspdf` + `jspdf-autotable`             | `application/pdf`                   |

Для PDF подключён шрифт `DejaVuSans` из пакета `dejavu-fonts-ttf` (~700 КБ TTF, base64 в VFS
jsPDF) — кириллица поддерживается. Кэшируется в памяти процесса после первого вызова.

## Авто-маппинг категорий

Модель `CategoryRule(workspaceId, keyword, categoryId, priority, isActive)`. CRUD под
`/workspaces/:wsId/category-rules`.

Чистая функция `applyRules(rules, { description, counterpartyName })` (`apps/api/src/category-rule/matcher.ts`):
- Склеивает description + counterparty, приводит к lowercase
- Substring-проверка по trim'нутому lowercase keyword
- Победитель: max priority, при равенстве — большая длина keyword

Применяется в `ImportService.preview()` — каждая строка получает `suggestedCategoryId`.
Пользователь во фронте может его перебить, в `commit` уходит выбранный `categoryId`.

## Frontend

Раздел `/reports` с подвкладками:

| Маршрут                       | Что                                              |
|-------------------------------|--------------------------------------------------|
| `/reports`                    | P&L: stacked bars + cards итогов + таблица       |
| `/reports/cashflow`           | Line chart по счетам + таблицы по аккаунтам      |
| `/reports/categories`         | Pie топ-10 + таблица всех                        |
| `/reports/counterparties`     | Таблица по контрагентам                          |
| `/reports/rules`              | CRUD правил авто-маппинга                        |

Графики через `recharts`. Период выбирается единым `PeriodPicker` (8 пресетов + custom).
Кнопки CSV/XLSX/PDF — обычные `<a>` со скачиваемой ссылкой `…/export?format=…`.

## Производительность

Пересчёт on-demand, без кэша (целевой объём — ≤ 5 тыс. транзакций в год у самозанятого).
Все агрегации идут по существующим индексам:
- `Transaction(workspaceId, date)` для cashflow и pnl слайсов
- `Transaction(workspaceId, categoryId, date)` и `(…, counterpartyId, date)` для breakdown
- `Transaction(workspaceId, type, date)` для openingBalance

Если объёмы вырастут — добавить materialized view или Redis-кэш на уровне controller'а.

## Тесты

```
17 src/reports/period.test.ts     # пресеты, custom, prev/yoy, enumerate months/quarters
 9 src/category-rule/matcher.test.ts  # applyRules priority/length
```

E2E против реальной БД не делалось — `/reports/rules` и графики проверяются вручную.
