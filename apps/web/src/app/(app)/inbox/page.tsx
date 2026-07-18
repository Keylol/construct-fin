'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Inbox as InboxIcon, Check, X, ClipboardList, ArrowRight } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCategories } from '@/hooks/useCategories';
import { useOrders } from '@/hooks/useOrders';
import {
  useInbox,
  useCategorizeInbox,
  useAttachOrderInbox,
  useDismissInbox,
} from '@/hooks/useInbox';
import type { InboxLine } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { formatRub } from '@construct/shared';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';

const AUSN_LABELS: Record<string, string> = {
  INCOME: 'АУСН: доход',
  EXPENSE: 'АУСН: расход',
  NOT_COUNTED: 'АУСН: не учитывается',
};

export default function InboxPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const inbox = useInbox(wsId);
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

  const items = inbox.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Входящие"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Входящие' }]}
      />
      <div className="px-6 py-4">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          Операции из банка на обработку. Подтвердите категорию, привяжите поступление
          к заказу или отметьте «не учитывать».
        </p>

        {inbox.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="Всё обработано"
            hint="Новые операции появятся здесь после синхронизации банка."
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
          </div>
        )}
      </div>
    </>
  );
}

function InboxRow({
  line,
  wsId,
  catOptions,
}: {
  line: InboxLine;
  wsId: string;
  catOptions: ComboboxOption[];
}) {
  const [categoryId, setCategoryId] = useState(line.suggestedCategoryId ?? '');
  const [attachOpen, setAttachOpen] = useState(false);
  const categorize = useCategorizeInbox(wsId);
  const dismiss = useDismissInbox(wsId);

  const isIncome = line.direction === 'INCOME';
  const title =
    line.description?.trim() || line.counterpartyName || (isIncome ? 'Поступление' : 'Расход');

  const doCategorize = () => {
    if (!categoryId) return;
    categorize.mutate(
      { lineId: line.id, categoryId },
      {
        onSuccess: () => toast.success('Операция проведена'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось провести'),
      },
    );
  };

  const doDismiss = () => {
    dismiss.mutate(line.id, {
      onSuccess: () => toast.success('Операция скрыта'),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось скрыть'),
    });
  };

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[200px] flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-base font-semibold tabular-nums',
                isIncome ? 'text-success' : 'text-destructive',
              )}
            >
              {isIncome ? '+' : '−'}
              {formatRub(line.amount, 2)}
            </span>
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatDate(line.date)} · {line.account.name}
            {line.ausnMark && ` · ${AUSN_LABELS[line.ausnMark]}`}
          </div>
        </div>

        {/* Проведение в категорию */}
        <div className="flex items-center gap-2">
          <Combobox
            value={categoryId}
            onChange={setCategoryId}
            options={catOptions}
            placeholder="Категория"
            searchPlaceholder="Категория…"
            className="h-9 w-[180px]"
          />
          <Button size="sm" onClick={doCategorize} disabled={!categoryId || categorize.isPending}>
            <Check className="h-3.5 w-3.5" />
            Провести
          </Button>
        </div>

        {/* Поступление → заказ */}
        {isIncome && (
          <Button variant="secondary" size="sm" onClick={() => setAttachOpen(true)}>
            <ClipboardList className="h-3.5 w-3.5" />
            К заказу
          </Button>
        )}

        <Button variant="ghost" size="sm" onClick={doDismiss} disabled={dismiss.isPending}>
          <X className="h-3.5 w-3.5" />
          Не учитывать
        </Button>
      </div>

      {isIncome && (
        <AttachOrderSheet
          open={attachOpen}
          onClose={() => setAttachOpen(false)}
          wsId={wsId}
          line={line}
        />
      )}
    </div>
  );
}

function AttachOrderSheet({
  open,
  onClose,
  wsId,
  line,
}: {
  open: boolean;
  onClose: () => void;
  wsId: string;
  line: InboxLine;
}) {
  const orders = useOrders(wsId, { status: 'OPEN', limit: 100 });
  const attach = useAttachOrderInbox(wsId);
  const [orderId, setOrderId] = useState('');

  const orderOptions = useMemo<ComboboxOption[]>(
    () =>
      (orders.data?.pages.flatMap((p) => p.items) ?? []).map((o) => ({
        value: o.id,
        label: `${o.number}${o.client ? ` · ${o.client.name}` : ''}`,
        description: `Заказ ${formatRub(o.totalAmount)} · оплачено ${formatRub(o.paidAmount)}`,
      })),
    [orders.data],
  );

  const submit = () => {
    if (!orderId) return;
    attach.mutate(
      { lineId: line.id, orderId },
      {
        onSuccess: () => {
          toast.success('Поступление привязано к заказу');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось привязать'),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px]">
        <SheetHeader>
          <SheetTitle>Привязать поступление к заказу</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            Поступление{' '}
            <span className="font-semibold text-success">+{formatRub(line.amount, 2)}</span>{' '}
            от {formatDate(line.date)}
            {line.counterpartyName ? ` · ${line.counterpartyName}` : ''}
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Открытый заказ</span>
            <Combobox
              value={orderId}
              onChange={setOrderId}
              options={orderOptions}
              placeholder="Выберите заказ"
              searchPlaceholder="Номер или клиент…"
              className="h-9"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Нет подходящего заказа?{' '}
            <Link href={'/orders?new=1' as Parameters<typeof Link>[0]['href']} className="text-primary hover:underline">
              создать заказ <ArrowRight className="inline h-3 w-3" />
            </Link>
          </p>
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!orderId || attach.isPending}>
            Привязать оплату
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
