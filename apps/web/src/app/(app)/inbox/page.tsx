'use client';

import { Suspense, useMemo, useRef } from 'react';
import { Inbox as InboxIcon, Sparkles } from '@/components/ui/icons';
import { LoadMore } from '@/components/ui/LoadMore';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInbox, useApplyRules, useInboxCount } from '@/hooks/useInbox';
import type { ApplyRulesResult, BankLineStatus } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { FilterField } from '@/components/ui/FilterField';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { type ComboboxOption } from '@/components/ui/Combobox';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toaster';
import { InboxRow } from '@/components/inbox/InboxRow';
import { TransferSuggestions } from '@/components/inbox/TransferSuggestions';
import { PlannedSuggestions } from '@/components/inbox/PlannedSuggestions';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { useListHotkeys } from '@/hooks/useListHotkeys';

const DEFAULTS = { tab: 'NEW', q: '', direction: '', accountId: '' };
const FILTERS = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function InboxPage() {
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}

const TABS: BankLineStatus[] = ['NEW', 'AUTO_POSTED', 'RESOLVED', 'DISMISSED'];

const TAB_HINTS: Record<BankLineStatus, string> = {
  NEW: 'Операции из банка на обработку. Подтвердите категорию, привяжите поступление к заказу или отметьте «не учитывать».',
  AUTO_POSTED:
    'Операции, проведённые правилами без вашего участия. Проверьте и отмените, если правило ошиблось.',
  RESOLVED:
    'Обработанные строки, а также узнанные при загрузке — те, что совпали с операциями, внесёнными вами раньше. Отмена снимает только связь: сама операция остаётся.',
  // Без этой вкладки отметка была необратимой: строка пропадала из «Входящих»,
  // и деньги, отмеченные по ошибке, выпадали из учёта насовсем.
  DISMISSED:
    'Строки, отмеченные «не учитывать»: в операции и отчёты они не попали. Если отметили по ошибке — верните строку на разбор.',
};

// Пустая вкладка без поиска — у каждой своя причина.
const EMPTY: Record<BankLineStatus, { title: string; hint: string }> = {
  NEW: {
    title: 'Всё обработано',
    hint: 'Новые операции появятся здесь после синхронизации банка.',
  },
  AUTO_POSTED: {
    title: 'Правила пока ничего не проводили',
    hint: 'Как только правило распознает строку выписки, она появится здесь.',
  },
  RESOLVED: {
    title: 'Обработанных строк пока нет',
    hint: 'Здесь соберутся строки, которые вы провели или которые совпали с внесёнными ранее операциями.',
  },
  DISMISSED: {
    title: 'Отмеченных строк нет',
    hint: 'Здесь соберутся строки, отмеченные «не учитывать».',
  },
};

function InboxView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  // Вкладка и фильтры — в адресе: строк за месяц под три сотни, и разрез
  // должен переживать F5 и уходить ссылкой.
  const [filters, setFilters] = useUrlFilters(FILTERS);
  const tab = (TABS as string[]).includes(filters.tab) ? (filters.tab as BankLineStatus) : 'NEW';
  const setTab = (t: BankLineStatus) => setFilters({ ...filters, tab: t });
  const search = filters.q;
  const direction = filters.direction as '' | 'INCOME' | 'EXPENSE';
  const accountId = filters.accountId;
  const q = useDebouncedValue(search);
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef });

  const accounts = useAccounts(wsId);
  const inbox = useInbox(wsId, tab, {
    q: q || undefined,
    direction: direction || undefined,
    accountId: accountId || undefined,
  });
  const applyRules = useApplyRules(current?.id ?? '');
  // Точное число на вкладке: бейдж в меню его тоже показывает, но здесь
  // человек решает, сколько работы осталось, и «99+» ему не ответ.
  const inboxCount = useInboxCount(current?.id ?? '');
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const filtersActive = !!(q || direction || accountId);

  const catOptions = useMemo(() => {
    const map = (cats: { id: string; name: string; parentId: string | null }[]): ComboboxOption[] =>
      cats.map((c) => ({ value: c.id, label: c.name }));
    return {
      INCOME: map(incomeCats.data ?? []),
      EXPENSE: map(expenseCats.data ?? []),
    };
  }, [incomeCats.data, expenseCats.data]);

  if (!current) return null;

  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];

  const doApplyRules = () => {
    applyRules.mutate(undefined, {
      onSuccess: (res) => {
        const r = res as ApplyRulesResult;
        const suggested = r.suggested ?? 0;
        if (r.posted === 0 && suggested === 0) {
          toast.info('Ни одна строка не подошла под действующие правила');
          return;
        }
        // Правила в режиме подсказки статью подставили, но проводить их человеку:
        // без отдельного счётчика «Проведено 0» выглядело бы как отказ.
        if (r.posted === 0) {
          toast.success(`Статья подставлена у ${suggested} — проверьте и проведите`);
          return;
        }
        toast.success(
          `Проведено ${r.posted}, осталось на разборе ${r.remaining}` +
            (suggested > 0 ? `, статья подставлена у ${suggested}` : '') +
            (r.remaining > 0 && r.scanned === r.posted + r.skipped && r.remaining > r.skipped
              ? ' — нажмите ещё раз, чтобы продолжить'
              : ''),
        );
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось применить правила'),
    });
  };

  return (
    <>
      <PageHeader
        title="Входящие"
        actions={
          <Button variant="secondary" onClick={doApplyRules} disabled={applyRules.isPending}>
            <Sparkles className="h-4 w-4" />
            Применить правила
          </Button>
        }
      />
      <div className="px-6 py-4">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">{TAB_HINTS[tab]}</p>

        {/* На телефоне четыре вкладки шире экрана — лента со скроллом, как у
            вкладок отчётов (NavTabs), а не страница шире экрана. */}
        <div className="mb-4 overflow-x-auto [scrollbar-width:none]">
          <Tabs value={tab} onValueChange={(v) => setTab(v as BankLineStatus)}>
            <TabsList>
              <TabsTrigger value="NEW">
                На разбор
                {inboxCount.data && inboxCount.data.count > 0 && (
                  <span className="ml-1.5 tabular-nums text-muted-foreground">
                    {inboxCount.data.count}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="AUTO_POSTED">Проведено правилами</TabsTrigger>
              <TabsTrigger value="RESOLVED">Обработано</TabsTrigger>
              <TabsTrigger value="DISMISSED">Не учитываются</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

      </div>

      {/* Поиск и фильтры. Строк за месяц бывает под три сотни, и без них нужную
          находили прокруткой через «Загрузить ещё». */}
      <FilterBar>
        <div className="min-w-[220px] max-w-md flex-1">
          <FilterField label="Поиск">
            <SearchField
              ref={searchRef}
              value={search}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Сумма, назначение, контрагент или ИНН"
            />
          </FilterField>
        </div>
        <FilterField label="Направление">
          <Select
            value={direction}
            onChange={(e) => setFilters({ ...filters, direction: e.target.value })}
            className="h-9 w-[180px]"
          >
            <option value="">Приходы и расходы</option>
            <option value="INCOME">Только приходы</option>
            <option value="EXPENSE">Только расходы</option>
          </Select>
        </FilterField>
        <FilterField label="Счёт">
          <Select
            value={accountId}
            onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}
            className="h-9 w-[180px]"
          >
            <option value="">Все счета</option>
            {(accounts.data ?? [])
              .filter((a) => !a.isArchived)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </FilterField>
        <FilterReset onClick={() => setFilters({ ...DEFAULTS, tab: filters.tab })} />
      </FilterBar>

      <div className="px-6 py-4">
        {/* Подсказки переводов и планов считаются по всему списку, а не по
            отфильтрованному — при активном поиске прячем, чтобы не сбивать с толку. */}
        {tab === 'NEW' && !filtersActive && (
          <>
            <TransferSuggestions wsId={current.id} />
            <PlannedSuggestions wsId={current.id} />
          </>
        )}

        {inbox.isError ? (
          <ErrorState error={inbox.error} onRetry={() => inbox.refetch()} />
        ) : inbox.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : items.length === 0 ? (
          // При активном поиске «Всё обработано» соврало бы: строки есть, просто
          // не подошли под фильтр.
          filtersActive ? (
            <EmptyState
              icon={InboxIcon}
              title="Ничего не найдено"
              hint="Попробуйте другую сумму или часть назначения — либо сбросьте фильтры."
            />
          ) : (
            <EmptyState icon={InboxIcon} title={EMPTY[tab].title} hint={EMPTY[tab].hint} />
          )
        ) : (
          <div className="space-y-2">
            {items.map((line) => (
              <InboxRow
                key={line.id}
                line={line}
                wsId={current.id}
                catOptions={line.direction === 'INCOME' ? catOptions.INCOME : catOptions.EXPENSE}
              />
            ))}
            <LoadMore hasMore={inbox.hasNextPage} loading={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()} />
          </div>
        )}
      </div>
    </>
  );
}
