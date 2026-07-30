'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Inbox as InboxIcon,
  Check,
  X,
  ClipboardList,
  ArrowRight,
  Sparkles,
  RotateCcw,
} from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCategories } from '@/hooks/useCategories';
import { useOrders } from '@/hooks/useOrders';
import {
  useInbox,
  useCategorizeInbox,
  useAttachOrderInbox,
  useDismissInbox,
  useApplyRules,
  useUndoInbox,
  useTransferCandidates,
  useConfirmTransfer,
  useMarkTransfer,
} from '@/hooks/useInbox';
import { useAccounts } from '@/hooks/useAccounts';
import type {
  ApplyRulesResult,
  BankLineStatus,
  InboxLine,
  TransferCandidate,
} from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
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
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          {tab === 'NEW' &&
            'Операции из банка на обработку. Подтвердите категорию, привяжите поступление к заказу или отметьте «не учитывать».'}
          {tab === 'AUTO_POSTED' &&
            'Операции, проведённые правилами без вашего участия. Проверьте и отмените, если правило ошиблось.'}
          {tab === 'RESOLVED' &&
            'Разобранные строки, а также узнанные при загрузке — те, что совпали с операциями, внесёнными вами раньше. Отмена снимает только связь: сама операция остаётся.'}
        </p>

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

/**
 * «Похоже на перевод»: расход на одном счёте и приход на другом, которые
 * выглядят как две стороны одного перемещения денег. Разобранные порознь, они
 * задвоят обороты — покажут расход и доход там, где деньги из бизнеса не
 * выходили. Автоматически не склеиваем: ложная склейка спрячет настоящую
 * операцию, поэтому решает человек.
 */
function TransferSuggestions({ wsId }: { wsId: string }) {
  const candidates = useTransferCandidates(wsId);
  const confirm = useConfirmTransfer(wsId);
  const [hidden, setHidden] = useState<string[]>([]);

  const items = (candidates.data?.items ?? []).filter(
    (c) => !hidden.includes(`${c.out.id}:${c.in.id}`),
  );
  if (items.length === 0) return null;

  const accept = (c: TransferCandidate) => {
    confirm.mutate(
      { outLineId: c.out.id, inLineId: c.in.id },
      {
        onSuccess: () =>
          toast.success(
            Number(c.fee) > 0
              ? `Перевод создан, комиссия ${formatRub(c.fee, 2)} учтена расходом`
              : 'Перевод создан, обороты не задвоились',
          ),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось создать перевод'),
      },
    );
  };

  return (
    <div className="mb-4 space-y-2">
      {items.map((c) => (
        <div
          key={`${c.out.id}:${c.in.id}`}
          className="rounded-md border border-primary/30 bg-primary/5 p-3"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <ArrowRight className="h-4 w-4 text-primary" />
            Похоже на перевод между своими счетами
            {c.confidence === 'with_fee' && (
              <span className="text-xs font-normal text-muted-foreground">
                — суммы разошлись на {formatRub(c.fee, 2)}, спишем как комиссию
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="text-destructive">−{formatRub(c.out.amount, 2)}</span> ·{' '}
              {c.out.account.name} · {formatDate(c.out.date)}
            </span>
            <ArrowRight className="h-3 w-3" />
            <span>
              <span className="text-success">+{formatRub(c.in.amount, 2)}</span> ·{' '}
              {c.in.account.name} · {formatDate(c.in.date)}
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => accept(c)} disabled={confirm.isPending}>
              <Check className="h-3.5 w-3.5" />
              Это перевод
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHidden((prev) => [...prev, `${c.out.id}:${c.in.id}`])}
            >
              Не перевод
            </Button>
          </div>
        </div>
      ))}
    </div>
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
  const [transferOpen, setTransferOpen] = useState(false);
  const categorize = useCategorizeInbox(wsId);
  const dismiss = useDismissInbox(wsId);
  const undo = useUndoInbox(wsId);

  const isIncome = line.direction === 'INCOME';
  const isAutoPosted = line.status === 'AUTO_POSTED';
  // Разобранные строки (в т.ч. узнанные при загрузке) уже стали операциями —
  // здесь только просмотр и отмена связи.
  const isSettled = isAutoPosted || line.status === 'RESOLVED';
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

  const doUndo = () => {
    undo.mutate(line.id, {
      onSuccess: () =>
        toast.success(
          line.adopted
            ? 'Связь снята: ваша операция осталась, строка вернулась на разбор'
            : 'Проведение отменено, строка вернулась на разбор',
        ),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось отменить'),
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
            {isAutoPosted && ` · правило: ${line.appliedRule?.name ?? 'удалено'}`}
            {line.adopted && ' · узнана: совпала с вашей операцией'}
          </div>
        </div>

        {isSettled ? (
          // Строка уже стала операцией — здесь только ревизия. Для узнанной
          // отмена снимает лишь связь, сама операция человека остаётся.
          <Button variant="secondary" size="sm" onClick={doUndo} disabled={undo.isPending}>
            <RotateCcw className="h-3.5 w-3.5" />
            {line.adopted ? 'Отменить связь' : 'Отменить проведение'}
          </Button>
        ) : (
          <>
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

            <Button variant="secondary" size="sm" onClick={() => setTransferOpen(true)}>
              <ArrowRight className="h-3.5 w-3.5" />
              Перевод
            </Button>

            <Button variant="ghost" size="sm" onClick={doDismiss} disabled={dismiss.isPending}>
              <X className="h-3.5 w-3.5" />
              Не учитывать
            </Button>
          </>
        )}
      </div>

      {isIncome && !isSettled && (
        <AttachOrderSheet
          open={attachOpen}
          onClose={() => setAttachOpen(false)}
          wsId={wsId}
          line={line}
        />
      )}

      {!isSettled && (
        <MarkTransferSheet
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
          wsId={wsId}
          line={line}
        />
      )}
    </div>
  );
}

/**
 * Перевод на счёт, выписку которого банк не отдаёт: карты физлиц (ВБ) второй
 * строкой никогда не приедут, поэтому встречную сторону заводим сами.
 */
function MarkTransferSheet({
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
  const accounts = useAccounts(wsId);
  const mark = useMarkTransfer(wsId);
  const [counterAccountId, setCounterAccountId] = useState('');

  const isOut = line.direction === 'EXPENSE';
  // Счёт самой строки исключаем: перевод сам на себя невозможен.
  const options = useMemo<ComboboxOption[]>(
    () =>
      (accounts.data ?? [])
        .filter((a) => !a.isArchived && a.id !== line.account.id)
        .map((a) => ({ value: a.id, label: a.name })),
    [accounts.data, line.account.id],
  );

  const submit = () => {
    if (!counterAccountId) return;
    mark.mutate(
      { lineId: line.id, counterAccountId },
      {
        onSuccess: () => {
          toast.success('Перевод создан — в доходы и расходы он не попадёт');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось создать перевод'),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px]">
        <SheetHeader>
          <SheetTitle>{isOut ? 'Перевод на другой счёт' : 'Поступление с другого счёта'}</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            <span className={isOut ? 'font-semibold text-destructive' : 'font-semibold text-success'}>
              {isOut ? '−' : '+'}
              {formatRub(line.amount, 2)}
            </span>{' '}
            от {formatDate(line.date)} · {line.account.name}
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{isOut ? 'Куда переведены деньги' : 'Откуда пришли деньги'}</span>
            <Combobox
              value={counterAccountId}
              onChange={setCounterAccountId}
              options={options}
              placeholder="Выберите счёт"
              searchPlaceholder="Название счёта…"
              className="h-9"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Перевод между своими счетами не доход и не расход: в отчёт о прибыли он не
            попадёт, изменятся только остатки счетов. Используйте, когда выписку второго
            счёта банк не отдаёт — например, для карт.
          </p>
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!counterAccountId || mark.isPending}>
            Создать перевод
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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
