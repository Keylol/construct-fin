'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { D, add, toMoneyString, formatRub } from '@construct/shared';
import {
  Receipt as ReceiptIcon,
  Upload,
  Check,
  RotateCcw,
  ArrowLeftRight,
} from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { toast } from '@/components/ui/Toaster';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useOrders } from '@/hooks/useOrders';
import { useWarehouse } from '@/hooks/useWarehouse';
import {
  useCommitWbReceipt,
  useRevertWbReceipt,
  useWbReceiptPreview,
  useWbReceipts,
} from '@/hooks/useWbReceipts';
import type {
  WbCommitLine,
  WbLineTarget,
  WbReceiptListItem,
  WbReceiptPreview,
} from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';

/** Локальная строка разметки поверх позиции чека (split даёт несколько строк). */
type UiLine = {
  key: number;
  name: string;
  qty: string;
  unitPrice: string;
  sellerName: string | null;
  sellerInn: string | null;
  wbOrderHash: string | null;
  target: WbLineTarget;
  /** WAREHOUSE: '' = создать новый товар с именем из чека. */
  warehouseItemId: string;
  /** ORDER */
  orderId: string;
  salePrice: string;
};

const TARGET_LABELS: Record<WbLineTarget, string> = {
  WAREHOUSE: 'Склад',
  ORDER: 'В заказ',
  SKIPPED: 'Пропустить',
};

export default function WbReceiptPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  if (!wsId) {
    return (
      <>
        <PageHeader title="Разбор чека WB" />
        <div className="p-6">
          <EmptyState icon={ReceiptIcon} title="Нет активного пространства" hint="Выберите пространство." />
        </div>
      </>
    );
  }
  return <Wizard wsId={wsId} />;
}

function Wizard({ wsId }: { wsId: string }) {
  const router = useRouter();
  const accounts = useAccounts(wsId);
  const preview = useWbReceiptPreview(wsId);
  const commit = useCommitWbReceipt(wsId);
  const history = useWbReceipts(wsId);
  const revert = useRevertWbReceipt(wsId);

  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<WbReceiptPreview | null>(null);
  const [lines, setLines] = useState<UiLine[]>([]);
  const [moneyMode, setMoneyMode] = useState<'create' | 'link'>('create');
  const [linkTxId, setLinkTxId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [confirmRevert, setConfirmRevert] = useState<WbReceiptListItem | null>(null);

  const accountOptions = useMemo<ComboboxOption[]>(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );

  const runPreview = (file: File) => {
    if (!accountId) {
      toast.error('Сначала выберите счёт (карту), с которого оплачен чек');
      return;
    }
    setFileName(file.name);
    preview.mutate(
      { file, accountId },
      {
        onSuccess: (res) => {
          setParsed(res);
          // По умолчанию всё «в склад, создать новый товар» — самый частый
          // путь работает без лишних кликов; оператор меняет точечно.
          setLines(
            res.receipt.items.map((it, i) => ({
              key: i + 1,
              name: it.name,
              qty: it.qty,
              unitPrice: it.unitPrice,
              sellerName: it.sellerName,
              sellerInn: it.sellerInn,
              wbOrderHash: it.wbOrderHash,
              target: 'WAREHOUSE',
              warehouseItemId: '',
              orderId: '',
              salePrice: it.unitPrice,
            })),
          );
          setMoneyMode(res.candidates.length > 0 ? 'link' : 'create');
          setLinkTxId(res.candidates[0]?.id ?? '');
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось разобрать чек'),
      },
    );
  };

  const reset = () => {
    setParsed(null);
    setLines([]);
    setFileName(null);
    setLinkTxId('');
    if (fileRef.current) fileRef.current.value = '';
  };

  // Σ размеченных строк — Decimal, сверка с итогом чека вживую.
  const linesTotal = useMemo(
    () =>
      toMoneyString(
        lines.reduce((acc, l) => {
          const qty = Number(l.qty) > 0 ? l.qty : '0';
          return add(acc, D(qty).mul(l.unitPrice));
        }, D(0)),
      ),
    [lines],
  );
  const totalsMatch = parsed?.receipt.totalAmount
    ? D(linesTotal).equals(parsed.receipt.totalAmount)
    : false;

  const linesValid = lines.every((l) => {
    if (Number(l.qty) <= 0) return false;
    if (l.target === 'ORDER') return !!l.orderId;
    return true; // WAREHOUSE: пустой warehouseItemId = «создать новый» — валидно
  });

  const canCommit =
    !!parsed &&
    !!parsed.receipt.fpd &&
    !!parsed.receipt.receiptDate &&
    parsed.receipt.warnings.length === 0 &&
    !parsed.alreadyImported &&
    totalsMatch &&
    linesValid &&
    (moneyMode === 'create' || !!linkTxId) &&
    !commit.isPending;

  const doCommit = () => {
    if (!parsed || !canCommit) return;
    const payload = {
      accountId,
      money:
        moneyMode === 'link'
          ? ({ mode: 'link', transactionId: linkTxId } as const)
          : ({ mode: 'create', categoryId: categoryId || null } as const),
      fpd: parsed.receipt.fpd ?? '',
      fd: parsed.receipt.fd,
      checkNumber: parsed.receipt.checkNumber,
      receiptDate: parsed.receipt.receiptDate ?? '',
      totalAmount: parsed.receipt.totalAmount ?? '0',
      lines: lines.map<WbCommitLine>((l) => {
        const base = {
          name: l.name,
          qty: l.qty,
          unitPrice: l.unitPrice,
          sellerName: l.sellerName,
          sellerInn: l.sellerInn,
          wbOrderHash: l.wbOrderHash,
        };
        if (l.target === 'ORDER') {
          return { ...base, target: 'ORDER', orderId: l.orderId, salePrice: l.salePrice || undefined };
        }
        if (l.target === 'SKIPPED') return { ...base, target: 'SKIPPED' };
        return l.warehouseItemId
          ? { ...base, target: 'WAREHOUSE', warehouseItemId: l.warehouseItemId }
          : { ...base, target: 'WAREHOUSE', newItem: { name: l.name } };
      }),
    };
    commit.mutate(payload, {
      onSuccess: () => {
        toast.success('Чек проведён');
        reset();
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось провести чек'),
    });
  };

  return (
    <>
      <PageHeader
        title="Разбор чека WB"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Закупки', href: '/purchases' }, { label: 'Чек WB' }]}
        actions={
          <Button variant="secondary" onClick={() => router.push('/purchases')}>
            К закупкам
          </Button>
        }
      />
      <div className="space-y-4 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          PDF-чек с receipt.wb.ru: позиции распознаются автоматически, каждую вы
          отправляете на склад или в заказ. Деньги чека попадают в кассу ровно один
          раз — привязкой к операции карты из выписки или новым расходом.
        </p>

        {/* Шаг 1: счёт + файл */}
        <Card className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-[260px] flex-col gap-1 text-xs text-muted-foreground">
              <span>Счёт (карта ВБ)</span>
              <Combobox
                value={accountId}
                onChange={setAccountId}
                options={accountOptions}
                placeholder="Выберите счёт"
                searchPlaceholder="Счёт…"
                className="h-9"
              />
            </label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) runPreview(f);
              }}
            />
            <Button
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={preview.isPending}
            >
              <Upload className="h-4 w-4" />
              {preview.isPending ? 'Разбираю…' : fileName ? 'Другой файл' : 'Выбрать PDF-чек'}
            </Button>
            {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
            {parsed && (
              <Button variant="ghost" size="sm" onClick={reset}>
                Сбросить
              </Button>
            )}
          </div>
        </Card>

        {parsed && (
          <>
            {/* Шапка чека + предупреждения */}
            <Card className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span>
                  Чек {parsed.receipt.checkNumber ? `№${parsed.receipt.checkNumber}` : '—'} от{' '}
                  <b>{parsed.receipt.receiptDate ? formatDate(parsed.receipt.receiptDate) : '—'}</b>
                </span>
                <span>
                  Итого:{' '}
                  <b className="tabular-nums">
                    {parsed.receipt.totalAmount ? formatRub(parsed.receipt.totalAmount, 2) : '—'}
                  </b>
                </span>
                <span className="text-muted-foreground">ФПД {parsed.receipt.fpd ?? '—'}</span>
                <span className="text-muted-foreground">
                  Позиции: {parsed.receipt.items.length}
                </span>
              </div>
              {parsed.receipt.warnings.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <b>Чек распознан не полностью — проводить нельзя:</b>
                  <ul className="mt-1 list-disc pl-5">
                    {parsed.receipt.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {parsed.alreadyImported && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  Этот чек уже разобран {formatDate(parsed.alreadyImported.importedAt)} — повторно
                  провести нельзя. Найдите его в истории ниже (можно откатить).
                </div>
              )}
            </Card>

            {/* Разметка позиций */}
            <Card className="space-y-2 p-0">
              <div className="divide-y divide-border">
                {lines.map((line) => (
                  <LineRow
                    key={line.key}
                    wsId={wsId}
                    line={line}
                    onChange={(next) =>
                      setLines((ls) => ls.map((l) => (l.key === line.key ? next : l)))
                    }
                    onSplit={() =>
                      setLines((ls) => {
                        const idx = ls.findIndex((l) => l.key === line.key);
                        const src = ls[idx];
                        if (!src || Number(src.qty) <= 1) return ls;
                        const half = Math.floor(Number(src.qty) / 2);
                        const rest = Number(src.qty) - half;
                        const maxKey = Math.max(...ls.map((l) => l.key));
                        const a = { ...src, qty: String(rest) };
                        const b = { ...src, key: maxKey + 1, qty: String(half) };
                        return [...ls.slice(0, idx), a, b, ...ls.slice(idx + 1)];
                      })
                    }
                  />
                ))}
              </div>
            </Card>

            {/* Деньги чека */}
            <Card className="space-y-3">
              <div className="text-sm font-medium">Деньги чека</div>
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="money"
                    className="mt-1"
                    checked={moneyMode === 'link'}
                    disabled={parsed.candidates.length === 0}
                    onChange={() => setMoneyMode('link')}
                  />
                  <span>
                    Привязать к операции карты{' '}
                    <span className="text-muted-foreground">
                      {parsed.candidates.length === 0
                        ? '— подходящих не найдено (выписка ещё не загружена?)'
                        : `— найдено: ${parsed.candidates.length}`}
                    </span>
                  </span>
                </label>
                {moneyMode === 'link' && parsed.candidates.length > 0 && (
                  <div className="ml-6 flex flex-col gap-1">
                    {parsed.candidates.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="candidate"
                          checked={linkTxId === c.id}
                          onChange={() => setLinkTxId(c.id)}
                        />
                        <span className="tabular-nums">−{formatRub(c.amount, 2)}</span>
                        <span className="text-muted-foreground">
                          {formatDate(c.date)}
                          {c.description ? ` · ${c.description.slice(0, 60)}` : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="money"
                    className="mt-1"
                    checked={moneyMode === 'create'}
                    onChange={() => setMoneyMode('create')}
                  />
                  <span>
                    Создать расход на весь чек{' '}
                    <span className="text-muted-foreground">
                      — при импорте выписки строка подсветится как «уже учтено»
                    </span>
                  </span>
                </label>
                {moneyMode === 'create' && (
                  <div className="ml-6 w-[260px]">
                    <CategoryPicker wsId={wsId} value={categoryId} onChange={setCategoryId} />
                  </div>
                )}
              </div>
            </Card>

            {/* Итог и Провести */}
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn('text-sm tabular-nums', totalsMatch ? 'text-muted-foreground' : 'text-destructive')}>
                Σ строк {formatRub(linesTotal, 2)} / итог чека{' '}
                {parsed.receipt.totalAmount ? formatRub(parsed.receipt.totalAmount, 2) : '—'}
                {!totalsMatch && ' — не сходится'}
              </span>
              <Button onClick={doCommit} disabled={!canCommit}>
                <Check className="h-4 w-4" />
                {commit.isPending ? 'Провожу…' : 'Провести чек'}
              </Button>
            </div>
          </>
        )}

        {/* История разборов */}
        <ReceiptHistory
          items={history.data ?? []}
          onRevert={(r) => setConfirmRevert(r)}
        />
      </div>

      <ConfirmDialog
        open={!!confirmRevert}
        onOpenChange={(o) => !o && setConfirmRevert(null)}
        title="Откатить разбор чека?"
        description={
          confirmRevert
            ? `Партии склада будут сняты, позиции заказов убраны, ${
                confirmRevert.transactionCreated
                  ? 'созданный расход удалён'
                  : 'операция карты отвязана (останется в кассе)'
              }. Действие нельзя выполнить, если товар уже продан или позиция отгружена.`
            : ''
        }
        confirmText="Откатить"
        variant="destructive"
        loading={revert.isPending}
        onConfirm={() => {
          if (!confirmRevert) return;
          revert.mutate(confirmRevert.id, {
            onSuccess: () => {
              toast.success('Разбор чека откачен');
              setConfirmRevert(null);
            },
            onError: (e) => {
              toast.error(e instanceof Error ? e.message : 'Не удалось откатить');
              setConfirmRevert(null);
            },
          });
        }}
      />
    </>
  );
}

/** Одна строка разметки: назначение + зависимые поля. */
function LineRow({
  wsId,
  line,
  onChange,
  onSplit,
}: {
  wsId: string;
  line: UiLine;
  onChange: (next: UiLine) => void;
  onSplit: () => void;
}) {
  const lineTotal = useMemo(() => {
    const qty = Number(line.qty) > 0 ? line.qty : '0';
    return toMoneyString(D(qty).mul(line.unitPrice));
  }, [line.qty, line.unitPrice]);

  return (
    <div className="flex flex-wrap items-start gap-3 p-3">
      <div className="min-w-[260px] flex-1">
        <div className="text-sm font-medium">{line.name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {line.sellerName ?? 'продавец не распознан'}
          {line.wbOrderHash ? ` · заказ WB …${line.wbOrderHash.slice(-6)}` : ''}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Кол-во</span>
          <Input
            value={line.qty}
            inputMode="numeric"
            onChange={(e) => onChange({ ...line, qty: e.target.value })}
            className="h-9 w-[72px] text-right tabular-nums"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Цена · Σ</span>
          <div className="flex h-9 items-center whitespace-nowrap text-sm tabular-nums">
            {formatRub(line.unitPrice, 2)} · <b className="ml-1">{formatRub(lineTotal, 2)}</b>
          </div>
        </div>
        {Number(line.qty) > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-4"
            title="Разделить строку (часть в заказ, часть на склад)"
            onClick={onSplit}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Назначение */}
      <div className="flex flex-col gap-2">
        <div className="flex overflow-hidden rounded-md border border-border">
          {(Object.keys(TARGET_LABELS) as WbLineTarget[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange({ ...line, target: t })}
              className={cn(
                'px-2.5 py-1.5 text-xs transition-colors',
                line.target === t
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-secondary',
              )}
            >
              {TARGET_LABELS[t]}
            </button>
          ))}
        </div>

        {line.target === 'WAREHOUSE' && (
          <WarehousePicker
            wsId={wsId}
            value={line.warehouseItemId}
            onChange={(v) => onChange({ ...line, warehouseItemId: v })}
          />
        )}
        {line.target === 'ORDER' && (
          <div className="flex flex-col gap-2">
            <OrderPicker
              wsId={wsId}
              value={line.orderId}
              onChange={(v) => onChange({ ...line, orderId: v })}
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-[110px]">Продажная цена</span>
              <Input
                value={line.salePrice}
                inputMode="decimal"
                onChange={(e) => onChange({ ...line, salePrice: e.target.value })}
                className="h-8 w-[120px] text-right tabular-nums"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

/** Товар склада: пусто = создать новый с именем из чека. */
function WarehousePicker({
  wsId,
  value,
  onChange,
}: {
  wsId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const items = useWarehouse(wsId);
  const options = useMemo<ComboboxOption[]>(
    () => [
      { value: '', label: '+ Новый товар (имя из чека)' },
      ...(items.data ?? []).map((i) => ({
        value: i.id,
        label: i.name,
        description: `Остаток ${i.qty} ${i.unit}`,
      })),
    ],
    [items.data],
  );
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="+ Новый товар (имя из чека)"
      searchPlaceholder="Товар склада…"
      className="h-9 w-[260px]"
    />
  );
}

function OrderPicker({
  wsId,
  value,
  onChange,
}: {
  wsId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const orders = useOrders(wsId, { status: 'OPEN', limit: 100 });
  const options = useMemo<ComboboxOption[]>(
    () =>
      (orders.data?.pages.flatMap((p) => p.items) ?? []).map((o) => ({
        value: o.id,
        label: `${o.number}${o.client ? ` · ${o.client.name}` : ''}`,
        description: `Заказ ${formatRub(o.totalAmount)} · оплачено ${formatRub(o.paidAmount)}`,
      })),
    [orders.data],
  );
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Открытый заказ"
      searchPlaceholder="Номер или клиент…"
      className="h-9 w-[260px]"
    />
  );
}

function CategoryPicker({
  wsId,
  value,
  onChange,
}: {
  wsId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const cats = useCategories(wsId, 'EXPENSE');
  const options = useMemo<ComboboxOption[]>(
    () => [
      { value: '', label: 'Без категории' },
      ...(cats.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [cats.data],
  );
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Категория расхода"
      searchPlaceholder="Категория…"
      className="h-9"
    />
  );
}

function ReceiptHistory({
  items,
  onRevert,
}: {
  items: WbReceiptListItem[];
  onRevert: (r: WbReceiptListItem) => void;
}) {
  const columns: Column<WbReceiptListItem>[] = [
    {
      key: 'date',
      header: 'Чек',
      cell: (r) => (
        <span className="whitespace-nowrap tabular-nums">
          {r.checkNumber ? `№${r.checkNumber} · ` : ''}
          {formatDate(r.receiptDate)}
        </span>
      ),
    },
    {
      key: 'account',
      header: 'Счёт',
      cell: (r) => <span className="text-muted-foreground">{r.account.name}</span>,
    },
    {
      key: 'total',
      header: 'Сумма',
      cell: (r) => <span className="tabular-nums">{formatRub(r.totalAmount, 2)}</span>,
      className: 'text-right',
    },
    {
      key: 'money',
      header: 'Деньги',
      cell: (r) =>
        r.deletedAt ? (
          <Badge variant="muted">откачен</Badge>
        ) : r.transactionCreated ? (
          <Badge variant="muted">расход создан</Badge>
        ) : (
          <Badge variant="muted">привязан к выписке</Badge>
        ),
    },
    {
      key: 'lines',
      header: 'Строк',
      cell: (r) => <span className="tabular-nums">{r._count.lines}</span>,
      className: 'text-right w-[70px]',
    },
    {
      key: 'actions',
      header: '',
      cell: (r) =>
        r.deletedAt ? null : (
          <Button variant="ghost" size="sm" onClick={() => onRevert(r)} title="Откатить разбор">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ),
      className: 'w-[60px]',
    },
  ];

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">Разобранные чеки</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Пока ни одного разбора.</p>
      ) : (
        <div className="rounded-md border border-border bg-card">
          <DataTable data={items} columns={columns} rowKey={(r) => r.id} />
        </div>
      )}
    </div>
  );
}
