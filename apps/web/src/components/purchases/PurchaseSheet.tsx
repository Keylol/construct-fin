'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from '@/components/ui/icons';
import { formatRub, parseAmountInput } from '@construct/shared';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import { useWarehouse } from '@/hooks/useWarehouse';
import { useCreatePurchase, type PurchaseLineInput } from '@/hooks/usePurchases';
import { toLocalDateInput, fromLocalDateInput } from '@/lib/periods';
import { parseQty } from '@/lib/qty';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { toast } from '@/components/ui/Toaster';

/**
 * Форма закупки на склад. Общая для /warehouse и /purchases.
 * Деньги списываются со счёта сразу целиком (cash-basis), склад приходуется FIFO-лотом.
 */
export function PurchaseSheet({
  wsId,
  open,
  onClose,
}: {
  wsId: string;
  open: boolean;
  onClose: () => void;
}) {
  const suppliers = useCounterparties(wsId, undefined, false, 'SUPPLIER');
  const accounts = useAccounts(wsId);
  const warehouse = useWarehouse(wsId);
  const createPurchase = useCreatePurchase(wsId);

  const [supplierId, setSupplierId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(() => toLocalDateInput(new Date()));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PurchaseLineInput[]>([
    { warehouseItemId: '', qty: '1', unitPrice: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  // Ошибки по строкам: индекс → текст. Невалидная строка не выбрасывается молча.
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({});
  // «+ Новый поставщик» из комбобокса: null = закрыто, строка = префилл имени.
  const [createSupplierQuery, setCreateSupplierQuery] = useState<string | null>(null);

  const supplierOptions = useMemo<ComboboxOption[]>(
    () =>
      (suppliers.data ?? []).map((s) => ({
        value: s.id,
        label: s.name,
        description: s.contact ?? undefined,
      })),
    [suppliers.data],
  );

  // SKU со вторичной строкой: остаток и текущая себестоимость — выбор
  // информированный, одноимённые позиции различимы по цвету/артикулу.
  const skuOptions = useMemo<ComboboxOption[]>(
    () =>
      (warehouse.data ?? [])
        .filter((w) => !w.isArchived)
        .map((w) => ({
          value: w.id,
          label: w.color ? `${w.name} · ${w.color}` : w.name,
          description: `ост. ${Number(w.qty)} ${w.unit}${
            Number(w.avgCost) > 0 ? ` · себест. ${formatRub(w.avgCost)}` : ''
          }`,
          keywords: w.sku ? [w.sku] : undefined,
        })),
    [warehouse.data],
  );

  useEffect(() => {
    if (open) {
      setSupplierId('');
      setAccountId('');
      setDate(toLocalDateInput(new Date()));
      setNote('');
      setLines([{ warehouseItemId: '', qty: '1', unitPrice: '' }]);
      setError(null);
      setLineErrors({});
    }
  }, [open]);

  const total = useMemo(
    () => lines.reduce((acc, l) => acc + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0),
    [lines],
  );

  // Правка строки + сброс её ошибки (пользователь начал исправлять).
  const patchLine = (i: number, patch: Partial<PurchaseLineInput>) => {
    setLines((arr) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setLineErrors((prev) => {
      if (!(i in prev)) return prev;
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    if (!accountId) {
      setError('Выберите счёт');
      return;
    }
    // Честная валидация: пустые строки игнорируются, частично заполненные —
    // ошибка с подсветкой, а не молчаливый выброс из закупки.
    const cleaned: PurchaseLineInput[] = [];
    const errors: Record<number, string> = {};
    lines.forEach((l, i) => {
      const blank = !l.warehouseItemId && !l.unitPrice.trim();
      if (blank) return;
      if (!l.warehouseItemId) {
        errors[i] = 'Выберите артикул со склада';
        return;
      }
      const price = parseAmountInput(l.unitPrice);
      if (!price) {
        errors[i] = 'Укажите цену — число больше нуля';
        return;
      }
      const q = parseQty(l.qty);
      if (!q || Number(q) <= 0) {
        errors[i] = 'Количество должно быть больше нуля';
        return;
      }
      cleaned.push({ warehouseItemId: l.warehouseItemId, qty: q, unitPrice: price });
    });
    if (Object.keys(errors).length) {
      setLineErrors(errors);
      setError('Исправьте выделенные позиции — они не будут проведены в таком виде');
      return;
    }
    if (cleaned.length === 0) {
      setError('Добавьте хотя бы одну позицию: артикул + количество + цена');
      return;
    }
    try {
      await createPurchase.mutateAsync({
        accountId,
        supplierId: supplierId || null,
        date: fromLocalDateInput(date),
        note: note.trim() || undefined,
        lines: cleaned,
      });
      toast.success('Закупка проведена', { description: 'Склад и себестоимость обновлены' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose size="xl">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>Закупка на склад</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <SheetBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Поставщик" htmlFor="p-supplier">
                <Combobox
                  id="p-supplier"
                  value={supplierId}
                  onChange={setSupplierId}
                  options={supplierOptions}
                  placeholder="— Не указан —"
                  searchPlaceholder="Имя или контакт…"
                  clearLabel="— Не указан —"
                  recentKey={`${wsId}:supplier`}
                  onCreate={(q) => setCreateSupplierQuery(q)}
                  createLabel={(q) => `Создать поставщика «${q}»`}
                />
              </FormField>
              <FormField
                label="Счёт оплаты"
                htmlFor="p-account"
                required
                hint="Деньги спишутся со счёта сразу целиком"
              >
                <Select
                  id="p-account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  <option value="">— Счёт —</option>
                  {(accounts.data ?? [])
                    .filter((a) => !a.isArchived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Дата закупки"
                htmlFor="p-date"
                hint="Можно провести задним числом"
              >
                <Input
                  id="p-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </FormField>
              <FormField label="Примечание" htmlFor="p-note">
                <Input
                  id="p-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Накладная №…"
                />
              </FormField>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Позиции закупки</div>
              {lines.map((l, i) => {
                const rowError = lineErrors[i];
                const lineSum = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
                return (
                  <div
                    key={i}
                    className={cn(
                      'space-y-1 rounded-md',
                      rowError && 'border border-destructive p-1.5',
                    )}
                  >
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Combobox
                          value={l.warehouseItemId}
                          onChange={(v) => patchLine(i, { warehouseItemId: v })}
                          options={skuOptions}
                          placeholder="— Артикул —"
                          searchPlaceholder="Название, цвет или артикул…"
                          recentKey={`${wsId}:sku`}
                          aria-invalid={rowError ? true : undefined}
                        />
                      </div>
                      <div className="w-16">
                        <Input
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => patchLine(i, { qty: e.target.value })}
                          placeholder="Кол."
                          aria-invalid={rowError ? true : undefined}
                        />
                      </div>
                      <div className="w-28">
                        <Input
                          inputMode="decimal"
                          value={l.unitPrice}
                          onChange={(e) => patchLine(i, { unitPrice: e.target.value })}
                          placeholder="Цена"
                          aria-invalid={rowError ? true : undefined}
                        />
                      </div>
                      {/* Сумма по строке: qty × цена — видно вклад строки до проведения. */}
                      <div className="flex h-10 w-24 items-center justify-end text-xs text-muted-foreground tabular-nums sm:h-9">
                        {lineSum > 0 ? formatRub(lineSum) : ''}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setLines((arr) => arr.filter((_, j) => j !== i));
                          setLineErrors({});
                        }}
                        disabled={lines.length === 1}
                        aria-label="Удалить"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {rowError && (
                      <p role="alert" className="text-xs font-medium text-destructive">
                        {rowError}
                      </p>
                    )}
                  </div>
                );
              })}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setLines((arr) => [...arr, { warehouseItemId: '', qty: '1', unitPrice: '' }])
                }
              >
                <Plus className="h-3.5 w-3.5" /> Позиция
              </Button>
            </div>

            <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
              <div className="flex justify-between font-semibold">
                <span>Сумма закупки</span>
                <span className="tabular-nums">{formatRub(total)}</span>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            )}
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" loading={createPurchase.isPending}>
              Провести закупку
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
      <QuickCreateCounterpartyDialog
        wsId={wsId}
        role="SUPPLIER"
        open={createSupplierQuery !== null}
        initialName={createSupplierQuery ?? ''}
        onOpenChange={(o) => !o && setCreateSupplierQuery(null)}
        onCreated={setSupplierId}
      />
    </Sheet>
  );
}
