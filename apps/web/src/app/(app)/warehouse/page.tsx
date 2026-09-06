'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Package, Search, X, Trash2, ShoppingCart } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { formatRub, parseAmountInput } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import {
  useWarehouse,
  useStockValue,
  useCreateWarehouseItem,
  useUpdateWarehouseItem,
  useAdjustStock,
  useSetItemCost,
  useWriteOffStock,
  useItemLots,
  useDeleteWarehouseItem,
} from '@/hooks/useWarehouse';
import { PurchaseModal } from '@/components/purchases/PurchaseModal';
import { parseQty } from '@/lib/qty';
import { formatDate } from '@/lib/dates';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { WarehouseItem } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { FilterBar } from '@/components/ui/FilterBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toaster';

function lineValue(qty: string, avg: string): number {
  return (Number(qty) || 0) * (Number(avg) || 0);
}

export default function WarehousePage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [search, setSearch] = useState('');
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(search);
  const items = useWarehouse(wsId, debouncedSearch || undefined);
  const stockValue = useStockValue(wsId);
  const [editing, setEditing] = useState<WarehouseItem | null>(null);
  const [creating, setCreating] = useState(false);
  // «/» — в поиск, «n» — создать: список листают с клавиатуры.
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });
  const [purchasing, setPurchasing] = useState(false);

  if (!current) return null;

  const columns: Column<WarehouseItem>[] = [
    {
      key: 'name',
      header: 'Позиция',
      cell: (i) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{i.name}</div>
          {(i.sku || i.color) && (
            <div className="truncate text-xs text-muted-foreground">
              {[i.sku, i.color].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'qty',
      header: 'Остаток',
      align: 'right',
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
          <Badge variant="outline">себестоимость не задана</Badge>
        ) : (
          <Money value={i.avgCost} tone="plain" className="text-muted-foreground" />
        ),
      className: 'w-[140px]',
    },
    {
      key: 'value',
      header: 'Стоимость',
      align: 'right',
      cell: (i) => <Money value={lineValue(i.qty, i.avgCost)} className="font-medium" />,
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
            label="Стоимость запасов"
            value={stockValue.data ? formatRub(stockValue.data.value) : '—'}
          />
          <KpiCard
            label="Без себестоимости"
            value={
              items.data
                ? String(items.data.filter((i) => Number(i.avgCost) === 0 && Number(i.qty) > 0).length)
                : '—'
            }
            hint="Позиции с остатком, но без себестоимости"
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
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или артикулу"
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
          error={items.error}
          onRetry={() => void items.refetch()}
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
                <div className="text-sm font-medium tabular-nums"><Money value={lineValue(i.qty, i.avgCost)} /></div>
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
      <PurchaseModal wsId={current.id} open={purchasing} onClose={() => setPurchasing(false)} />
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
  const writeOff = useWriteOffStock(wsId);
  const del = useDeleteWarehouseItem(wsId);
  const lots = useItemLots(wsId, open && initial ? initial.id : null);
  const [name, setName] = useState('');
  const [woQty, setWoQty] = useState('');
  const [woReason, setWoReason] = useState('');
  const [setCostValue, setSetCostValue] = useState('');
  const [setCostReason, setSetCostReason] = useState('');
  const [sku, setSku] = useState('');
  const [color, setColor] = useState('');
  const [unit, setUnit] = useState('шт');
  const [openingQty, setOpeningQty] = useState('');
  const [openingCost, setOpeningCost] = useState('');
  const [adjustQty, setAdjustQty] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmWo, setConfirmWo] = useState(false);
  // F1/F2: позицию с остатком нельзя удалять/архивировать (бэкенд вернёт 400).
  // qty — количество, не деньги → Number допустим (N-19 про деньги).
  const hasStock = initial ? Number(initial.qty) > 0 : false;

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setSku(initial.sku ?? '');
      setColor(initial.color ?? '');
      setUnit(initial.unit);
      setIsArchived(initial.isArchived);
      setAdjustQty(String(Number(initial.qty)));
    } else {
      setName('');
      setSku('');
      setColor('');
      setUnit('шт');
      setOpeningQty('');
      setOpeningCost('');
      setIsArchived(false);
    }
    setSetCostValue('');
    setSetCostReason('');
    setWoQty('');
    setWoReason('');
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
          color: color.trim() || null,
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
          color: color.trim() || undefined,
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

  // F4: списание — FIFO-партии + неденежный убыток в P&L (кассу не двигает).
  const onWriteOff = async () => {
    if (!initial) return;
    setError(null);
    const qty = parseQty(woQty);
    if (!qty) {
      setError('Укажите корректное количество списания');
      return;
    }
    if (!woReason.trim()) {
      setError('Укажите причину списания');
      return;
    }
    try {
      await writeOff.mutateAsync({ id: initial.id, qty, reason: woReason.trim() });
      toast.success('Списано со склада', {
        description: 'Убыток учтён в прибыли; деньги не двигались',
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <>
      <Modal open={open} onOpenChange={(o) => !o && onClose()}>
        <ModalContent size="lg" hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>{initial ? 'Позиция склада' : 'Новая позиция'}</ModalTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </ModalHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
          <ModalBody className="space-y-4">
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
            <FormField label="Цвет" htmlFor="w-color" hint="Свободный текст, на учёт не влияет">
              <Input
                id="w-color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="напр. белый / RAL 9016"
              />
            </FormField>

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
                    <Money value={initial.avgCost} />
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
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={setCost.isPending || !setCostValue.trim()}
                    onClick={onSetCost}
                  >
                    {setCost.isPending ? 'Сохранение…' : 'Задать себестоимость'}
                  </Button>
                </div>
              ) : (
                // Нет остатка → нечего оценивать (бэкенд: гвард qty>0).
                <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
                  Себестоимость не задана. Сначала заведите остаток (инвентаризация выше или закупка).
                </div>
              ))}

            {/* F5: открытые партии — «что лежит и откуда» (поставщик/счёт закупки). */}
            {initial && (lots.data?.length ?? 0) > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">
                  Партии на складе
                </div>
                <div className="overflow-hidden rounded-md border border-border">
                  <table className="w-full text-base">
                    <tbody>
                      {lots.data!.map((l) => (
                        <tr key={l.id} className="border-b border-border last:border-0">
                          <td className="px-3 py-1.5 tabular-nums">
                            {formatDate(l.receivedAt)}
                            {l.supplier && (
                              <div className="text-xs text-muted-foreground">
                                {l.supplier.name}
                                {l.account ? ` · ${l.account.name}` : ''}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {Number(l.qtyRemaining)} из {Number(l.qtyInitial)} {initial.unit}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground"><Money value={l.unitCost} tone="plain" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* F4: списание — брак/порча/недостача. Партии уходят по FIFO,
                убыток фиксируется в прибыли; касса не двигается. */}
            {initial && Number(initial.qty) > 0 && (
              <div className="space-y-2 rounded-md border border-border bg-secondary/40 p-3">
                <div className="text-sm font-medium">Списание (брак / порча / недостача)</div>
                <p className="text-xs text-muted-foreground">
                  Списывает партии по ФИФО и фиксирует убыток в прибыли. Деньги не двигаются —
                  они ушли при закупке.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    inputMode="decimal"
                    value={woQty}
                    onChange={(e) => setWoQty(e.target.value)}
                    placeholder={`Кол-во, ${initial.unit}`}
                    aria-label="Количество списания"
                  />
                  <Input
                    value={woReason}
                    onChange={(e) => setWoReason(e.target.value)}
                    placeholder="Причина (обязательно)"
                    aria-label="Причина списания"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!woQty.trim() || !woReason.trim()}
                  loading={writeOff.isPending}
                  onClick={() => setConfirmWo(true)}
                >
                  Списать
                </Button>
              </div>
            )}

            {initial && (
              <label
                className={`flex items-center gap-2 text-sm${
                  hasStock && !isArchived ? ' cursor-not-allowed opacity-60' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={isArchived}
                  // F2: архивировать позицию с остатком нельзя (стоимость исчезла
                  // бы из отчётов). Разрешаем только разархивацию.
                  disabled={hasStock && !isArchived}
                  onChange={(e) => setIsArchived(e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                В архиве
                {hasStock && !isArchived && (
                  <span className="text-xs text-muted-foreground">— сначала спишите остаток</span>
                )}
              </label>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </ModalBody>
          <ModalFooter>
            {initial && (
              <Button
                type="button"
                variant="destructive"
                // F1: удалить позицию с остатком нельзя — кнопка задизейблена
                // (иначе клик молча провалился бы через ConfirmDialog, K9).
                onClick={() => setConfirmDel(true)}
                disabled={hasStock}
                title={hasStock ? 'Сначала спишите или продайте остаток' : undefined}
                className="sm:mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" /> Удалить
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button
              type="submit"
              loading={create.isPending || update.isPending || adjust.isPending}
              disabled={!name.trim()}
            >
              Сохранить
            </Button>
          </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Архивировать «${initial?.name ?? ''}»?`}
        description="Позиция переместится в архив, история закупок сохранится."
        confirmText="В архив"
        onConfirm={onDelete}
        loading={del.isPending}
      />
      {/* Списание необратимо влияет на прибыль — подтверждаем явно. */}
      <ConfirmDialog
        open={confirmWo}
        onOpenChange={setConfirmWo}
        title={`Списать ${woQty.trim()} ${initial?.unit ?? ''} «${initial?.name ?? ''}»?`}
        description={`Причина: ${woReason.trim() || '—'}. Партии уйдут по ФИФО, убыток зафиксируется в прибыли. Деньги не двигаются.`}
        confirmText="Списать"
        onConfirm={onWriteOff}
        loading={writeOff.isPending}
      />
    </>
  );
}
