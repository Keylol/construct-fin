'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { Plus, Package, X, Trash2, ShoppingCart } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { parseAmountInput } from '@construct/shared';
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
import type { OpenLotView, WarehouseItem, WarehouseSection } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useRole } from '@/hooks/useRole';
import { Input } from '@/components/ui/Input';
import { SearchField } from '@/components/ui/SearchField';
import { FilterField } from '@/components/ui/FilterField';
import { StatusDot } from '@/components/ui/StatusDot';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalClose,
} from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toaster';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Checkbox } from '@/components/ui/Checkbox';
import { KpiRow } from '@/components/ui/KpiRow';
import { Select } from '@/components/ui/Select';
import { useCounterparties } from '@/hooks/useCounterparties';
import { cn } from '@/lib/cn';
import {
  NO_SECTION,
  WAREHOUSE_SECTIONS,
  isWarehouseSection,
  sectionLabel,
  sectionRank,
} from '@/lib/warehouse-sections';

// section — ключ раздела (CASE, GPU…) или NONE; пусто — все разделы.
const DEFAULTS = { q: '', section: '' };
const FILTERS = flatCodec(DEFAULTS);

// F5: открытые партии — «что лежит и откуда» (поставщик/счёт закупки).
function lotColumns(unit: string): Column<OpenLotView>[] {
  return [
    {
      key: 'received',
      header: 'Поступила',
      cell: (l) => (
        <>
          <span className="tabular-nums">{formatDate(l.receivedAt)}</span>
          {l.supplier && (
            <div className="text-xs text-muted-foreground">
              {l.supplier.name}
              {l.account ? ` · ${l.account.name}` : ''}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'qty',
      header: 'Остаток',
      align: 'right',
      cell: (l) => `${Number(l.qtyRemaining)} из ${Number(l.qtyInitial)} ${unit}`,
    },
    {
      key: 'cost',
      header: 'Себестоимость',
      align: 'right',
      cell: (l) => <Money value={l.unitCost} tone="plain" className="text-muted-foreground" />,
    },
  ];
}
function LotCard({ l, unit }: { l: OpenLotView; unit: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <div className="font-medium tabular-nums">{formatDate(l.receivedAt)}</div>
        <div className="text-xs text-muted-foreground">
          {Number(l.qtyRemaining)} из {Number(l.qtyInitial)} {unit}
          {l.supplier ? ` · ${l.supplier.name}` : ''}
        </div>
      </div>
      <Money value={l.unitCost} tone="plain" className="text-muted-foreground" />
    </div>
  );
}

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function WarehousePage() {
  return (
    <Suspense>
      <WarehouseView />
    </Suspense>
  );
}

/** Чип раздела — переключатель фильтра; активный залит. Высота как у полей FilterBar. */
function SectionChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-sm border px-2.5 text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background text-foreground hover:bg-secondary',
      )}
    >
      {label}
      <span className={cn('text-xs tabular-nums', active ? 'opacity-80' : 'text-muted-foreground')}>
        {count}
      </span>
    </button>
  );
}

function lineValue(qty: string, avg: string): number {
  return (Number(qty) || 0) * (Number(avg) || 0);
}

function WarehouseView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [filters, setFilters] = useUrlFilters(FILTERS);
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(filters.q);
  const items = useWarehouse(wsId, debouncedSearch || undefined);
  const stockValue = useStockValue(wsId);
  const [editing, setEditing] = useState<WarehouseItem | null>(null);
  const [creating, setCreating] = useState(false);
  // «/» — в поиск, «n» — создать: список листают с клавиатуры.
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });
  const [purchasing, setPurchasing] = useState(false);

  if (!current) return null;

  // Разделы как в складской таблице: группы в порядке WAREHOUSE_SECTIONS,
  // внутри — по названию. Чипы сверху сужают список до одного раздела.
  const all = items.data ?? [];
  const sectionCounts = new Map<string, number>();
  for (const i of all) {
    const k = i.section ?? NO_SECTION;
    sectionCounts.set(k, (sectionCounts.get(k) ?? 0) + 1);
  }
  const visible = all
    .filter((i) => !filters.section || (i.section ?? NO_SECTION) === filters.section)
    .sort(
      (a, b) =>
        sectionRank(a.section) - sectionRank(b.section) || a.name.localeCompare(b.name, 'ru'),
    );
  const chipKeys = [...WAREHOUSE_SECTIONS.map((s): string => s.value), NO_SECTION].filter(
    (k) => (sectionCounts.get(k) ?? 0) > 0,
  );

  const columns: Column<WarehouseItem>[] = [
    {
      key: 'name',
      header: 'Наименование',
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
          <StatusDot tone="warning" label="не задана" />
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
      key: 'supplier',
      header: 'Поставщик',
      cell: (i) => (
        <span className="truncate text-sm text-muted-foreground">
          {i.defaultSupplier?.name ?? '—'}
        </span>
      ),
      className: 'w-[180px]',
    },
    {
      key: 'status',
      header: '',
      cell: (i) => (i.isArchived ? <StatusDot tone="muted" label="архив" /> : null),
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
        <KpiRow loading={items.isLoading} count={3}>
          <KpiCard
            label="Позиций"
            value={items.data ? String(items.data.length) : '—'}
          />
          <KpiCard
            label="Стоимость запасов"
            value={stockValue.data ? <Money value={stockValue.data.value} /> : '—'}
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
        </KpiRow>
      </div>
      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <FilterField label="Поиск">
            <SearchField
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Название, артикул, цвет или заметка"
            />
          </FilterField>
        </div>
        {chipKeys.length > 0 && (
          <FilterField label="Раздел">
            <div className="flex flex-wrap gap-1.5">
              <SectionChip
                label="Все"
                count={all.length}
                active={!filters.section}
                onClick={() => setFilters({ ...filters, section: '' })}
              />
              {chipKeys.map((k) => (
                <SectionChip
                  key={k}
                  label={sectionLabel(k)}
                  count={sectionCounts.get(k) ?? 0}
                  active={filters.section === k}
                  onClick={() =>
                    setFilters({ ...filters, section: filters.section === k ? '' : k })
                  }
                />
              ))}
            </div>
          </FilterField>
        )}
        <FilterReset onClick={() => setFilters(DEFAULTS)} />
      </FilterBar>


      <div className="bg-card">
        <DataTable
          data={visible}
          columns={columns}
          rowKey={(i) => i.id}
          onRowClick={(i) => setEditing(i)}
          groupBy={(i) => i.section ?? NO_SECTION}
          renderGroupHeader={(key, rows) => (
            <div className="flex items-baseline justify-between gap-3">
              <span className="uppercase tracking-wide text-foreground">
                {sectionLabel(key)}
                <span className="ml-2 normal-case tracking-normal text-muted-foreground">
                  {rows.reduce((s, r) => s + (Number(r.qty) || 0), 0)} шт
                </span>
              </span>
              <Money
                value={rows.reduce((s, r) => s + lineValue(r.qty, r.avgCost), 0)}
                tone="plain"
              />
            </div>
          )}
          loading={items.isLoading}
          error={items.error}
          onRetry={() => void items.refetch()}
          empty={
            filters.q.trim() || filters.section ? (
              <EmptyState
                icon={Package}
                title={
                  filters.q.trim()
                    ? `Ничего не найдено по запросу «${filters.q.trim()}»`
                    : `В разделе «${sectionLabel(filters.section)}» пусто`
                }
                hint="Позиция ищется по названию, артикулу, цвету и заметке."
                action={
                  <Button variant="secondary" onClick={() => setFilters(DEFAULTS)}>
                    Сбросить фильтры
                  </Button>
                }
              />
            ) : (
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
            )
          }
          mobileCards={(i) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{i.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {sectionLabel(i.section ?? NO_SECTION)} · {Number(i.qty)} {i.unit} ·{' '}
                  <Money value={i.avgCost} tone="plain" />
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
        defaultSection={isWarehouseSection(filters.section) ? filters.section : null}
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
  defaultSection,
  onClose,
}: {
  wsId: string;
  open: boolean;
  initial: WarehouseItem | null;
  /** Раздел новой позиции — из активного чипа раздела. */
  defaultSection: WarehouseSection | null;
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
  const [section, setSection] = useState<WarehouseSection | ''>('');
  const [supplierId, setSupplierId] = useState('');
  const suppliers = useCounterparties(open ? wsId : null, undefined, false, 'SUPPLIER');
  // Раздел по умолчанию читаем только в момент открытия формы: смена чипа
  // не должна сбрасывать уже введённое в открытой форме.
  const defaultSectionRef = useRef(defaultSection);
  defaultSectionRef.current = defaultSection;
  const [unit, setUnit] = useState('шт');
  const [openingQty, setOpeningQty] = useState('');
  const [openingCost, setOpeningCost] = useState('');
  const [adjustQty, setAdjustQty] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const { canDelete } = useRole();
  const [confirmWo, setConfirmWo] = useState(false);
  // F1/F2: позицию с остатком нельзя удалять/архивировать (бэкенд вернёт 400).
  // qty — количество, не деньги → Number допустим (N-19 про деньги).
  const hasStock = initial ? Number(initial.qty) > 0 : false;

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setSku(initial.sku ?? '');
      setColor(initial.color ?? '');
      setSection(initial.section ?? '');
      setSupplierId(initial.defaultSupplierId ?? '');
      setUnit(initial.unit);
      setIsArchived(initial.isArchived);
      setAdjustQty(String(Number(initial.qty)));
    } else {
      setName('');
      setSku('');
      setColor('');
      setSection(defaultSectionRef.current ?? '');
      setSupplierId('');
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

  // Несохранённый ввод — против значений, с которыми форма открылась.
  const dirty = initial
    ? name !== initial.name ||
      sku !== (initial.sku ?? '') ||
      color !== (initial.color ?? '') ||
      section !== (initial.section ?? '') ||
      supplierId !== (initial.defaultSupplierId ?? '') ||
      unit !== initial.unit ||
      isArchived !== initial.isArchived ||
      adjustQty !== String(Number(initial.qty))
    : !!name.trim() || !!sku.trim() || !!color.trim() || !!openingQty || !!openingCost;

  const onSave = async () => {
    setError(null);
    try {
      if (initial) {
        await update.mutateAsync({
          id: initial.id,
          name: name.trim(),
          sku: sku.trim() || null,
          color: color.trim() || null,
          section: section || null,
          defaultSupplierId: supplierId || null,
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
          section: section || null,
          defaultSupplierId: supplierId || null,
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
      <Modal open={open} onOpenChange={(o) => !o && onClose()} dirty={dirty}>
        <ModalContent size="lg" hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>{initial ? 'Позиция склада' : 'Новая позиция'}</ModalTitle>
            <ModalClose asChild>
              <Button variant="ghost" size="icon" aria-label="Закрыть">
                <X className="h-4 w-4" />
              </Button>
            </ModalClose>
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
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Раздел" htmlFor="w-section">
                <Select
                  id="w-section"
                  value={section}
                  onChange={(e) =>
                    setSection(isWarehouseSection(e.target.value) ? e.target.value : '')
                  }
                >
                  <option value="">— Без раздела —</option>
                  {WAREHOUSE_SECTIONS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Поставщик" htmlFor="w-supplier">
                <Select
                  id="w-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">— Не указан —</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
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
                  <MoneyInput id="w-ocost" value={openingCost} onChange={(e) => setOpeningCost(e.target.value)} placeholder="0" />
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
                    <MoneyInput
                      value={setCostValue}
                      onChange={(e) => setSetCostValue(e.target.value)}
                      placeholder="Себест. ед."
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
                  <DataTable
                    data={lots.data ?? []}
                    columns={lotColumns(initial.unit)}
                    rowKey={(l) => l.id}
                    mobileCards={(l) => <LotCard l={l} unit={initial.unit} />}
                  />
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
              <Checkbox
                label="В архиве"
                hint={hasStock && !isArchived ? 'Сначала спишите остаток' : undefined}
                checked={isArchived}
                // F2: архивировать позицию с остатком нельзя (стоимость исчезла
                // бы из отчётов). Разрешаем только разархивацию.
                disabled={hasStock && !isArchived}
                onChange={(e) => setIsArchived(e.target.checked)}
              />
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </ModalBody>
          <ModalFooter>
            {initial && canDelete && (
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
            <ModalClose asChild>
              <Button type="button" variant="secondary">
                Отмена
              </Button>
            </ModalClose>
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
