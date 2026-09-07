# Стандарт экрана: из чего собирается любой список, карточка и форма

Дата: 2026-09-06. Эталон — «Операции» (`apps/web/src/app/(app)/transactions/page.tsx`).
Всё, что ниже, обязательно для каждого экрана; исключения — только те, что
названы явно. Документ короткий нарочно: это чек-лист, а не история решений
(история — в `ui-consistency-2026-09.md` и `ux-audit-handsfree-2026-08-13.md`).

## Список (реестр сущностей)

Сверху вниз, в этом порядке:

1. **`PageHeader`** — `title`, при необходимости `description` (одно предложение:
   что это и зачем), `actions` — главная кнопка «Добавить». Никаких абзацев
   описания в теле экрана.
2. **`KpiRow` + `KpiCard`** — итоги по текущему разрезу, если у экрана есть
   деньги. Значение — `<Money>`, не строка.
3. **`FilterBar`** с полями `FilterField`: `SearchField` (ref → `useListHotkeys`,
   «/» ставит курсор), `PeriodSelect` (+ `DateRangeFields`, если период
   произвольный), измерения `Select` (короткие статичные списки) /
   `Combobox` (сущности с поиском), последним — `Button variant="ghost" size="sm"`
   «Сброс».
4. **`DataTable`** — единственная таблица приложения. Обязательны
   `loading`, `error` + `onRetry`, `empty` (`EmptyState` с `action`),
   `mobileCards`. Для дат — `groupBy` + `renderGroupHeader`; для денег —
   `footer`; для курсорной пагинации — `hasMore` / `onLoadMore` /
   `loadingMore` (или `LoadMore` под своим списком). Сырой `<table>` запрещён.
5. **Окно** сущности — `Modal`; крупные сущности (заказ, закупка) открываются
   по адресу через `useUrlDialog`, форма создания — по `?new=1`
   (`useCreateFromUrl`).

Состояние фильтров — в адресе через `useUrlFilters(codec)`; период, который
человек выбирает надолго, — ещё и в `localStorage` (`lib/storage`). Клавиши —
`useListHotkeys({ searchRef, onNew })`.

«Нет активного пространства» экраны **не рисуют**: это делает `WorkspaceGate`
в каркасе (загрузка / ошибка / пусто). Экран лишь страхуется
`if (!current) return null;`.

## Форма

- Только `Modal` (`ModalContent size=` md — справочник, lg — операция,
  xl/2xl — документ). `Dialog` и `Sheet` для форм не используются.
- `dirty={…}` у `Modal` — обязателен у любой формы с вводом: закрытие с
  несохранённым спрашивает «Закрыть без сохранения?». Кнопки «Отмена» и
  крестик — через `ModalClose`, чтобы идти тем же путём.
- `onConfirm` у `ModalContent` — главное действие для Cmd/Ctrl+Enter.
- Каждое поле — в `FormField` (label, hint, error, aria). Деньги —
  `MoneyInput`; количество — `Input inputMode="decimal"`; флажки — `Checkbox`;
  даты — `Input type="date"` со значениями из `todayInput()` /
  `toLocalDateInput()` и обратно через `fromLocalDateInput()` (UTC+5, никаких
  `toISOString().slice(0, 10)` и `T12:00:00.000Z` руками).
- Удаление — `ConfirmDialog`.

## Деньги, статусы, даты

- Показ суммы — `<Money value tone>`; `formatRub` — только в строках
  (тосты, подписи, `aria-label`, подсказки recharts). Арифметика — `D/add/sub`
  из `@construct/shared`, никогда `Number(...) + Number(...)`.
- Статус в таблице — `StatusDot`, в карточке документа — `StatusStamp`.
  `Badge` в таблицах запрещён (решение №15). Словарь статуса живёт в одном
  файле (`components/orders/order-shared.tsx`, `lib/labels.ts`) — копировать
  нельзя, импортировать.
- Даты — `lib/dates.ts` (`formatDate`, `formatDateTime`, `formatDayLabel`) и
  `lib/periods.ts`. Свои `toLocaleDateString` не заводить.

## Карточка сущности

`PageHeader` (с ссылкой назад в `description` или крошками) → `KpiRow` →
таблицы связанных сущностей на `DataTable` (строки кликабельны, ведут в окно
или на экран сущности) → действия в `actions`.

## Каркас

Навигация, шапка, таб-бар и меню собираются из тех же примитивов, что и
экраны: `Button`, `Menu`, `CountBadge`, `Select`/`Combobox`, `Modal` (на
телефоне — панель снизу). Свои стили для пунктов меню, чипов и кнопок в
каркасе не пишутся.

## Как проверять

Перед PR по экрану: `pnpm --filter @construct/web typecheck && pnpm --filter
@construct/web lint`, затем стенд: состояния загрузки / ошибки / пусто,
мобильная ширина (375px), клавиши «/», «n», Cmd+Enter, гвард закрытия формы.
