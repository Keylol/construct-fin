'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { D, add, toMoneyString, formatRub } from '@construct/shared';
import {
  Receipt as ReceiptIcon,
  Upload,
  Check,
  RotateCcw,
  Plus,
  X,
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
  ReceiptSource,
  WbCommitLine,
  WbLineTarget,
  WbReceiptListItem,
  WbReceiptPreview,
} from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';

/** Локальная строка разметки поверх позиции (все поля редактируемы оператором). */
type UiLine = {
  key: number;
  name: string;
  qty: string;
  unitPrice: string;
  sellerName: string | null;
  sellerInn: string | null;
  sourceRef: string | null;
  target: WbLineTarget;
  /** WAREHOUSE: '' = создать новый товар с именем из строки. */
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

const SOURCE_LABELS: Record<ReceiptSource, string> = {
  WB_CARD: 'Wildberries',
  DNS: 'ДНС',
  ONLINE_TRADE: 'Онлайн Трейд',
  MANUAL: 'Ручной ввод',
};

const MONEY_RX = /^\d+(\.\d{1,4})?$/;

/** Пустой шаблон превью для ручного ввода (без PDF). */
function manualPreview(): WbReceiptPreview {
  return {
    receipt: {
      source: 'MANUAL',
      receiptDate: null,
      checkNumber: null,
      fd: null,
      docNumber: null,
      totalAmount: null,
      items: [],
      warnings: [],
    },
    candidates: [],
    alreadyImported: null,
  };
}

let LINE_SEQ = 1;
function blankLine(): UiLine {
  return {
    key: LINE_SEQ++,
    name: '',
    qty: '1',
    unitPrice: '',
    sellerName: null,
    sellerInn: null,
    sourceRef: null,
    target: 'WAREHOUSE',
    warehouseItemId: '',
    orderId: '',
    salePrice: '',
  };
}

export default function ReceiptWizardPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  if (!wsId) {
    return (
      <>
        <PageHeader title="Разбор закупки" />
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
  const [note, setNote] = useState('');
  const [confirmRevert, setConfirmRevert] = useState<WbReceiptListItem | null>(null);

  const accountOptions = useMemo<ComboboxOption[]>(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );

  const seedLines = (res: WbReceiptPreview): UiLine[] =>
    res.receipt.items.map((it) => ({
      key: LINE_SEQ++,
      name: it.name,
      qty: it.qty,
      unitPrice: it.unitPrice,
      sellerName: it.sellerName,
      sellerInn: it.sellerInn,
      sourceRef: it.sourceRef,
      target: 'WAREHOUSE',
      warehouseItemId: '',
      orderId: '',
      salePrice: it.unitPrice,
    }));

  const runPreview = (file: File) => {
    if (!accountId) {
      toast.error('Сначала выберите счёт (карту), с которого оплачена закупка');
      return;
    }
    setFileName(file.name);
    preview.mutate(
      { file, accountId },
      {
        onSuccess: (res) => {
          setParsed(res);
          setLines(seedLines(res));
          setNote('');
          setMoneyMode(res.candidates.length > 0 ? 'link' : 'create');
          setLinkTxId(res.candidates[0]?.id ?? '');
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось разобрать документ'),
      },
    );
  };

  const startManual = () => {
    if (!accountId) {
      toast.error('Сначала выберите счёт (карту)');
      return;
    }
    setParsed(manualPreview());
    setLines([blankLine()]);
    setFileName(null);
    setNote('');
    setMoneyMode('create');
    setLinkTxId('');
  };

  const reset = () => {
    setParsed(null);
    setLines([]);
    setFileName(null);
    setLinkTxId('');
    setNote('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const patchLine = (key: number, next: UiLine) =>
    setLines((ls) => ls.map((l) => (l.key === key ? next : l)));
  const removeLine = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));
  const addLine = () => setLines((ls) => [...ls, blankLine()]);

  // Итог = Σ строк (Decimal). Распознанный итог — ориентир (предупреждение при расхождении).
  const linesTotal = useMemo(
    () =>
      toMoneyString(
        lines.reduce((acc, l) => {
          const qty = MONEY_RX.test(l.qty) && Number(l.qty) > 0 ? l.qty : '0';
          const price = MONEY_RX.test(l.unitPrice) ? l.unitPrice : '0';
          return add(acc, D(qty).mul(price));
        }, D(0)),
      ),
    [lines],
  );
  const recognizedTotal = parsed?.receipt.totalAmount ?? null;
  const totalsDiffer = !!recognizedTotal && !D(linesTotal).equals(recognizedTotal);
  const source = parsed?.receipt.source ?? 'MANUAL';

  const lineValid = (l: UiLine): boolean => {
    if (!l.name.trim()) return false;
    if (!MONEY_RX.test(l.qty) || Number(l.qty) <= 0) return false;
    if (!MONEY_RX.test(l.unitPrice) || Number(l.unitPrice) <= 0) return false;
    if (l.target === 'ORDER') {
      return !!l.orderId && (l.salePrice === '' || MONEY_RX.test(l.salePrice));
    }
    return true; // WAREHOUSE: пустой warehouseItemId = «создать новый» — валидно
  };
  const linesValid = lines.length > 0 && lines.every(lineValid);

  // Привязка возможна только к операции, чья сумма == Σ строк (анти-задвоение;
  // бэкенд это же проверяет). При правке строк список сужается.
  const linkable = (parsed?.candidates ?? []).filter((c) => D(c.amount).equals(linesTotal));

  // Распознанному источнику (не MANUAL) нужен номер документа — ключ дедупа,
  // иначе бэк вернёт 400. Парсер обычно его находит; это защита от края.
  const missingDocKey = source !== 'MANUAL' && !parsed?.receipt.docNumber;

  const canCommit =
    !!parsed &&
    !D(linesTotal).isZero() &&
    linesValid &&
    !parsed.alreadyImported &&
    !missingDocKey &&
    (moneyMode === 'create' || linkable.some((c) => c.id === linkTxId)) &&
    !commit.isPending;

  const doCommit = () => {
    if (!parsed || !canCommit) return;
    const payload = {
      accountId,
      source,
      money:
        moneyMode === 'link'
          ? ({ mode: 'link', transactionId: linkTxId } as const)
          : ({ mode: 'create', categoryId: categoryId || null } as const),
      docNumber: parsed.receipt.docNumber,
      fd: parsed.receipt.fd,
      checkNumber: parsed.receipt.checkNumber,
      receiptDate: parsed.receipt.receiptDate ?? new Date().toISOString(),
      totalAmount: linesTotal,
      note: note.trim() || null,
      lines: lines.map<WbCommitLine>((l) => {
        const base = {
          name: l.name.trim(),
          qty: l.qty,
          unitPrice: l.unitPrice,
          sellerName: l.sellerName,
          sellerInn: l.sellerInn,
          wbOrderHash: l.sourceRef,
        };
        if (l.target === 'ORDER') {
          return { ...base, target: 'ORDER', orderId: l.orderId, salePrice: l.salePrice || undefined };
        }
        if (l.target === 'SKIPPED') return { ...base, target: 'SKIPPED' };
        return l.warehouseItemId
          ? { ...base, target: 'WAREHOUSE', warehouseItemId: l.warehouseItemId }
          : { ...base, target: 'WAREHOUSE', newItem: { name: l.name.trim() } };
      }),
    };
    commit.mutate(payload, {
      onSuccess: () => {
        toast.success('Закупка проведена');
        reset();
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось провести'),
    });
  };

  const isManual = source === 'MANUAL';

  return (
    <>
      <PageHeader
        title="Разбор закупки"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Закупки', href: '/purchases' }, { label: 'Чек' }]}
        actions={
          <Button variant="secondary" onClick={() => router.push('/purchases')}>
            К закупкам
          </Button>
        }
      />
      <div className="space-y-4 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          PDF-чек (Wildberries, ДНС, Онлайн Трейд) распознаётся автоматически, либо
          введите позиции вручную. Каждую позицию отправьте на склад или в заказ; любое
          поле можно поправить. Деньги попадают в кассу ровно один раз — привязкой к
          операции карты или новым расходом.
        </p>

        {/* Шаг 1: счёт + файл / ручной ввод */}
        <Card className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-[260px] flex-col gap-1 text-xs text-muted-foreground">
              <span>Счёт (карта)</span>
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
            <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={preview.isPending}>
              <Upload className="h-4 w-4" />
              {preview.isPending ? 'Разбираю…' : fileName ? 'Другой файл' : 'Загрузить PDF-чек'}
            </Button>
            <Button variant="ghost" onClick={startManual} disabled={preview.isPending}>
              <Plus className="h-4 w-4" />
              Ввести вручную
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
            {/* Шапка документа + предупреждения */}
            <Card className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <Badge variant="muted">{SOURCE_LABELS[source]}</Badge>
                {!isManual && (
                  <span>
                    {parsed.receipt.checkNumber ? `№${parsed.receipt.checkNumber} · ` : ''}
                    {parsed.receipt.receiptDate ? formatDate(parsed.receipt.receiptDate) : 'без даты'}
                  </span>
                )}
                {recognizedTotal && (
                  <span className="text-muted-foreground">
                    распознанный итог{' '}
                    <b className="tabular-nums text-foreground">{formatRub(recognizedTotal, 2)}</b>
                  </span>
                )}
                {parsed.receipt.docNumber && (
                  <span className="text-muted-foreground">№ док. {parsed.receipt.docNumber}</span>
                )}
              </div>
              {parsed.receipt.warnings.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <b>Проверьте разбор — есть замечания:</b>
                  <ul className="mt-1 list-disc pl-5">
                    {parsed.receipt.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">Поправьте строки ниже и проведите.</p>
                </div>
              )}
              {parsed.alreadyImported && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  Этот документ уже разобран {formatDate(parsed.alreadyImported.importedAt)} — повторно
                  провести нельзя. Найдите его в истории ниже (можно откатить).
                </div>
              )}
              {missingDocKey && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  У документа {SOURCE_LABELS[source]} не распознан номер (нужен для защиты от повторной
                  загрузки). Проверьте файл или внесите позиции через «Ввести вручную».
                </div>
              )}
            </Card>

            {/* Позиции */}
            <Card className="space-y-2 p-0">
              <div className="divide-y divide-border">
                {lines.map((line) => (
                  <LineRow
                    key={line.key}
                    wsId={wsId}
                    line={line}
                    onChange={(next) => patchLine(line.key, next)}
                    onRemove={() => removeLine(line.key)}
                  />
                ))}
              </div>
              <div className="p-3">
                <Button variant="ghost" size="sm" onClick={addLine}>
                  <Plus className="h-3.5 w-3.5" />
                  Добавить строку
                </Button>
              </div>
            </Card>

            {/* Деньги */}
            <Card className="space-y-3">
              <div className="text-sm font-medium">Деньги закупки</div>
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="money"
                    className="mt-1"
                    checked={moneyMode === 'link'}
                    disabled={linkable.length === 0}
                    onChange={() => setMoneyMode('link')}
                  />
                  <span>
                    Привязать к операции карты{' '}
                    <span className="text-muted-foreground">
                      {linkable.length === 0
                        ? '— операций на сумму Σ строк не найдено'
                        : `— подходит: ${linkable.length}`}
                    </span>
                  </span>
                </label>
                {moneyMode === 'link' && !!linkTxId && !linkable.some((c) => c.id === linkTxId) && (
                  <p className="ml-6 text-xs text-warning">
                    Σ строк изменилась — выбранная операция больше не подходит по сумме. Выберите
                    другую или создайте расход.
                  </p>
                )}
                {moneyMode === 'link' && linkable.length > 0 && (
                  <div className="ml-6 flex flex-col gap-1">
                    {linkable.map((c) => (
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
                    Создать расход на Σ строк{' '}
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
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>Примечание {isManual && '(станет описанием расхода)'}</span>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={isManual ? 'напр. наличная закупка на рынке' : 'необязательно'}
                  className="h-9 max-w-lg"
                />
              </label>
            </Card>

            {/* Итог и Провести */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm tabular-nums">
                Σ строк <b>{formatRub(linesTotal, 2)}</b>
              </span>
              {totalsDiffer && (
                <span className="text-sm text-warning">
                  ≠ распознанный итог {formatRub(recognizedTotal!, 2)} — проверьте состав
                </span>
              )}
              <Button onClick={doCommit} disabled={!canCommit}>
                <Check className="h-4 w-4" />
                {commit.isPending ? 'Провожу…' : 'Провести'}
              </Button>
            </div>
          </>
        )}

        <ReceiptHistory items={history.data ?? []} onRevert={(r) => setConfirmRevert(r)} />
      </div>

      <ConfirmDialog
        open={!!confirmRevert}
        onOpenChange={(o) => !o && setConfirmRevert(null)}
        title="Откатить разбор?"
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
              toast.success('Разбор откачен');
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

/** Одна строка разметки: редактируемые имя/кол-во/цена + назначение. */
function LineRow({
  wsId,
  line,
  onChange,
  onRemove,
}: {
  wsId: string;
  line: UiLine;
  onChange: (next: UiLine) => void;
  onRemove: () => void;
}) {
  const lineTotal = useMemo(() => {
    const qty = MONEY_RX.test(line.qty) && Number(line.qty) > 0 ? line.qty : '0';
    const price = MONEY_RX.test(line.unitPrice) ? line.unitPrice : '0';
    return toMoneyString(D(qty).mul(price));
  }, [line.qty, line.unitPrice]);

  return (
    <div className="flex flex-wrap items-start gap-3 p-3">
      <div className="min-w-[240px] flex-1">
        <Input
          value={line.name}
          onChange={(e) => onChange({ ...line, name: e.target.value })}
          placeholder="Наименование"
          className="h-9"
        />
        {line.sellerName && (
          <div className="mt-0.5 text-xs text-muted-foreground">{line.sellerName}</div>
        )}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Кол-во</span>
          <Input
            value={line.qty}
            inputMode="decimal"
            onChange={(e) => onChange({ ...line, qty: e.target.value })}
            className="h-9 w-[72px] text-right tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Цена</span>
          <Input
            value={line.unitPrice}
            inputMode="decimal"
            onChange={(e) => onChange({ ...line, unitPrice: e.target.value })}
            className="h-9 w-[100px] text-right tabular-nums"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Σ</span>
          <div className="flex h-9 items-center whitespace-nowrap text-sm tabular-nums">
            {formatRub(lineTotal, 2)}
          </div>
        </div>
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

      <Button variant="ghost" size="sm" className="mt-6" title="Удалить строку" onClick={onRemove}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Товар склада: пусто = создать новый с именем из строки. */
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
      { value: '', label: '+ Новый товар (имя из строки)' },
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
      placeholder="+ Новый товар (имя из строки)"
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
      key: 'source',
      header: 'Источник',
      cell: (r) => <Badge variant="muted">{SOURCE_LABELS[r.source]}</Badge>,
    },
    {
      key: 'date',
      header: 'Документ',
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
      <h2 className="text-sm font-semibold">Разобранные закупки</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Пока ни одной.</p>
      ) : (
        <div className="rounded-md border border-border bg-card">
          <DataTable data={items} columns={columns} rowKey={(r) => r.id} />
        </div>
      )}
    </div>
  );
}
