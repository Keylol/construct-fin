'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, Check, History, Upload } from '@/components/ui/icons';
import { formatRub } from '@construct/shared';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { FormField } from '@/components/ui/FormField';
import { useAccounts } from '@/hooks/useAccounts';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  rowToCommitRow,
  useImportCommit,
  useImportPreview,
} from '@/hooks/useImport';
import type { AccountType, PreviewResult } from '@/lib/types';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/plural';
import { ACCOUNT_TYPE_LABEL, IMPORT_SOURCE_LABEL } from '@/lib/labels';

type Stage = 'upload' | 'preview' | 'done';

export default function ImportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const accounts = useAccounts(wsId);

  const [stage, setStage] = useState<Stage>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
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
    // Ф6: строки, чей расход уже создан разбором чека WB, не импортируем
    // никогда (иначе задвоение) — фильтр жёсткий, не зависит от skipDuplicates.
    const rows = preview.rows.filter((r) => !r.receiptMatch).map(rowToCommitRow);
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
  }

  if (!wsId) return null;

  return (
    <>
      <PageHeader
        title="Импорт"
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
                      {a.name} ({ACCOUNT_TYPE_LABEL[a.type]})
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
                {previewMut.isPending ? 'Обработка…' : 'Предпросмотр'}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          </Card>
        )}

        {stage === 'preview' && preview && (
          <PreviewStage
            preview={preview}
            skipDuplicates={skipDuplicates}
            onToggleSkipDuplicates={setSkipDuplicates}
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
                <h2 className="text-base font-semibold tracking-tight">
                  Выписка во «Входящих»
                </h2>
                <div className="space-y-1 text-sm">
                  <div>
                    Строк на обработку:{' '}
                    <span className="font-semibold">{batchResult.imported}</span>
                  </div>
                  <div>
                    Пропущено (дубликаты):{' '}
                    <span className="font-semibold">{batchResult.skipped}</span>
                  </div>
                  <div className="text-muted-foreground">
                    Категории, переводы и привязку к заказам проставьте во «Входящих» —
                    там же, где строки из банка.
                  </div>
                  <div className="text-xs text-muted-foreground">
                    № импорта: <code>{batchResult.batchId}</code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <Link href="/inbox">Перейти во «Входящие»</Link>
                  </Button>
                  <Button variant="secondary" onClick={reset}>
                    Импортировать ещё
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
  preview,
  skipDuplicates,
  onToggleSkipDuplicates,
  onBack,
  onCommit,
  isCommitting,
  commitError,
}: {
  preview: PreviewResult;
  skipDuplicates: boolean;
  onToggleSkipDuplicates: (v: boolean) => void;
  onBack: () => void;
  onCommit: () => void;
  isCommitting: boolean;
  commitError: string | null;
}) {
  const visibleRows = preview.rows.slice(0, 50);
  // Ф6: строки «уже учтено чеком WB» не импортируются никогда.
  const importable = preview.rows.filter((r) => !r.receiptMatch);
  const willImport = skipDuplicates
    ? importable.filter((r) => !r.isDuplicate).length
    : importable.length;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Stat label="Источник" value={IMPORT_SOURCE_LABEL[preview.source]} />
          <Stat label="Кодировка" value={preview.encoding} />
          <Stat label="Всего строк" value={String(preview.stats.total)} />
          <Stat label="Распознано" value={String(preview.stats.valid)} />
          <Stat label="Не распознано" value={String(preview.stats.invalid)} />
          <Stat label="Дубликаты" value={String(preview.stats.duplicates)} />
        </div>
      </Card>

      <Card className="overflow-x-auto !p-0">
        <table className="w-full text-base">
          <thead className="border-b border-border bg-background">
            <tr className="text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Дата</th>
              <th className="px-3 py-2 text-right font-medium">Сумма</th>
              <th className="px-3 py-2 font-medium">Тип</th>
              <th className="px-3 py-2 font-medium">Контрагент</th>
              <th className="px-3 py-2 font-medium">Описание</th>
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
                <td className="px-3 py-2 text-muted-foreground">
                  {r.type === 'INCOME' ? 'Доход' : 'Расход'}
                </td>
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
                <td className="px-3 py-2">
                  {r.isDuplicate && <Badge variant="muted">дубликат</Badge>}
                  {/* Ф6: расход уже создан проведением чека WB — строка не импортируется. */}
                  {r.receiptMatch && <Badge variant="muted">проведено по чеку WB</Badge>}
                  {r.errors.length > 0 && <Badge variant="destructive">ошибка</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.rows.length > 50 && (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Показаны первые 50 из {preview.rows.length}
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
            Пропустить дубликаты ({preview.stats.duplicates})
          </span>
        </label>
        <div className="text-sm">
          К импорту: <span className="font-semibold">{willImport}</span>{' '}
          {plural(willImport, 'операция', 'операции', 'операций')}
        </div>
        {commitError && <p className="text-sm text-destructive">{commitError}</p>}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onBack} disabled={isCommitting}>
            Назад
          </Button>
          <Button onClick={onCommit} disabled={isCommitting || willImport === 0}>
            {isCommitting ? 'Импорт…' : `Импортировать ${willImport}`}
          </Button>
        </div>
      </Card>
    </div>
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
