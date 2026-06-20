'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Package, Search, X, Trash2, ShoppingCart } from '@/components/ui/icons';
import { formatRub, parseAmountInput } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useWarehouse,
  useStockValue,
  useCreateWarehouseItem,
  useUpdateWarehouseItem,
  useAdjustStock,
  useSetItemCost,
  useDeleteWarehouseItem,
} from '@/hooks/useWarehouse';
import { useCreatePurchase, type PurchaseLineInput } from '@/hooks/usePurchases';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import type { WarehouseItem } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { FilterBar } from '@/components/ui/FilterBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { toast } from '@/components/ui/Toaster';

function lineValue(qty: string, avg: string): number {
  return (Number(qty) || 0) * (Number(avg) || 0);
}

export default function WarehousePage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [search, setSearch] = useState('');
  const items = useWarehouse(wsId, search || undefined);
  const stockValue = useStockValue(wsId);
  const [editing, setEditing] = useState<WarehouseItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [purchasing, setPurchasing] = useState(false);

  if (!current) {
    return (
      <>
        <PageHeader title="Склад" />
        <div className="p-6">
          <EmptyState icon={Package} title="Нет активного пространства" hint="Выберите или создайте пространство." />
        </div>
      </>
    );
  }

  const columns: Column<WarehouseItem>[] = [
    {
      key: 'name',
      header: 'Позиция',
      sortable: true,
      cell: (i) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{i.name}</div>
          {i.sku && <div className="truncate text-xs text-muted-foreground">{i.sku}</div>}
        </div>
      ),
    },
    {
      key: 'qty',
      header: 'Остаток',
      align: 'right',
      sortable: true,
      cell: (i) => (
        <span className="tabular-nums">
          {Number(i.qty)} <span className="text-muted-foreground">{i.unit}</span>
        </span>
      ),
      className: 'w-[120px]',
    },
    {
      key: 'avgCost',
      header: 'Себестоимость',
      align: 'right',
      cell: (i) =>
        Number(i.avgCost) === 0 && Number(i.qty) > 0 ? (
          <Badge variant="outline">цена не задана</Badge>
        ) : (
          <span className="tabular-nums text-muted-foreground">{formatRub(i.avgCost)}</span>
        ),
      className: 'w-[140px]',
    },
    {
      key: 'value',
      header: 'Стоимость',
      align: 'right',
      cell: (i) => <span className="font-medium tabular-nums">{formatRub(lineValue(i.qty, i.avgCost))}</span>,
      className: 'w-[140px]',
    },
    {
      key: 'status',
      header: '',
      cell: (i) => (i.isArchived ? <Badge variant="muted">архив</Badge> : null),
      className: 'w-[70px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Склад"
        breadcrumbs={[{ label: 'Справочники' }, { label: 'Склад' }]}
        actions={
          <>
            <Button variant="secondary" onClick={() => setPurchasing(true)}>
              <ShoppingCart className="h-4 w-4" /> Закупка
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Позиция
            </Button>
          </>
        }
      />

      <div className="px-6 py-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiCard
            label="Позиций"
            value={items.data ? String(items.data.length) : '—'}
          />
          <KpiCard
            label="Стоимость склада"
            value={stockValue.data ? formatRub(stockValue.data.value) : '—'}
          />
          <KpiCard
            label="Без себестоимости"
            value={
              items.data
                ? String(items.data.filter((i) => Number(i.avgCost) === 0 && Number(i.qty) > 0).length)
                : '—'
            }
            hint="Позиции с остатком, но без цены"
            tone={
              items.data && items.data.some((i) => Number(i.avgCost) === 0 && Number(i.qty) > 0)
                ? 'negative'
                : 'neutral'
            }
          />
        </div>
      </div>

      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или SKU"
              className="h-9 pl-8"
            />
          </div>
        </div>
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={items.data ?? []}
          columns={columns}
          rowKey={(i) => i.id}
          onRowClick={(i) => setEditing(i)}
          loading={items.isLoading}
          empty={
            <EmptyState
              icon={Package}
              title="Склад пуст"
              hint="Добавьте позицию вручную или сделайте закупку — остаток и себестоимость посчитаются автоматически."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Добавить позицию
                </Button>
              }
            />
          }
          mobileCards={(i) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{i.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {Number(i.qty)} {i.unit} · {formatRub(i.avgCost)}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] uppercase text-muted-foreground">Стоимость</div>
                <div className="text-sm font-medium tabular-nums">{formatRub(lineValue(i.qty, i.avgCost))}</div>
              </div>
            </div>
          )}
        />
      </div>

      <WarehouseItemForm
        wsId={current.id}
        open={creating || !!editing}
        initial={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <PurchaseSheet wsId={current.id} open={purchasing} onClose={() => setPurchasing(false)} />
    </>
  );
}

function WarehouseItemForm({
  wsId,
  open,
  initial,
  onClose,
}: {
  wsId: string;
  open: boolean;
  initial: WarehouseItem | null;
  onClose: () => void;
}) {
  const create = useCreateWarehouseItem(wsId);
  const update = useUpdateWarehouseItem(wsId);
  const adjust = useAdjustStock(wsId);
  const setCost = useSetItemCost(wsId);
  const del = useDeleteWarehouseItem(wsId);
  const [name, setName] = useState('');
  const [setCostValue, setSetCostValue] = useState('');
  const [setCostReason, setSetCostReason] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState('шт');
  const [openingQty, setOpeningQty] = useState('');
  const [openingCost, setOpeningCost] = useState('');
  const [adjustQty, setAdjustQty] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setSku(initial.sku ?? '');
      setUnit(initial.unit);
      setIsArchived(initial.isArchived);
      setAdjustQty(String(Number(initial.qty)));
    } else {
      setName('');
      setSku('');
      setUnit('шт');
      setOpeningQty('');
      setOpeningCost('');
      setIsArchived(false);
    }
    setSetCostValue('');
    setSetCostReason('');
    setError(null);
  }, [initial, open]);

  const onSave = async () => {
    setError(null);
    try {
      if (initial) {
        await update.mutateAsync({
          id: initial.id,
          name: name.trim(),
          sku: sku.trim() || null,
          unit: unit.trim() || 'шт',
          isArchived,
        });
        // Инвентаризация, если остаток изменили вручную.
        const newQty = parseQty(adjustQty);
        if (newQty !== null && newQty !== String(Number(initial.qty))) {
          await adjust.mutateAsync({ id: initial.id, newQty });
        }
      } else {
        await create.mutateAsync({
          name: name.trim(),
          sku: sku.trim() || undefined,
          unit: unit.trim() || undefined,
          openingQty: openingQty ? parseQty(openingQty) ?? undefined : undefined,
          openingCost: openingCost ? parseAmountInput(openingCost) ?? undefined : undefined,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const onDelete = async () => {
    if (!initial) return;
    await del.mutateAsync(initial.id);
    onClose();
  };

  // Установка себестоимости начального остатка (отдельная операция, не «Сохранить»).
  const onSetCost = async () => {
    if (!initial) return;
    setError(null);
    const cost = parseAmountInput(setCostValue);
    if (!cost) {
      setError('Укажите корректную себестоимость');
      return;
    }
    try {
      await setCost.mutateAsync({
        id: initial.id,
        unitCost: cost,
        reason: setCostReason.trim() || undefined,
      });
      toast.success('Себестоимость задана', { description: 'Применится к будущим продажам' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" hideClose className="sm:max-w-md">
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>{initial ? 'Позиция склада' : 'Новая позиция'}</SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>
          <SheetBody className="space-y-4">
            <FormField label="Название" htmlFor="w-name" required>
              <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="SKU / артикул" htmlFor="w-sku">
                <Input id="w-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
              </FormField>
              <FormField label="Ед. изм." htmlFor="w-unit">
                <Input id="w-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="шт" />
              </FormField>
            </div>

            {!initial ? (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Начальный остаток" htmlFor="w-oqty" hint="Опционально">
                  <Input id="w-oqty" inputMode="decimal" value={openingQty} onChange={(e) => setOpeningQty(e.target.value)} placeholder="0" />
                </FormField>
                <FormField label="Себестоимость ед." htmlFor="w-ocost">
                  <Input id="w-ocost" inputMode="decimal" value={openingCost} onChange={(e) => setOpeningCost(e.target.value)} placeholder="0" />
                </FormField>
              </div>
            ) : (
              <FormField
                label="Остаток (инвентаризация)"
                htmlFor="w-adj"
                hint="Изменение пересчитает остаток вручную. Себестоимость не меняется."
              >
                <Input id="w-adj" inputMode="decimal" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} />
              </FormField>
            )}

            {initial &&
              (Number(initial.avgCost) > 0 ? (
                // Уже оценено — только показываем (переоценка только через закупку/возврат).
                <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Себестоимость</span>
                    <span className="tabular-nums">{formatRub(initial.avgCost)}</span>
                  </div>
                </div>
              ) : Number(initial.qty) > 0 ? (
                // Остаток есть, цена не задана → даём проставить (POST /set-cost).
                <div className="space-y-2 rounded-md border border-border bg-secondary/40 p-3">
                  <div className="text-sm font-medium">Себестоимость не задана</div>
                  <p className="text-xs text-muted-foreground">
                    Позиция заведена остатком без цены. Укажите себестоимость единицы — повлияет на
                    будущие продажи. Деньги не двигаются (это не закупка).
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      inputMode="decimal"
                      value={setCostValue}
                      onChange={(e) => setSetCostValue(e.target.value)}
                      placeholder="Себест. ед., ₽"
                      aria-label="Себестоимость единицы"
                    />
                    <Input
                      value={setCostReason}
                      onChange={(e) => setSetCostReason(e.target.value)}
                      placeholder="Причина (опц.)"
                      aria-label="Причина"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={setCost.isPending || !setCostValue.trim()}
                    onClick={onSetCost}
                  >
                    {setCost.isPending ? 'Сохраняю…' : 'Задать себестоимость'}
                  </Button>
                </div>
              ) : (
                // Нет остатка → нечего оценивать (бэкенд: гвард qty>0).
                <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
                  Себестоимость не задана. Сначала заведите остаток (инвентаризация выше или закупка).
                </div>
              ))}

            {initial && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isArchived}
                  onChange={(e) => setIsArchived(e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                В архиве
              </label>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </SheetBody>
          <SheetFooter>
            {initial && (
              <Button variant="destructive" onClick={() => setConfirmDel(true)} className="sm:mr-auto">
                <Trash2 className="h-3.5 w-3.5" /> Удалить
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={onSave} disabled={!name.trim()}>
              Сохранить
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Удалить «${initial?.name ?? ''}»?`}
        description="Позиция переместится в архив, история закупок сохранится."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}

function PurchaseSheet({
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
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PurchaseLineInput[]>([
    { warehouseItemId: '', qty: '1', unitPrice: '' },
  ]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSupplierId('');
      setAccountId('');
      setNote('');
      setLines([{ warehouseItemId: '', qty: '1', unitPrice: '' }]);
      setError(null);
    }
  }, [open]);

  const total = useMemo(
    () => lines.reduce((acc, l) => acc + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0),
    [lines],
  );

  const submit = async () => {
    setError(null);
    if (!accountId) {
      setError('Выберите счёт');
      return;
    }
    const cleaned = lines
      .filter((l) => l.warehouseItemId && l.unitPrice)
      .map((l) => {
        const price = parseAmountInput(l.unitPrice);
        const q = parseQty(l.qty);
        return price && q ? { warehouseItemId: l.warehouseItemId, qty: q, unitPrice: price } : null;
      })
      .filter((x): x is PurchaseLineInput => x !== null);
    if (cleaned.length === 0) {
      setError('Добавьте хотя бы одну позицию: SKU + количество + цена');
      return;
    }
    try {
      await createPurchase.mutateAsync({
        accountId,
        supplierId: supplierId || null,
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
      <SheetContent side="right" hideClose className="sm:max-w-lg">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>Закупка на склад</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Поставщик" htmlFor="p-supplier">
              <Select id="p-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— Не указан —</option>
                {(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Счёт оплаты" htmlFor="p-account" required>
              <Select id="p-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
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

          <div className="space-y-2">
            <div className="text-sm font-medium">Позиции закупки</div>
            {lines.map((l, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <Select
                    value={l.warehouseItemId}
                    onChange={(e) =>
                      setLines((arr) => arr.map((x, j) => (j === i ? { ...x, warehouseItemId: e.target.value } : x)))
                    }
                  >
                    <option value="">— SKU —</option>
                    {(warehouse.data ?? [])
                      .filter((w) => !w.isArchived)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </Select>
                </div>
                <div className="w-16">
                  <Input
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                    placeholder="Кол."
                  />
                </div>
                <div className="w-28">
                  <Input
                    inputMode="decimal"
                    value={l.unitPrice}
                    onChange={(e) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))}
                    placeholder="Цена"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setLines((arr) => arr.filter((_, j) => j !== i))}
                  disabled={lines.length === 1}
                  aria-label="Удалить"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLines((arr) => [...arr, { warehouseItemId: '', qty: '1', unitPrice: '' }])}
            >
              <Plus className="h-3.5 w-3.5" /> Позиция
            </Button>
          </div>

          <FormField label="Примечание" htmlFor="p-note">
            <Input id="p-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Накладная №…" />
          </FormField>

          <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <div className="flex justify-between font-semibold">
              <span>Сумма закупки</span>
              <span className="tabular-nums">{formatRub(total)}</span>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={createPurchase.isPending}>
            {createPurchase.isPending ? 'Провожу…' : 'Провести закупку'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Нормализует ввод количества → строка с ≤3 знаками или null. */
function parseQty(input: string): string | null {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) return null;
  return cleaned;
}
