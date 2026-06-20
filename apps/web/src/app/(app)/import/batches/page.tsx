'use client';

import Link from 'next/link';
import { Upload, History } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useImportBatches } from '@/hooks/useImport';
import type { ImportBatch } from '@/lib/types';

const SOURCE_LABEL: Record<ImportBatch['source'], string> = {
  ALFA_XLSX: 'Альфа xlsx',
  WB_PDF: 'WB pdf',
  TINKOFF_PDF: 'Т-Банк pdf',
  GENERIC_CSV: 'CSV',
  GENERIC_XLSX: 'Excel',
};

const DT_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export default function ImportBatchesPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const batches = useImportBatches(wsId);

  if (!wsId) {
    return (
      <>
        <PageHeader title="История импортов" />
        <div className="p-6">
          <EmptyState
            icon={History}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  const columns: Column<ImportBatch>[] = [
    {
      key: 'createdAt',
      header: 'Дата',
      sortable: true,
      cell: (b) => (
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          {DT_FMT.format(new Date(b.createdAt))}
        </span>
      ),
      className: 'w-[160px]',
    },
    {
      key: 'source',
      header: 'Источник',
      cell: (b) => SOURCE_LABEL[b.source],
      className: 'w-[120px]',
    },
    {
      key: 'filename',
      header: 'Файл',
      cell: (b) => (
        <span className="block max-w-[300px] truncate" title={b.filename}>
          {b.filename}
        </span>
      ),
    },
    {
      key: 'imported',
      header: 'Импорт.',
      align: 'right',
      cell: (b) => b.rowsImported,
      className: 'w-[90px]',
    },
    {
      key: 'skipped',
      header: 'Пропущ.',
      align: 'right',
      cell: (b) => <span className="text-muted-foreground">{b.rowsSkipped}</span>,
      className: 'w-[90px]',
    },
    {
      key: 'user',
      header: 'Кто',
      cell: (b) => b.user?.firstName ?? b.user?.username ?? 'Пользователь',
      className: 'w-[140px]',
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (b) =>
        b.deletedAt ? (
          <Badge variant="muted">Откатан</Badge>
        ) : (
          <Badge variant="outline">Активен</Badge>
        ),
      className: 'w-[110px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="История импортов"
        breadcrumbs={[
          { label: 'Учёт' },
          { label: 'Импорт', href: '/import' },
          { label: 'История' },
        ]}
        actions={
          <Button asChild>
            <Link href="/import">
              <Upload className="h-4 w-4" /> Новый импорт
            </Link>
          </Button>
        }
      />

      <div className="bg-card border-t border-border">
        <DataTable
          data={batches.data ?? []}
          columns={columns}
          rowKey={(b) => b.id}
          loading={batches.isLoading}
          empty={
            <EmptyState
              icon={History}
              title="Пока ничего не импортировано"
              hint="Загрузите выписку из банка, чтобы быстро добавить много операций."
              action={
                <Button asChild>
                  <Link href="/import">Импортировать</Link>
                </Button>
              }
            />
          }
          mobileCards={(b) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{b.filename}</span>
                {b.deletedAt ? (
                  <Badge variant="muted">Откатан</Badge>
                ) : (
                  <Badge variant="outline">Активен</Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {DT_FMT.format(new Date(b.createdAt))} · {SOURCE_LABEL[b.source]} ·
                {' '}
                {b.rowsImported} операций
              </div>
            </div>
          )}
        />
      </div>
    </>
  );
}
