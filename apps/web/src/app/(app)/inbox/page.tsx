'use client';

import { useMemo, useState } from 'react';
import { Inbox as InboxIcon, Sparkles } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCategories } from '@/hooks/useCategories';
import { useInbox, useApplyRules } from '@/hooks/useInbox';
import type { ApplyRulesResult, BankLineStatus } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { type ComboboxOption } from '@/components/ui/Combobox';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toaster';
import { InboxRow } from '@/components/inbox/InboxRow';
import { TransferSuggestions } from '@/components/inbox/TransferSuggestions';

const TAB_HINTS: Record<BankLineStatus, string> = {
  NEW: 'Операции из банка на обработку. Подтвердите категорию, привяжите поступление к заказу или отметьте «не учитывать».',
  AUTO_POSTED:
    'Операции, проведённые правилами без вашего участия. Проверьте и отмените, если правило ошиблось.',
  RESOLVED:
    'Разобранные строки, а также узнанные при загрузке — те, что совпали с операциями, внесёнными вами раньше. Отмена снимает только связь: сама операция остаётся.',
  DISMISSED: 'Строки, отмеченные «не учитывать».',
};

export default function InboxPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [tab, setTab] = useState<BankLineStatus>('NEW');
  const inbox = useInbox(wsId, tab);
  const applyRules = useApplyRules(current?.id ?? '');
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');

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

        {tab === 'NEW' && <TransferSuggestions wsId={current.id} />}

        {inbox.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title={tab === 'NEW' ? 'Всё обработано' : 'Правила пока ничего не проводили'}
            hint={
              tab === 'NEW'
                ? 'Новые операции появятся здесь после синхронизации банка.'
                : 'Как только правило распознает строку выписки, она появится здесь.'
            }
          />
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
