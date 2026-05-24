'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useImportBatches, useRollbackImport } from '@/hooks/useImport';
import type { ImportBatch } from '@/lib/types';

const SOURCE_LABEL: Record<ImportBatch['source'], string> = {
  ALFA_XLSX: 'Альфа xlsx',
  WB_PDF: 'WB pdf',
  TINKOFF_PDF: 'Т-Банк pdf',
  GENERIC_CSV: 'CSV',
  GENERIC_XLSX: 'Excel',
};

export default function ImportBatchesPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const batches = useImportBatches(wsId);
  const rollback = useRollbackImport(wsId ?? '');

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">История импортов</h1>
        <Link href="/import">
          <Button variant="secondary">Новый импорт</Button>
        </Link>
      </header>

      {batches.isLoading && <p className="text-muted text-sm">Загрузка…</p>}

      {batches.data && batches.data.length === 0 && (
        <EmptyState
          title="Пока ничего не импортировано"
          hint="Загрузите выписку, чтобы быстро добавить транзакции"
          action={
            <Link href="/import">
              <Button>Импортировать</Button>
            </Link>
          }
        />
      )}

      {batches.data && batches.data.length > 0 && (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-white/10">
                <th className="py-2 px-3">Дата</th>
                <th className="py-2 px-3">Источник</th>
                <th className="py-2 px-3">Файл</th>
                <th className="py-2 px-3 text-right">Импорт.</th>
                <th className="py-2 px-3 text-right">Пропущ.</th>
                <th className="py-2 px-3">Кто</th>
                <th className="py-2 px-3">Статус</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {batches.data.map((b) => {
                const isRolledBack = !!b.deletedAt;
                const userName =
                  b.user?.firstName ?? b.user?.username ?? 'Пользователь';
                return (
                  <tr key={b.id} className="border-b border-white/5">
                    <td className="py-2 px-3 whitespace-nowrap text-muted">
                      {new Date(b.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td className="py-2 px-3">{SOURCE_LABEL[b.source]}</td>
                    <td className="py-2 px-3 max-w-[240px] truncate" title={b.filename}>
                      {b.filename}
                    </td>
                    <td className="py-2 px-3 text-right">{b.rowsImported}</td>
                    <td className="py-2 px-3 text-right text-muted">
                      {b.rowsSkipped}
                    </td>
                    <td className="py-2 px-3">{userName}</td>
                    <td className="py-2 px-3">
                      {isRolledBack ? (
                        <span className="text-xs text-muted">откатан</span>
                      ) : (
                        <span className="text-xs text-success">активен</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {!isRolledBack && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            if (
                              confirm(
                                `Откатить импорт «${b.filename}»? ${b.rowsImported} транзакций будут удалены.`,
                              )
                            ) {
                              rollback.mutate(b.id);
                            }
                          }}
                          disabled={rollback.isPending}
                        >
                          Откатить
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {rollback.error && (
        <p className="text-sm text-danger">{(rollback.error as Error).message}</p>
      )}
    </div>
  );
}
