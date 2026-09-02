'use client';

import { useEffect, useState } from 'react';
import { Row } from '@/components/orders/order-shared';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';
import { Plus, Trash2 } from '@/components/ui/icons';
import { useSetOrderSchedule } from '@/hooks/useOrders';
import type { Order } from '@/lib/types';
import { D, add, formatRub, parseAmountInput, toMoneyString } from '@construct/shared';

interface ScheduleRowDraft {
  dueDate: string; // yyyy-mm-dd
  amount: string;
  note: string;
}

export function ScheduleModal({
  wsId,
  order,
  open,
  onClose,
}: {
  wsId: string;
  order: Order;
  open: boolean;
  onClose: () => void;
}) {
  const setSchedule = useSetOrderSchedule(wsId);
  const [rows, setRows] = useState<ScheduleRowDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(
      order.schedule?.entries.map((e) => ({
        dueDate: e.dueDate.slice(0, 10),
        amount: e.amount,
        note: e.note ?? '',
      })) ?? [{ dueDate: new Date().toISOString().slice(0, 10), amount: '', note: '' }],
    );
    setError(null);
  }, [open, order]);

  // Σ-превью черновика через Decimal (введённое сравнивается с итогом заказа).
  const planned = rows.reduce((acc, r) => {
    const p = r.amount ? parseAmountInput(r.amount) : null;
    return p ? add(acc, p) : acc;
  }, D(0));
  const matches = planned.eq(D(order.totalAmount));

  const collect = (): { dueDate: string; amount: string; note?: string }[] | null => {
    const entries: { dueDate: string; amount: string; note?: string }[] = [];
    for (const r of rows) {
      if (!r.dueDate && !r.amount) continue; // полностью пустую строку молча пропускаем
      const amount = parseAmountInput(r.amount);
      if (!r.dueDate || !amount || D(amount).lte(0)) {
        setError('В каждой строке нужны дата и положительная сумма');
        return null;
      }
      entries.push({
        dueDate: new Date(r.dueDate).toISOString(),
        amount,
        note: r.note.trim() || undefined,
      });
    }
    return entries;
  };

  const save = async () => {
    setError(null);
    const entries = collect();
    if (!entries) return;
    try {
      await setSchedule.mutateAsync({ id: order.id, entries });
      toast.success(entries.length ? 'График сохранён' : 'График убран');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const clear = async () => {
    setError(null);
    try {
      await setSchedule.mutateAsync({ id: order.id, entries: [] });
      toast.success('График убран');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>График платежей · {order.number}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="date"
                value={r.dueDate}
                onChange={(e) =>
                  setRows((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                  )
                }
                className="w-[150px]"
              />
              <Input
                inputMode="decimal"
                placeholder="Сумма"
                value={r.amount}
                onChange={(e) =>
                  setRows((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
                className="w-[120px]"
              />
              <Input
                placeholder="Заметка"
                value={r.note}
                onChange={(e) =>
                  setRows((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                  )
                }
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setRows((arr) => arr.filter((_, j) => j !== i))}
                aria-label="Удалить строку"
                disabled={rows.length === 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setRows((arr) => [
                ...arr,
                { dueDate: new Date().toISOString().slice(0, 10), amount: '', note: '' },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" /> Платёж
          </Button>

          <div className="space-y-1 rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <Row label="Сумма графика" value={<Money value={toMoneyString(planned)} />} />
            <Row label="Итог заказа" value={<Money value={order.totalAmount} />} />
            {!matches && planned.gt(0) && (
              <p className="text-xs text-amber-600">
                Суммы не сходятся — график сохранится, но карточка будет предупреждать.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          {order.schedule && (
            <Button
              variant="ghost"
              className="text-destructive sm:mr-auto"
              onClick={clear}
              disabled={setSchedule.isPending}
            >
              Убрать график
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={setSchedule.isPending}>
            Отмена
          </Button>
          <Button onClick={save} disabled={setSchedule.isPending}>
            {setSchedule.isPending ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
