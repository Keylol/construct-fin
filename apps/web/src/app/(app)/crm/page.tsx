'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Handshake, RotateCcw, Plus, ArrowRight, ViewOff } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCrmDiscrepancies,
  useCreateOrderFromDeal,
  useCrmConnection,
  useCrmDeals,
  useCrmSummary,
  useDismissCrmDeal,
  useSyncCrm,
  useUnlinkCrmDeal,
} from '@/hooks/useCrm';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import { flatCodec } from '@/lib/url-codec';
import { isOwnerLike } from '@/lib/roles';
import { formatDate, formatDateTime } from '@/lib/dates';
import { plural } from '@/lib/plural';
import { formatRub } from '@construct/shared';
import type { CrmDeal, CrmDealsTab } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { KpiRow } from '@/components/ui/KpiRow';
import { KpiCard } from '@/components/ui/KpiCard';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { SearchField } from '@/components/ui/SearchField';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { StatusDot } from '@/components/ui/StatusDot';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import { ConnectCrmModal } from '@/components/crm/ConnectCrmModal';
import { CrmSettingsModal } from '@/components/crm/CrmSettingsModal';
import { LinkOrderModal } from '@/components/crm/LinkOrderModal';
import { MatchOrdersModal } from '@/components/crm/MatchOrdersModal';
import { DiscrepancyList } from '@/components/crm/DiscrepancyList';

// Вкладка, поиск и этап — в адресе: ссылку «ждут заказа» можно скинуть оператору.
const DEFAULTS = { tab: 'waiting', q: '', statusId: '' };
const FILTERS = flatCodec(DEFAULTS);

/**
 * Вкладки экрана: четыре вкладки списка сделок плюс «Расхождения» — она не
 * фильтр сделок, а сверка обеих сторон, поэтому живёт только во фронте.
 */
type ScreenTab = CrmDealsTab | 'discrepancies';

const TAB_HINTS: Record<ScreenTab, string> = {
  waiting:
    'Сделки на выбранных этапах воронки, ещё не заведённые в учёт. «Завести заказ» создаёт заказ с клиентом по телефону; «Привязать» — к уже существующему.',
  linked: 'Сделки, у которых есть заказ в учёте. Отвязать можно, если связь ошибочна.',
  all: 'Все открытые сделки наблюдаемой воронки, включая этапы, не отмеченные как «ждут заказа».',
  dismissed: 'Сделки, отмеченные «не учитывать»: тесты, дубли, отказы. Возврат — одной кнопкой.',
  discrepancies:
    'Что потерялось между amoCRM и учётом: продажа без заказа, закрытая сделка с недоплатой, закрытый заказ с открытой сделкой.',
};

const EMPTY: Record<CrmDealsTab, { title: string; hint: string }> = {
  waiting: {
    title: 'Все сделки заведены',
    hint: 'Новые появятся здесь после ближайшей синхронизации (раз в 10 минут) или по кнопке «Обновить».',
  },
  linked: {
    title: 'Привязанных сделок нет',
    hint: 'Заведите заказ из сделки или привяжите её к существующему — связь появится здесь.',
  },
  all: { title: 'Открытых сделок нет', hint: 'Нажмите «Обновить», если в amoCRM они точно есть.' },
  dismissed: {
    title: 'Отложенных сделок нет',
    hint: 'Сюда попадают сделки, отмеченные «не учитывать».',
  },
};

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function CrmPage() {
  return (
    <Suspense>
      <CrmView />
    </Suspense>
  );
}

function CrmView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const isOwner = isOwnerLike(current?.role);

  const connection = useCrmConnection(wsId);
  const summary = useCrmSummary(wsId);
  const [filters, setFilters] = useUrlFilters(FILTERS);
  const tab = (
    ['waiting', 'linked', 'all', 'dismissed', 'discrepancies'].includes(filters.tab)
      ? filters.tab
      : 'waiting'
  ) as ScreenTab;
  const dealsTab: CrmDealsTab = tab === 'discrepancies' ? 'waiting' : tab;
  // Сверка — не список сделок: её данные тянет отдельная вкладка, а счётчик в
  // заголовке нужен всегда, чтобы про расхождения не забывали.
  const discrepancies = useCrmDiscrepancies(wsId);
  const failingCount = (discrepancies.data?.checks ?? []).filter((c) => c.count > 0).length;
  const deals = useCrmDeals(wsId, {
    tab: dealsTab,
    search: filters.q || undefined,
    statusId: filters.statusId || undefined,
  });

  const sync = useSyncCrm(wsId ?? '');
  const createOrder = useCreateOrderFromDeal(wsId ?? '');
  const unlink = useUnlinkCrmDeal(wsId ?? '');
  const dismiss = useDismissCrmDeal(wsId ?? '');

  const [connecting, setConnecting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [linking, setLinking] = useState<CrmDeal | null>(null);
  const [matching, setMatching] = useState(false);
  const [dismissing, setDismissing] = useState<CrmDeal | null>(null);
  const [unlinking, setUnlinking] = useState<CrmDeal | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef });

  const conn = connection.data ?? null;
  const stages = useMemo(() => {
    const p = conn?.pipelines.find((x) => x.id === conn.pipelineId) ?? conn?.pipelines[0];
    return p?.statuses ?? [];
  }, [conn]);

  const items = useMemo(() => (deals.data?.pages ?? []).flatMap((p) => p.items), [deals.data]);
  const filtersActive = filters.q !== '' || filters.statusId !== '';

  if (!current || !wsId) return null;

  const runSync = () => {
    sync.mutate(undefined, {
      onSuccess: (r) => {
        if (r.fetched === 0) toast.success('Изменений в amoCRM нет');
        else
          toast.success(
            `Получено сделок: ${r.fetched} (новых ${r.created}, обновлённых ${r.updated})`,
          );
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Синхронизация не удалась'),
    });
  };

  const runCreateOrder = (deal: CrmDeal) => {
    createOrder.mutate(deal.id, {
      onSuccess: (r) =>
        toast.success(`Заказ ${r.orderNumber} заведён`, {
          description: 'Откройте карточку, чтобы уточнить позиции и привязать оплату.',
        }),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось завести заказ'),
    });
  };

  // Окна подключения и настроек рендерятся в ОБЕИХ ветках экрана одним и тем же
  // элементом: после «Подключить» ветка меняется с «не подключено» на список, и
  // если окно живёт только в первой, оно размонтируется раньше колбэка мутации
  // (TanStack его тогда не вызывает) — настройки не открывались. Так было на
  // проде 20.09.2026.
  const modals = (
    <>
      <ConnectCrmModal
        wsId={wsId}
        open={connecting}
        onClose={() => setConnecting(false)}
        onConnected={() => setSettingsOpen(true)}
      />
      {conn && (
        <CrmSettingsModal
          wsId={wsId}
          connection={conn}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );

  // ───────────────────── не подключено ─────────────────────
  if (!connection.isLoading && !conn) {
    return (
      <>
        <PageHeader title="amoCRM" />
        <div className="p-6">
          <EmptyState
            icon={Handshake}
            title="amoCRM не подключён"
            hint={
              isOwner
                ? 'Подключите аккаунт долгосрочным токеном — сделки начнут приходить сюда сами, раз в 10 минут.'
                : 'Подключить amoCRM может владелец в этом разделе.'
            }
            action={
              isOwner ? (
                <Button onClick={() => setConnecting(true)}>
                  <Plus className="h-4 w-4" />
                  Подключить amoCRM
                </Button>
              ) : undefined
            }
          />
        </div>
        {modals}
      </>
    );
  }

  const s = summary.data && summary.data.connected ? summary.data : null;

  const columns: Column<CrmDeal>[] = [
    {
      key: 'deal',
      header: 'Сделка',
      // w-full + max-w-0: в auto-layout <td> растягивается по самому длинному
      // имени сделки и таблица уезжает за край; с max-w-0 колонка берёт остаток
      // ширины, а имя усекается (полное — в title). Как в «Операциях».
      className: 'w-full max-w-0',
      cell: (d) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium" title={d.name}>
              {d.name}
            </span>
            {d.url && (
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-primary hover:underline"
                title="Открыть в amoCRM"
              >
                amo ↗
              </a>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="shrink-0 whitespace-nowrap">
              <StatusStamp
                tone={d.isClosed ? (d.isWon ? 'success' : 'muted') : 'primary'}
                label={d.statusName || '—'}
              />
            </span>
            <span className="whitespace-nowrap">{formatDate(d.remoteUpdatedAt)}</span>
            {d.responsibleName && <span className="truncate">{d.responsibleName}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Бюджет',
      align: 'right',
      cell: (d) => <Money value={d.price} />,
      className: 'w-[110px]',
    },
    {
      key: 'client',
      header: 'Клиент',
      cell: (d) => (
        <div className="min-w-0">
          <div className="truncate">
            {d.contactName ?? <span className="text-muted-foreground">—</span>}
          </div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {d.phone ?? 'телефона нет'}
          </div>
        </div>
      ),
      className: 'w-[170px]',
    },
    {
      key: 'order',
      header: 'Заказ',
      cell: (d) => <OrderCell deal={d} onLink={() => setLinking(d)} />,
      className: 'w-[170px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (d) => (
        <DealActions
          deal={d}
          tab={dealsTab}
          busy={createOrder.isPending || unlink.isPending || dismiss.isPending}
          onCreateOrder={() => runCreateOrder(d)}
          onLink={() => setLinking(d)}
          onUnlink={() => setUnlinking(d)}
          onDismiss={() => setDismissing(d)}
          onRestore={() =>
            dismiss.mutate(
              { dealId: d.id, dismissed: false },
              {
                onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось вернуть'),
              },
            )
          }
        />
      ),
      className: 'w-[210px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="amoCRM"
        description={
          conn ? (
            <span>
              {conn.accountName ?? conn.subdomain}
              {s?.pipelineName ? ` · воронка «${s.pipelineName}»` : ''}
              {s && s.waitingStageNames.length > 0
                ? ` · ждут заказа: ${s.waitingStageNames.join(', ')}`
                : ''}
              {' · '}
              {conn.lastSyncAt
                ? `обновлено ${formatDateTime(conn.lastSyncAt)}`
                : 'ещё не синхронизировано'}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={runSync} loading={sync.isPending}>
              <RotateCcw className="h-4 w-4" />
              Обновить
            </Button>
            <Button variant="secondary" onClick={() => setMatching(true)}>
              Сопоставить с заказами
            </Button>
            {isOwner && (
              <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
                Настройки
              </Button>
            )}
          </div>
        }
      />

      {conn?.status === 'ERROR' && (
        <div className="mx-6 mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Синхронизация остановлена: {conn.lastSyncError ?? 'ошибка amoCRM'}.
          {isOwner ? ' Проверьте токен в настройках.' : ' Сообщите владельцу.'}
        </div>
      )}
      {conn?.status === 'DISABLED' && (
        <div className="mx-6 mt-4 rounded-md border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
          Синхронизация выключена в настройках — сделки не обновляются.
        </div>
      )}

      <div className="px-6 py-4">
        <KpiRow count={3} loading={summary.isLoading}>
          <KpiCard
            label="Ждут заказа"
            value={s ? s.waitingCount : '—'}
            hint={s ? <Money value={s.waitingSum} /> : undefined}
            tone={s && s.waitingCount > 0 ? 'warning' : 'neutral'}
          />
          <KpiCard label="Привязано к заказам" value={s ? s.linkedCount : '—'} />
          <KpiCard label="Открытых в воронке" value={s ? s.openCount : '—'} />
        </KpiRow>
      </div>

      <div className="px-6">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">{TAB_HINTS[tab]}</p>
        <div className="mb-4 overflow-x-auto [scrollbar-width:none]">
          <Tabs value={tab} onValueChange={(v) => setFilters({ ...filters, tab: v })}>
            <TabsList>
              <TabsTrigger value="waiting">
                Ждут заказа
                {s && s.waitingCount > 0 && (
                  <span className="ml-1.5 tabular-nums text-muted-foreground">
                    {s.waitingCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="linked">Привязаны</TabsTrigger>
              <TabsTrigger value="all">Вся воронка</TabsTrigger>
              <TabsTrigger value="dismissed">Не учитываются</TabsTrigger>
              <TabsTrigger value="discrepancies">
                Расхождения
                {failingCount > 0 && (
                  <span className="ml-1.5 tabular-nums text-destructive">{failingCount}</span>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {tab === 'discrepancies' ? (
        <div className="px-6 pb-6">
          <DiscrepancyList wsId={wsId} crmHref="/crm" />
        </div>
      ) : (
        <>
          <FilterBar>
            <div className="min-w-[220px] max-w-md flex-1">
              <FilterField label="Поиск">
                <SearchField
                  ref={searchRef}
                  value={filters.q}
                  onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                  placeholder="Сделка, клиент, телефон или бюджет"
                />
              </FilterField>
            </div>
            <FilterField label="Этап">
              <Select
                value={filters.statusId}
                onChange={(e) => setFilters({ ...filters, statusId: e.target.value })}
                className="h-9 w-[200px]"
              >
                <option value="">Все этапы</option>
                {stages.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </Select>
            </FilterField>
            <FilterReset onClick={() => setFilters({ ...DEFAULTS, tab: filters.tab })} />
          </FilterBar>

          <div className="bg-card">
            <DataTable
              data={items}
              columns={columns}
              rowKey={(d) => d.id}
              loading={deals.isLoading}
              error={deals.error}
              onRetry={() => deals.refetch()}
              hasMore={deals.hasNextPage}
              loadingMore={deals.isFetchingNextPage}
              onLoadMore={() => void deals.fetchNextPage()}
              empty={
                filtersActive ? (
                  <EmptyState
                    icon={Handshake}
                    title="Ничего не найдено"
                    hint="Попробуйте другое имя, телефон или сумму — либо сбросьте фильтры."
                  />
                ) : (
                  <EmptyState icon={Handshake} title={EMPTY[tab].title} hint={EMPTY[tab].hint} />
                )
              }
              mobileCards={(d) => (
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 font-medium">{d.name}</div>
                    <Money value={d.price} className="shrink-0" />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <StatusStamp
                      tone={d.isClosed ? (d.isWon ? 'success' : 'muted') : 'primary'}
                      label={d.statusName || '—'}
                    />
                    <span>{formatDate(d.remoteUpdatedAt)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.contactName ?? '—'}
                    {d.phone ? ` · ${d.phone}` : ''}
                  </div>
                  <OrderCell deal={d} onLink={() => setLinking(d)} />
                  <div className="pt-1">
                    <DealActions
                      deal={d}
                      tab={tab}
                      busy={createOrder.isPending || unlink.isPending || dismiss.isPending}
                      onCreateOrder={() => runCreateOrder(d)}
                      onLink={() => setLinking(d)}
                      onUnlink={() => setUnlinking(d)}
                      onDismiss={() => setDismissing(d)}
                      onRestore={() => dismiss.mutate({ dealId: d.id, dismissed: false })}
                    />
                  </div>
                </div>
              )}
            />
          </div>
        </>
      )}

      {modals}
      <LinkOrderModal wsId={wsId} deal={linking} onClose={() => setLinking(null)} />
      <MatchOrdersModal wsId={wsId} open={matching} onClose={() => setMatching(false)} />

      <ConfirmDialog
        open={dismissing !== null}
        onOpenChange={(o) => !o && setDismissing(null)}
        title="Не учитывать сделку?"
        description="Сделка уйдёт с вкладки «Ждут заказа». Это обратимо: вкладка «Не учитываются», кнопка «Вернуть»."
        confirmText="Не учитывать"
        onConfirm={() => {
          if (!dismissing) return;
          dismiss.mutate(
            { dealId: dismissing.id, dismissed: true },
            { onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось отложить') },
          );
          setDismissing(null);
        }}
      />
      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(o) => !o && setUnlinking(null)}
        title="Отвязать сделку от заказа?"
        description="Заказ и его оплаты останутся, исчезнет только связь со сделкой amoCRM."
        confirmText="Отвязать"
        onConfirm={() => {
          if (!unlinking) return;
          unlink.mutate(unlinking.id, {
            onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось отвязать'),
          });
          setUnlinking(null);
        }}
      />
    </>
  );
}

/** Колонка «Заказ»: привязанный заказ с оплатой либо кандидаты по телефону. */
function OrderCell({ deal, onLink }: { deal: CrmDeal; onLink: () => void }) {
  if (deal.order) {
    const o = deal.order;
    return (
      <div className="min-w-0 text-sm">
        <Link
          href={{ pathname: '/orders', query: { order: o.id } }}
          className="font-medium text-primary hover:underline"
        >
          {o.number}
        </Link>
        <div className="text-xs text-muted-foreground">
          <StatusDot
            tone={
              o.paymentStatus === 'PAID'
                ? 'success'
                : o.paymentStatus === 'PARTIAL'
                  ? 'warning'
                  : 'muted'
            }
            label={`оплачено ${formatRub(o.paidAmount)} из ${formatRub(o.totalAmount)}`}
          />
        </div>
      </div>
    );
  }
  if (deal.suggestedOrders.length > 0) {
    const n = deal.suggestedOrders.length;
    return (
      <button
        type="button"
        onClick={onLink}
        className="block max-w-full truncate text-left text-xs text-muted-foreground hover:text-foreground"
        title="Открытый заказ с тем же телефоном — привязать"
      >
        Похоже на {deal.suggestedOrders[0]!.number}
        {n > 1 ? ` и ещё ${plural(n - 1, 'заказ', 'заказа', 'заказов')}` : ''}
        <ArrowRight className="ml-1 inline h-3 w-3" />
      </button>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

function DealActions({
  deal,
  tab,
  busy,
  onCreateOrder,
  onLink,
  onUnlink,
  onDismiss,
  onRestore,
}: {
  deal: CrmDeal;
  tab: CrmDealsTab;
  busy: boolean;
  onCreateOrder: () => void;
  onLink: () => void;
  onUnlink: () => void;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  if (deal.dismissedAt) {
    return (
      <div className="flex items-center justify-end gap-1">
        <Button variant="secondary" size="sm" onClick={onRestore} disabled={busy}>
          Вернуть
        </Button>
      </div>
    );
  }
  if (deal.order) {
    return (
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={onUnlink} disabled={busy}>
          Отвязать
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="sm"
        onClick={onCreateOrder}
        disabled={busy || !deal.phone}
        title={deal.phone ? undefined : 'У сделки нет телефона — добавьте его в amoCRM'}
      >
        Завести заказ
      </Button>
      <Button variant="secondary" size="sm" onClick={onLink} disabled={busy}>
        Привязать
      </Button>
      {tab !== 'linked' && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          disabled={busy}
          title="Не учитывать"
          aria-label="Не учитывать"
        >
          <ViewOff className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
