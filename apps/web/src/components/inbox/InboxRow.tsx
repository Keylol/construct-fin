'use client';

import { useState } from 'react';
import { ArrowRight, Check, ClipboardList, RotateCcw, X } from '@/components/ui/icons';
import { useCategorizeInbox, useDismissInbox, useUndoInbox } from '@/hooks/useInbox';
import type { InboxLine } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { toast } from '@/components/ui/Toaster';
import { formatRub } from '@construct/shared';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { AttachOrderSheet } from './AttachOrderSheet';
import { MarkTransferSheet } from './MarkTransferSheet';

const AUSN_LABELS: Record<string, string> = {
  INCOME: 'АУСН: доход',
  EXPENSE: 'АУСН: расход',
  NOT_COUNTED: 'АУСН: не учитывается',
};

/** Карточка строки выписки: разбор (категория/заказ/перевод/скрыть) или ревизия. */
export function InboxRow({
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
      onSuccess: () => toast.success('Строка отмечена «не учитывать»'),
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
