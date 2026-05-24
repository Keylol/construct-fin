'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatRub } from '@construct/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { useAccounts } from '@/hooks/useAccounts';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  rowToCommitRow,
  useImportCommit,
  useImportPreview,
} from '@/hooks/useImport';
import type { PreviewResult } from '@/lib/types';

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
  const [batchResult, setBatchResult] = useState<{ batchId: string; imported: number; skipped: number } | null>(null);

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
    const rows = preview.rows.map((r) => rowToCommitRow(r, null));
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

  if (!wsId) {
    return <EmptyState title="Workspace не выбран" />;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Импорт выписки</h1>
        <Link href="/import/batches" className="text-sm text-tint hover:underline">
          История импортов →
        </Link>
      </header>

      <Steps stage={stage} />

      {stage === 'upload' && (
        <Card className="p-6">
          <form onSubmit={onUploadSubmit} className="space-y-4">
            <div>
              <label className="block text-sm mb-2">Счёт списания/зачисления</label>
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
            </div>

            <div>
              <label className="block text-sm mb-2">Файл выписки (CSV / Excel / PDF, до 10 МБ)</label>
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.pdf,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
                className="block w-full text-sm file:mr-4 file:px-4 file:py-2 file:rounded-xl file:border-0 file:bg-tint file:text-white hover:file:opacity-90"
              />
              {file && (
                <p className="mt-2 text-xs text-muted">
                  {file.name} · {(file.size / 1024).toFixed(1)} КБ
                </p>
              )}
            </div>

            {previewMut.error && (
              <p className="text-sm text-danger">{(previewMut.error as Error).message}</p>
            )}

            <Button
              type="submit"
              disabled={!file || !accountId || previewMut.isPending}
            >
              {previewMut.isPending ? 'Парсим…' : 'Загрузить и предпросмотр'}
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
        <Card className="p-6 space-y-4">
          <h2 className="text-xl font-semibold">Готово</h2>
          <div className="text-sm space-y-1">
            <div>Импортировано: <b>{batchResult.imported}</b></div>
            <div>Пропущено (дубли): <b>{batchResult.skipped}</b></div>
            <div className="text-muted">Batch ID: <code className="text-xs">{batchResult.batchId}</code></div>
          </div>
          <div className="flex gap-3">
            <Button onClick={reset}>Импортировать ещё</Button>
            <Link href="/transactions">
              <Button variant="secondary">К операциям</Button>
            </Link>
            <Link href="/import/batches">
              <Button variant="ghost">История</Button>
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

function Steps({ stage }: { stage: Stage }) {
  const items: Array<{ key: Stage; label: string }> = [
    { key: 'upload', label: '1. Загрузка' },
    { key: 'preview', label: '2. Предпросмотр' },
    { key: 'done', label: '3. Готово' },
  ];
  const order = items.findIndex((i) => i.key === stage);
  return (
    <div className="flex gap-2">
      {items.map((it, i) => (
        <div
          key={it.key}
          className={`px-3 py-1.5 rounded-xl text-sm border ${
            i === order
              ? 'bg-tint text-white border-tint'
              : i < order
                ? 'bg-glass text-fg border-white/10'
                : 'text-muted border-white/5'
          }`}
        >
          {it.label}
        </div>
      ))}
    </div>
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
  const willImport = skipDuplicates
    ? preview.rows.filter((r) => !r.isDuplicate).length
    : preview.rows.length;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <Stat label="Источник" value={SOURCE_LABEL[preview.source]} />
          <Stat label="Кодировка" value={preview.encoding} />
          <Stat label="Всего строк" value={String(preview.stats.total)} />
          <Stat label="Валидных" value={String(preview.stats.valid)} />
          <Stat label="Не распознано" value={String(preview.stats.invalid)} />
          <Stat label="Дубли" value={String(preview.stats.duplicates)} />
        </div>
      </Card>

      <Card className="p-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-white/10">
              <th className="py-2 px-2">#</th>
              <th className="py-2 px-2">Дата</th>
              <th className="py-2 px-2">Сумма</th>
              <th className="py-2 px-2">Тип</th>
              <th className="py-2 px-2">Контрагент</th>
              <th className="py-2 px-2">Описание</th>
              <th className="py-2 px-2">Флаг</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.rawIndex} className="border-b border-white/5">
                <td className="py-1.5 px-2 text-muted">{r.rawIndex}</td>
                <td className="py-1.5 px-2 whitespace-nowrap">{r.date.slice(0, 10)}</td>
                <td className={`py-1.5 px-2 whitespace-nowrap ${r.type === 'INCOME' ? 'text-success' : 'text-danger'}`}>
                  {r.type === 'INCOME' ? '+' : '−'} {formatRub(r.amount)}
                </td>
                <td className="py-1.5 px-2">{r.type}</td>
                <td className="py-1.5 px-2 max-w-[200px] truncate" title={r.counterpartyName ?? ''}>
                  {r.counterpartyName ?? '—'}
                  {r.resolvedCounterpartyId && <span className="ml-1 text-xs text-success">●</span>}
                </td>
                <td className="py-1.5 px-2 max-w-[300px] truncate" title={r.description ?? ''}>
                  {r.description ?? '—'}
                </td>
                <td className="py-1.5 px-2">
                  {r.isDuplicate && <span className="text-xs text-warning">дубль</span>}
                  {r.errors.length > 0 && <span className="text-xs text-danger">ошибка</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.rows.length > 50 && (
          <p className="text-xs text-muted mt-2">
            Показано первые 50 из {preview.rows.length}
          </p>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={skipDuplicates}
            onChange={(e) => onToggleSkipDuplicates(e.target.checked)}
          />
          <span className="text-sm">
            Пропустить дубли ({preview.stats.duplicates})
          </span>
        </label>
        <div className="text-sm">
          К импорту: <b>{willImport}</b> транзакций
        </div>
        {commitError && <p className="text-sm text-danger">{commitError}</p>}
        <div className="flex gap-3">
          <Button onClick={onCommit} disabled={isCommitting || willImport === 0}>
            {isCommitting ? 'Импортируем…' : `Импортировать ${willImport}`}
          </Button>
          <Button variant="secondary" onClick={onBack} disabled={isCommitting}>
            Назад
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
