'use client';

import { useMemo, useState } from 'react';
import { Inbox as InboxIcon, Sparkles } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInbox, useApplyRules } from '@/hooks/useInbox';
import type { ApplyRulesResult, BankLineStatus } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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

// Вкладки экрана; DISMISSED вкладки не имеет — подсказку для него не держим.
const TAB_HINTS: Partial<Record<BankLineStatus, string>> = {
  NEW: 'Операции из банка на обработку. Подтвердите категорию, привяжите поступление к заказу или отметьте «не учитывать».',
  AUTO_POSTED:
    'Операции, проведённые правилами без вашего участия. Проверьте и отмените, если правило ошиблось.',
  RESOLVED:
    'Обработанные строки, а также узнанные при загрузке — те, что совпали с операциями, внесёнными вами раньше. Отмена снимает только связь: сама операция остаётся.',
};

export default function InboxPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [tab, setTab] = useState<BankLineStatus>('NEW');
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<'' | 'INCOME' | 'EXPENSE'>('');
  const [accountId, setAccountId] = useState('');
  const q = useDebouncedValue(search);

  const accounts = useAccounts(wsId);
  const inbox = useInbox(wsId, tab, {
    q: q || undefined,
    direction: direction || undefined,
    accountId: accountId || undefined,
  });
  const applyRules = useApplyRules(current?.id ?? '');
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

  if (!current) {
    return (
      <>
        <PageHeader title="Входящие" />
        <div className="p-6">
          <EmptyState icon={InboxIcon} title="Нет активного пространства" hint="Выберите пространство." />
        </div>
      </>
    );
  }

  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];

  const doApplyRules = () => {
    applyRules.mutate(undefined, {
      onSuccess: (res) => {
        const r = res as ApplyRulesResult;
        if (r.posted === 0) {
          toast.info('Ни одна строка не подошла под действующие правила');
          return;
        }
        toast.success(
          `Проведено ${r.posted}, осталось на разборе ${r.remaining}` +
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

        <div className="mb-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as BankLineStatus)}>
            <TabsList>
              <TabsTrigger value="NEW">На разбор</TabsTrigger>
              <TabsTrigger value="AUTO_POSTED">Проведено правилами</TabsTrigger>
              <TabsTrigger value="RESOLVED">Обработано</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Поиск и фильтры. Строк за месяц бывает под три сотни, и без них нужную
            находили прокруткой через «Показать ещё». */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Сумма, назначение, контрагент или ИНН"
            className="w-full sm:w-80"
            aria-label="Поиск по строкам"
          />
          <Select
            value={direction}
            onChange={(e) => setDirection(e.target.value as '' | 'INCOME' | 'EXPENSE')}
            className="w-auto"
            aria-label="Направление"
          >
            <option value="">Приходы и расходы</option>
            <option value="INCOME">Только приходы</option>
            <option value="EXPENSE">Только расходы</option>
          </Select>
          <Select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-auto"
            aria-label="Счёт"
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
          {filtersActive && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                setDirection('');
                setAccountId('');
              }}
            >
              Сбросить
            </Button>
          )}
        </div>

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
            <EmptyState
              icon={InboxIcon}
              title={
                tab === 'NEW'
                  ? 'Всё обработано'
                  : tab === 'AUTO_POSTED'
                    ? 'Правила пока ничего не проводили'
                    : 'Обработанных строк пока нет'
              }
              hint={
                tab === 'NEW'
                  ? 'Новые операции появятся здесь после синхронизации банка.'
                  : tab === 'AUTO_POSTED'
                    ? 'Как только правило распознает строку выписки, она появится здесь.'
                    : 'Здесь соберутся строки, которые вы провели или которые совпали с внесёнными ранее операциями.'
              }
            />
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
            {inbox.hasNextPage && (
              <div className="pt-2 text-center">
                <Button
                  variant="secondary"
                  onClick={() => void inbox.fetchNextPage()}
                  disabled={inbox.isFetchingNextPage}
                >
                  Показать ещё
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
