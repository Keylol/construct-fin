'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, Check, History, Upload } from '@/components/ui/icons';
import { formatRub, sub, toMoneyString } from '@construct/shared';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Badge } from '@/components/ui/Badge';
import { FormField } from '@/components/ui/FormField';
import { useAccounts } from '@/hooks/useAccounts';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useOrders } from '@/hooks/useOrders';
import {
  rowToCommitRow,
  useImportCommit,
  useImportPreview,
} from '@/hooks/useImport';
import type { Order, PreviewResult } from '@/lib/types';
import { cn } from '@/lib/cn';

type Stage = 'upload' | 'preview' | 'done';

const SOURCE_LABEL: Record<PreviewResult['source'], string> = {
  ALFA_XLSX: 'Альфа-Банк (xlsx)',
  WB_PDF: 'Wildberries (pdf)',
  TINKOFF_PDF: 'Т-Банк (pdf)',
  GENERIC_CSV: 'CSV',
  GENERIC_XLSX: 'Excel',
};

export default function ImportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const accounts = useAccounts(wsId);

  const [stage, setStage] = useState<Stage>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  /** F3 (5d): привязки строк к заказам (rawIndex → orderId). */
  const [orderLinks, setOrderLinks] = useState<Record<number, string>>({});
  const [batchResult, setBatchResult] = useState<{
    batchId: string;
    imported: number;
    skipped: number;
  } | null>(null);

  const previewMut = useImportPreview(wsId ?? '');
  const commitMut = useImportCommit(wsId ?? '');

  const accountOptions = useMemo(
    () => (accounts.data ?? []).filter((a) => !a.isArchived),
    [accounts.data],
  );

  async function onUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !accountId || !wsId) return;
    const result = await previewMut.mutateAsync({ file, accountId });
    setPreview(result);
    setStage('preview');
  }

  async function onCommit() {
    if (!preview || !wsId) return;
    const rows = preview.rows.map((r) =>
      rowToCommitRow(r, null, orderLinks[r.rawIndex] ?? null),
    );
    const result = await commitMut.mutateAsync({
      filename: preview.filename,
      fileHash: preview.fileHash,
      source: preview.source,
      accountId,
      skipDuplicates,
      rows,
    });
    setBatchResult(result);
    setStage('done');
  }

  function reset() {
    setStage('upload');
    setFile(null);
    setPreview(null);
    setBatchResult(null);
    setOrderLinks({});
  }

  if (!wsId) {
    return (
      <>
        <PageHeader title="Импорт" />
        <div className="p-6">
          <EmptyState
            icon={Upload}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Импорт выписки"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Импорт' }]}
        actions={
          <Button variant="secondary" asChild>
            <Link href="/import/batches">
              <History className="h-4 w-4" /> История
            </Link>
          </Button>
        }
      />

      <div className="space-y-6 px-6 py-6">
        <Steps stage={stage} />

        {stage === 'upload' && (
          <Card className="max-w-2xl">
            <form onSubmit={onUploadSubmit} className="space-y-4">
              <FormField label="Счёт списания / зачисления" required>
                <Select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  required
                >
                  <option value="">— выберите счёт —</option>
                  {accountOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.type})
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField
                label="Файл выписки"
                hint="CSV / Excel / PDF, до 10 МБ"
              >
                <label
                  className={cn(
                    'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-secondary/40 p-6 text-sm transition-colors',
                    'hover:bg-secondary',
                  )}
                >
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <span className="text-foreground">
                    {file ? file.name : 'Выберите или перетащите файл'}
                  </span>
                  {file && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {(file.size / 1024).toFixed(1)} КБ
                    </span>
                  )}
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,.pdf,application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    required
                    className="hidden"
                  />
                </label>
              </FormField>

              {previewMut.error && (
                <p className="text-sm text-destructive">
                  {(previewMut.error as Error).message}
                </p>
              )}

              <Button
                type="submit"
                disabled={!file || !accountId || previewMut.isPending}
              >
                {previewMut.isPending ? 'Парсим…' : 'Предпросмотр'}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          </Card>
        )}

        {stage === 'preview' && preview && (
          <PreviewStage
            wsId={wsId}
            preview={preview}
            skipDuplicates={skipDuplicates}
            onToggleSkipDuplicates={setSkipDuplicates}
            orderLinks={orderLinks}
            onLinkOrder={(rawIndex, orderId) =>
              setOrderLinks((prev) => {
                const next = { ...prev };
                if (orderId) next[rawIndex] = orderId;
                else delete next[rawIndex];
                return next;
              })
            }
            onBack={reset}
            onCommit={onCommit}
            isCommitting={commitMut.isPending}
            commitError={commitMut.error ? (commitMut.error as Error).message : null}
          />
        )}

        {stage === 'done' && batchResult && (
          <Card className="max-w-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                <Check className="h-5 w-5" />
              </div>
              <div className="flex-1 space-y-3">
                <h2 className="text-base font-semibold tracking-tight">Готово</h2>
                <div className="space-y-1 text-sm">
                  <div>
                    Импортировано: <span className="font-semibold">{batchResult.imported}</span>
                  </div>
                  <div>
                    Пропущено (дубли):{' '}
                    <span className="font-semibold">{batchResult.skipped}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Batch ID: <code>{batchResult.batchId}</code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={reset}>Импортировать ещё</Button>
                  <Button variant="secondary" asChild>
                    <Link href="/transactions">К операциям</Link>
                  </Button>
                  <Button variant="ghost" asChild>
                    <Link href="/import/batches">История</Link>
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function Steps({ stage }: { stage: Stage }) {
  const items: Array<{ key: Stage; label: string }> = [
    { key: 'upload', label: 'Загрузка' },
    { key: 'preview', label: 'Предпросмотр' },
    { key: 'done', label: 'Готово' },
  ];
  const order = items.findIndex((i) => i.key === stage);
  return (
    <ol className="flex items-center gap-2">
      {items.map((it, i) => {
        const isActive = i === order;
        const isDone = i < order;
        return (
          <li key={it.key} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium tabular-nums',
                  isActive && 'border-primary bg-primary text-primary-foreground',
                  isDone && 'border-success bg-success text-success-foreground',
                  !isActive && !isDone && 'border-border text-muted-foreground',
                )}
              >
                {isDone ? <Check className="h-3 w-3" /> : i + 1}
              </div>
              <span
                className={cn(
                  'text-sm',
                  isActive || isDone ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {it.label}
              </span>
            </div>
            {i < items.length - 1 && (
              <span className="h-px w-8 bg-border" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PreviewStage({
  wsId,
  preview,
  skipDuplicates,
  onToggleSkipDuplicates,
  orderLinks,
  onLinkOrder,
  onBack,
  onCommit,
  isCommitting,
  commitError,
}: {
  wsId: string;
  preview: PreviewResult;
  skipDuplicates: boolean;
  onToggleSkipDuplicates: (v: boolean) => void;
  orderLinks: Record<number, string>;
  onLinkOrder: (rawIndex: number, orderId: string | null) => void;
  onBack: () => void;
  onCommit: () => void;
  isCommitting: boolean;
  commitError: string | null;
}) {
  const visibleRows = preview.rows.slice(0, 50);
  const willImport = skipDuplicates
    ? preview.rows.filter((r) => !r.isDuplicate).length
    : preview.rows.length;

  // F3 (5d): открытые долги для привязки приходных строк. Номера заказа в
  // назначении платежа обычно нет — выбор ручной, подсказка по совпадению суммы.
  const ordersQuery = useOrders(wsId, { limit: 200 });
  const unpaidOrders = useMemo<Order[]>(
    () =>
      (ordersQuery.data?.pages.flatMap((p) => p.items) ?? []).filter(
        (o) =>
          o.status !== 'CANCELLED' &&
          (o.paymentStatus === 'UNPAID' || o.paymentStatus === 'PARTIAL'),
      ),
    [ordersQuery.data],
  );
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Stat label="Источник" value={SOURCE_LABEL[preview.source]} />
          <Stat label="Кодировка" value={preview.encoding} />
          <Stat label="Всего строк" value={String(preview.stats.total)} />
          <Stat label="Валидных" value={String(preview.stats.valid)} />
          <Stat label="Не распознано" value={String(preview.stats.invalid)} />
          <Stat label="Дубли" value={String(preview.stats.duplicates)} />
        </div>
      </Card>

      <Card className="overflow-x-auto !p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-background">
            <tr className="text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Дата</th>
              <th className="px-3 py-2 text-right font-medium">Сумма</th>
              <th className="px-3 py-2 font-medium">Тип</th>
              <th className="px-3 py-2 font-medium">Контрагент</th>
              <th className="px-3 py-2 font-medium">Описание</th>
              <th className="px-3 py-2 font-medium">Заказ</th>
              <th className="px-3 py-2 font-medium">Флаг</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.rawIndex} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-muted-foreground tabular-nums">
                  {r.rawIndex}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {r.date.slice(0, 10)}
                </td>
                <td
                  className={cn(
                    'whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums',
                    r.type === 'INCOME' ? 'text-success' : 'text-destructive',
                  )}
                >
                  {r.type === 'INCOME' ? '+' : '−'} {formatRub(r.amount)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.type}</td>
                <td
                  className="max-w-[200px] truncate px-3 py-2"
                  title={r.counterpartyName ?? ''}
                >
                  {r.counterpartyName ?? '—'}
                  {r.resolvedCounterpartyId && (
                    <Badge variant="outline" className="ml-1.5">
                      связан
                    </Badge>
                  )}
                </td>
                <td className="max-w-[300px] truncate px-3 py-2" title={r.description ?? ''}>
                  {r.description ?? '—'}
                </td>
                {/* F3 (5d): привязка прихода к заказу — строка станет оплатой
                    заказа (ORDER_PAYMENT). «✓» — долг совпадает с суммой строки. */}
                <td className="px-3 py-2">
                  {r.type === 'INCOME' && !r.isDuplicate ? (
                    <OrderLinkCombobox
                      orders={unpaidOrders}
                      rowAmount={r.amount}
                      value={orderLinks[r.rawIndex] ?? ''}
                      onChange={(orderId) => onLinkOrder(r.rawIndex, orderId)}
                    />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.isDuplicate && <Badge variant="muted">дубль</Badge>}
                  {r.errors.length > 0 && <Badge variant="destructive">ошибка</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.rows.length > 50 && (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Показано первые 50 из {preview.rows.length}
          </p>
        )}
      </Card>

      <Card className="space-y-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={skipDuplicates}
            onChange={(e) => onToggleSkipDuplicates(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-primary"
          />
          <span className="text-sm">
            Пропустить дубли ({preview.stats.duplicates})
          </span>
        </label>
        <div className="text-sm">
          К импорту: <span className="font-semibold">{willImport}</span> операций
        </div>
        {commitError && <p className="text-sm text-destructive">{commitError}</p>}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onBack} disabled={isCommitting}>
            Назад
          </Button>
          <Button onClick={onCommit} disabled={isCommitting || willImport === 0}>
            {isCommitting ? 'Импортируем…' : `Импортировать ${willImport}`}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * F3 (5d): комбобокс привязки приходной строки к заказу. Options строятся
 * per-строка (тот же паттерн, что SKU-строки в закупке), потому что метка
 * «✓» — подсказка «долг совпадает с суммой строки» — зависит от суммы строки.
 */
function OrderLinkCombobox({
  orders,
  rowAmount,
  value,
  onChange,
}: {
  orders: Order[];
  rowAmount: string;
  value: string;
  onChange: (orderId: string | null) => void;
}) {
  const options = useMemo<ComboboxOption[]>(
    () =>
      orders.map((o) => {
        const due = sub(o.totalAmount, o.paidAmount);
        const match = due.eq(rowAmount);
        return {
          value: o.id,
          label: `${match ? '✓ ' : ''}${o.number}${o.title ? ` · ${o.title}` : ''}`,
          description: `${o.client?.name ?? 'без клиента'} · долг ${formatRub(toMoneyString(due))}`,
        };
      }),
    [orders, rowAmount],
  );
  return (
    <Combobox
      value={value}
      onChange={(v) => onChange(v || null)}
      options={options}
      placeholder="—"
      searchPlaceholder="Номер, название или клиент…"
      clearLabel="— Без привязки —"
      emptyLabel="Нет открытых долгов"
      className="h-8 sm:h-8 min-w-[180px] text-xs"
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums">{value}</div>
    </div>
  );
}
