'use client';

import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { D, add, formatPhone, formatRub } from '@construct/shared';
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
} from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { Money } from '@/components/ui/Money';
import { SectionCard } from '@/components/ui/SectionCard';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useMonthSummary } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { cn } from '@/lib/cn';
import {
  barParts,
  businessMonth,
  deltaText,
  formatPer100,
  formatRubShort,
  isMonth,
  lastClosedMonth,
  monthName,
  monthTitle,
  perOrderSteps,
  shiftMonth,
} from '@/lib/month-summary';
import { plural } from '@/lib/plural';
import { txDrilldownHref } from '@/lib/tx-filters';
import { flatCodec } from '@/lib/url-codec';
import type { MonthSummaryGroup, MonthSummaryReport } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];

// Месяц живёт в адресе; пусто — прошлый законченный месяц (в адрес не пишется).
const DEFAULTS = { month: '' };
const CODEC = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function MonthSummaryPage() {
  return (
    <Suspense>
      <MonthSummaryView />
    </Suspense>
  );
}

/**
 * «Итоги месяца» — ОПиУ одного месяца простыми словами для владельца: сколько
 * продали, сколько ушло на комплектующие и расходы, что осталось, из каждых
 * 100 ₽ и на один компьютер. Цифры — те же, что в ОПиУ (бэкенд считает поверх
 * него и сверяет тождество до копейки), без слов «операционные» и «валовая».
 */
function MonthSummaryView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);
  const defaultMonth = lastClosedMonth();
  const currentMonth = businessMonth();
  const month = isMonth(filters.month) ? filters.month : defaultMonth;
  const setMonth = (next: string) => setFilters({ month: next === defaultMonth ? '' : next });
  const query = useMonthSummary(wsId, month);

  if (!wsId) return null;
  const r = query.data?.month === month ? query.data : undefined;

  return (
    <>
      <FilterBar>
        <FilterField label="Месяц">
          <div className="flex h-9 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[140px] text-center text-sm font-medium text-foreground">
              {monthTitle(month)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMonth(shiftMonth(month, 1))}
              disabled={month >= currentMonth}
              aria-label="Следующий месяц"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </FilterField>
        {month !== defaultMonth && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULTS)} className="self-end">
            Прошлый месяц
          </Button>
        )}
        {month === currentMonth && (
          <span className="self-end pb-2 text-xs text-muted-foreground">
            месяц ещё идёт — цифры будут меняться
          </span>
        )}
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Сколько продали, сколько ушло на комплектующие и расходы и что осталось. Цифры те же,
          что в ОПиУ: продажи — по закрытым заказам, налог — начисленный за месяц.
        </p>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : !r ? (
          <KpiRow loading count={3}>
            {null}
          </KpiRow>
        ) : (
          <MonthSummaryBody r={r} />
        )}
      </div>
    </>
  );
}

function MonthSummaryBody({ r }: { r: MonthSummaryReport }) {
  const ordersHref = `/orders?status=DONE&closedFrom=${encodeURIComponent(r.from)}&closedTo=${encodeURIComponent(r.to)}`;
  const empty =
    r.ordersClosed === 0 &&
    [r.sales, r.components, r.expenses, r.otherIncome, r.net].every((v) => D(v).isZero());
  const pendingChecks = pendingCount(r);

  return (
    <>
      {!r.checks.identity.ok && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <strong>Цифры не сходятся на {formatRub(r.checks.identity.diff)}.</strong> Продажи минус
          комплектующие и расходы плюс прочие доходы не равны чистой прибыли ОПиУ. Отчёт показан
          как есть — это ошибка расчёта, сообщите о ней разработчику.
        </div>
      )}

      {empty ? (
        <Card>
          <EmptyState
            icon={BarChart3}
            title={`За ${monthName(r.month)} нет ни продаж, ни расходов`}
            hint="Выберите другой месяц стрелками."
          />
        </Card>
      ) : (
        <>
          <Headline r={r} ordersHref={ordersHref} />
          {pendingChecks > 0 && (
            <p className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Цифры месяца пока неокончательные:{' '}
                <a href="#readiness" className="underline underline-offset-4">
                  {pendingChecks} {plural(pendingChecks, 'проверка', 'проверки', 'проверок')} в
                  «Готовности месяца»
                </a>{' '}
                {plural(pendingChecks, 'требует', 'требуют', 'требуют')} внимания.
              </span>
            </p>
          )}
          <Per100Section r={r} ordersHref={ordersHref} />
          <PerOrderSection r={r} />
        </>
      )}

      <ReadinessSection r={r} />
    </>
  );
}

// ───────────────────────────── Три цифры ─────────────────────────────

function Headline({ r, ordersHref }: { r: MonthSummaryReport; ordersHref: string }) {
  const lines = (...parts: (string | null)[]) => (
    <>
      {parts
        .filter((p): p is string => !!p)
        .map((p, i) => (
          <div key={i}>{p}</div>
        ))}
    </>
  );
  // Минус словом, а не скобками: «убыток 0,4 ₽ со 100 ₽ продаж» читается сразу.
  const per100 = (v: string | null, negative: string) =>
    v === null
      ? null
      : D(v).lt(0)
        ? `${negative} ${formatPer100(D(v).abs().toFixed(1))} ₽ со 100 ₽ продаж`
        : `${formatPer100(v)} ₽ со 100 ₽ продаж`;
  return (
    <KpiRow count={3} className="stagger">
      <KpiCard
        label="Продали"
        value={<Money value={r.sales} />}
        href={ordersHref}
        hint={lines(
          `${r.ordersClosed} ${plural(r.ordersClosed, 'закрытый заказ', 'закрытых заказа', 'закрытых заказов')}`,
          deltaText(r.sales, r.prev.sales, r.prev.month),
        )}
      />
      <KpiCard
        label="Наценка"
        value={<Money value={r.markup} />}
        tone={D(r.markup).gte(0) ? 'positive' : 'negative'}
        hint={lines(
          per100(r.markupPct, 'минус'),
          deltaText(r.markup, r.prev.markup, r.prev.month),
        )}
      />
      <KpiCard
        label="Чистая прибыль"
        value={<Money value={r.net} />}
        tone={D(r.net).gte(0) ? 'positive' : 'negative'}
        hint={lines(per100(r.netPct, 'убыток'), deltaText(r.net, r.prev.net, r.prev.month))}
      />
    </KpiRow>
  );
}

// ─────────────────────── Из каждых 100 ₽ продаж ───────────────────────

interface Row {
  key: string;
  name: string;
  note?: string;
  href?: string;
  amount: string;
  per100: string | null;
  perOrder: string | null;
  prev: string;
  kind: 'sales' | 'cost' | 'other' | 'net';
}

/** Куда ведёт группа: налог — в «Налог», остальное — в операции месяца группы. */
function groupHref(r: MonthSummaryReport, g: MonthSummaryGroup): string | undefined {
  if (g.taxAccrual) return '/tax';
  if (g.categoryIds.length === 0 && g.uncategorizedKinds.length === 0) return undefined;
  return txDrilldownHref({
    from: r.from,
    to: r.to,
    type: 'EXPENSE',
    categoryIds: g.categoryIds,
    uncategorizedKinds: g.uncategorizedKinds,
  });
}

function groupNote(g: MonthSummaryGroup): string | undefined {
  if (g.taxAccrual) return 'АУСН за этот месяц';
  if (g.categoryIds.length === 0 && g.uncategorizedKinds.length > 0) return 'операции без статьи';
  return undefined;
}

function buildRows(r: MonthSummaryReport, ordersHref: string): Row[] {
  const rows: Row[] = [
    {
      key: 'sales',
      name: 'Продали',
      href: ordersHref,
      amount: r.sales,
      per100: r.per100 ? '100.0' : null,
      perOrder: r.perOrder?.sales ?? null,
      prev: r.prev.sales,
      kind: 'sales',
    },
    {
      key: 'components',
      name: 'Комплектующие',
      note: 'закупка проданного, гарантия, списания',
      href: ordersHref,
      amount: r.components,
      per100: r.per100?.components ?? null,
      perOrder: r.perOrder?.components ?? null,
      prev: r.prev.components,
      kind: 'cost',
    },
    ...r.groups.map(
      (g): Row => ({
        key: `group:${g.key}`,
        name: g.name,
        note: groupNote(g),
        href: groupHref(r, g),
        amount: g.amount,
        per100: g.per100,
        perOrder: g.perOrder,
        prev: g.prevAmount,
        kind: 'cost',
      }),
    ),
  ];
  if (!D(r.otherIncome).isZero() || !D(r.prev.otherIncome).isZero()) {
    rows.push({
      key: 'other',
      name: 'Прочие доходы',
      note: 'добавляются к прибыли',
      amount: r.otherIncome,
      per100: r.per100?.otherIncome ?? null,
      perOrder: r.perOrder?.otherIncome ?? null,
      prev: r.prev.otherIncome,
      kind: 'other',
    });
  }
  rows.push({
    key: 'net',
    name: 'Чистая прибыль',
    amount: r.net,
    per100: r.netPct,
    perOrder: r.netPerOrder,
    prev: r.prev.net,
    kind: 'net',
  });
  return rows;
}

/** «+» перед прочими доходами: они прибавляются, а не вычитаются. */
const plus = (row: Row, value: string) => (row.kind === 'other' && D(value).gt(0) ? '+' : '');

function RowName({ row }: { row: Row }) {
  const strong = row.kind === 'sales' || row.kind === 'net';
  return (
    <div className="min-w-0">
      {row.href ? (
        <Link
          href={row.href as LinkHref}
          className={cn('hover:text-foreground hover:underline', strong && 'font-semibold')}
        >
          {row.name}
        </Link>
      ) : (
        <span className={cn(strong && 'font-semibold')}>{row.name}</span>
      )}
      {row.note && <div className="text-xs text-muted-foreground">{row.note}</div>}
    </div>
  );
}

function Per100Section({ r, ordersHref }: { r: MonthSummaryReport; ordersHref: string }) {
  const rows = buildRows(r, ordersHref);
  const bar = barParts(r);
  const prevLabel = `${monthTitle(r.prev.month)}`;

  const columns: Column<Row>[] = [
    { key: 'name', header: 'Статья', cell: (row) => <RowName row={row} /> },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (row) => (
        <span className={cn((row.kind === 'sales' || row.kind === 'net') && 'font-semibold')}>
          {plus(row, row.amount)}
          <Money value={row.amount} />
        </span>
      ),
    },
    {
      key: 'per100',
      header: '₽ из 100',
      align: 'right',
      cell: (row) =>
        row.per100 === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={cn('num', row.kind === 'net' && D(row.per100).lt(0) && 'text-destructive')}>
            {plus(row, row.per100)}
            {formatPer100(row.per100)}
          </span>
        ),
    },
    {
      key: 'perOrder',
      header: 'На один заказ',
      align: 'right',
      cell: (row) =>
        row.perOrder === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>
            {plus(row, row.perOrder)}
            <Money value={row.perOrder} decimals={0} />
          </span>
        ),
    },
    {
      key: 'prev',
      header: prevLabel,
      align: 'right',
      cell: (row) => <Money value={row.prev} tone="plain" className="text-muted-foreground" />,
    },
  ];

  const card = (row: Row) => (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <RowName row={row} />
        <span className={cn('shrink-0', (row.kind === 'sales' || row.kind === 'net') && 'font-semibold')}>
          {plus(row, row.amount)}
          <Money value={row.amount} />
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {row.per100 !== null && `${plus(row, row.per100)}${formatPer100(row.per100)} ₽ из 100 · `}
        {row.perOrder !== null && `${plus(row, row.perOrder)}${formatRub(row.perOrder, 0)} на заказ · `}
        {prevLabel}: {formatRub(row.prev)}
      </div>
    </div>
  );

  return (
    <SectionCard
      title="Из каждых 100 ₽ продаж"
      aside={`за ${monthName(r.month)} · ${r.ordersClosed} ${plural(r.ordersClosed, 'закрытый заказ', 'закрытых заказа', 'закрытых заказов')}`}
    >
      {bar ? (
        <div className="space-y-2 border-b border-border px-4 py-3">
          <p className="text-sm">
            Из каждых 100 ₽ продаж <strong className="num">{formatPer100(bar.components)} ₽</strong>{' '}
            ушло на комплектующие, <strong className="num">{formatPer100(bar.expenses)} ₽</strong> — на
            расходы,{' '}
            {D(bar.net).gte(0) ? (
              <>
                <strong className="num">{formatPer100(bar.net)} ₽</strong> осталось прибылью.
              </>
            ) : (
              <>
                а убыток — <strong className="num text-destructive">{formatPer100(D(bar.net).abs().toFixed(1))} ₽</strong>.
              </>
            )}
          </p>
          <div
            className="flex h-4 w-full overflow-hidden rounded-sm bg-border/60"
            role="img"
            aria-label={`Комплектующие ${formatPer100(bar.components)} ₽, расходы ${formatPer100(bar.expenses)} ₽, ${D(bar.net).gte(0) ? 'прибыль' : 'убыток'} ${formatPer100(D(bar.net).abs().toFixed(1))} ₽ из 100 ₽`}
          >
            <div className="h-full bg-primary" style={{ width: `${bar.widths[0]}%` }} />
            <div className="h-full bg-warning" style={{ width: `${bar.widths[1]}%` }} />
            <div className="h-full bg-success" style={{ width: `${bar.widths[2]}%` }} />
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <Legend color="bg-primary" label="Комплектующие" value={bar.components} />
            <Legend
              color="bg-warning"
              label={D(r.otherIncome).isZero() ? 'Расходы' : 'Расходы за вычетом прочих доходов'}
              value={bar.expenses}
            />
            {D(bar.net).gte(0) ? (
              <Legend color="bg-success" label="Прибыль" value={bar.net} />
            ) : (
              <li className="text-destructive">Убыток {formatPer100(D(bar.net).abs().toFixed(1))} ₽</li>
            )}
          </ul>
        </div>
      ) : (
        <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          Продаж за {monthName(r.month)} нет — делить расходы не на что.
        </p>
      )}
      <DataTable data={rows} columns={columns} rowKey={(row) => row.key} mobileCards={card} />
    </SectionCard>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className={cn('inline-block h-2.5 w-2.5 rounded-sm', color)} />
      <span>
        {label} <span className="num text-foreground">{formatPer100(value)} ₽</span>
      </span>
    </li>
  );
}

// ───────────────────────── На один компьютер ─────────────────────────

function PerOrderSection({ r }: { r: MonthSummaryReport }) {
  const steps = perOrderSteps(r);
  return (
    <SectionCard
      title="На один компьютер"
      aside={`закрыто заказов: ${r.ordersClosed}`}
    >
      {steps ? (
        <>
          <div className="divide-y divide-border/60 text-sm">
            {steps.map((s) => (
              <div
                key={s.key}
                className={cn(
                  'flex items-baseline justify-between gap-3 px-4 py-2.5',
                  s.total && 'bg-sunken',
                )}
              >
                <span className={cn('min-w-0 truncate', s.total && 'font-medium')}>
                  <span className="inline-block w-5 text-muted-foreground">{s.op}</span>
                  {s.label}
                </span>
                <Money
                  value={s.value}
                  decimals={0}
                  tone={s.total ? 'auto' : 'plain'}
                  className={cn('shrink-0', s.total && 'font-semibold')}
                />
              </div>
            ))}
          </div>
          <p className="px-4 py-2.5 text-xs text-muted-foreground">
            Все расходы месяца поделены поровну на закрытые заказы, поэтому строки складываются:
            продажа − комплектующие − расходы + прочие доходы = прибыль.
          </p>
        </>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          За {monthName(r.month)} не закрыто ни одного заказа — считать на один компьютер не из чего.
        </p>
      )}
    </SectionCard>
  );
}

// ───────────────────────── Готовность месяца ─────────────────────────

function pendingCount(r: MonthSummaryReport): number {
  return [
    !r.checks.identity.ok,
    r.checks.inbox.count > 0,
    r.checks.ordersWithoutCost.count > 0,
    r.checks.openPrepaid.count > 0,
  ].filter(Boolean).length;
}

function CheckRow({
  status,
  children,
}: {
  status: 'ok' | 'check' | 'error';
  children: ReactNode;
}) {
  const view = {
    ok: { icon: CircleCheck, word: 'Готово', tone: 'text-success' },
    check: { icon: AlertTriangle, word: 'Проверить', tone: 'text-warning' },
    error: { icon: AlertTriangle, word: 'Ошибка', tone: 'text-destructive' },
  }[status];
  const Icon = view.icon;
  return (
    <li className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:gap-3">
      <span className={cn('inline-flex w-[104px] shrink-0 items-center gap-1.5 font-medium', view.tone)}>
        <Icon className="h-4 w-4" aria-hidden />
        {view.word}
      </span>
      <div className="min-w-0 space-y-1">{children}</div>
    </li>
  );
}

function orderLabel(o: MonthSummaryReport['checks']['ordersWithoutCost']['orders'][number]): string {
  return o.clientName ?? (o.phone ? formatPhone(o.phone) : o.number);
}

/** Сколько заказов без закупки показываем ссылками; остальные — «и ещё N». */
const ORDERS_SHOWN = 10;

function ReadinessSection({ r }: { r: MonthSummaryReport }) {
  const { identity, inbox, ordersWithoutCost, openPrepaid } = r.checks;
  const pending = pendingCount(r);
  const m = monthName(r.month);
  return (
    <section id="readiness" className="scroll-mt-4">
      <SectionCard
        title="Готовность месяца"
        aside={pending === 0 ? 'всё готово' : `${pending} из 4 — проверить`}
      >
        <ul className="divide-y divide-border/60">
          <CheckRow status={inbox.count === 0 ? 'ok' : 'check'}>
            {inbox.count === 0 ? (
              <p>Входящие за {m} разобраны.</p>
            ) : (
              <>
                <p>
                  Во «Входящих» {inbox.count} {plural(inbox.count, 'строка', 'строки', 'строк')} за {m} на{' '}
                  {formatRubShort(add(inbox.income, inbox.expense).toFixed(2))} (приходы{' '}
                  {formatRubShort(inbox.income)}, расходы {formatRubShort(inbox.expense)}) — пока они не
                  разобраны, цифры месяца неполные.
                </p>
                <Link href={'/inbox' as LinkHref} className="text-primary underline-offset-4 hover:underline">
                  Открыть «Входящие»
                </Link>
              </>
            )}
          </CheckRow>

          <CheckRow status={ordersWithoutCost.count === 0 ? 'ok' : 'check'}>
            {ordersWithoutCost.count === 0 ? (
              <p>
                {r.ordersClosed === 0
                  ? `Закрытых за ${m} заказов нет.`
                  : `У всех заказов, закрытых за ${m}, есть закупочная цена.`}
              </p>
            ) : (
              <>
                <p>
                  У {ordersWithoutCost.count}{' '}
                  {plural(ordersWithoutCost.count, 'заказа', 'заказов', 'заказов')} нет закупочной цены —
                  комплектующие по ним не посчитаны, и наценка месяца завышена:
                </p>
                <p className="flex flex-wrap gap-x-3 gap-y-1">
                  {ordersWithoutCost.orders.slice(0, ORDERS_SHOWN).map((o) => (
                    <Link
                      key={o.id}
                      href={`/orders?order=${o.id}` as LinkHref}
                      className="text-primary underline-offset-4 hover:underline"
                      title={o.number}
                    >
                      {orderLabel(o)}
                    </Link>
                  ))}
                  {ordersWithoutCost.count > ORDERS_SHOWN && (
                    <span className="text-muted-foreground">
                      и ещё {ordersWithoutCost.count - ORDERS_SHOWN}
                    </span>
                  )}
                </p>
              </>
            )}
          </CheckRow>

          <CheckRow status={openPrepaid.count === 0 ? 'ok' : 'check'}>
            {openPrepaid.count === 0 ? (
              <p>Открытых заказов с предоплатой нет.</p>
            ) : (
              <>
                <p>
                  Предоплаты по {openPrepaid.count}{' '}
                  {plural(openPrepaid.count, 'открытому заказу', 'открытым заказам', 'открытым заказам')}:{' '}
                  {formatRubShort(openPrepaid.paid)}. Деньги уже получены, но в продажи{' '}
                  {openPrepaid.count === 1
                    ? 'заказ попадёт только после закрытия. Если он уже выдан — закройте его.'
                    : 'заказы попадут только после закрытия. Если какие-то уже выданы — закройте их.'}
                </p>
                <Link
                  href={'/orders?status=OPEN' as LinkHref}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Открытые заказы
                </Link>
              </>
            )}
          </CheckRow>

          <CheckRow status={identity.ok ? 'ok' : 'error'}>
            {identity.ok ? (
              <p>Цифры сходятся с ОПиУ до копейки.</p>
            ) : (
              <p className="text-destructive">
                Цифры не сходятся с ОПиУ на {formatRub(identity.diff)} — отчёт показан как есть,
                сообщите о расхождении разработчику.
              </p>
            )}
          </CheckRow>
        </ul>
      </SectionCard>
    </section>
  );
}
