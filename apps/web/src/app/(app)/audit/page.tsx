'use client';

import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAuditLog, type AuditEntry } from '@/hooks/useAudit';

const ACTION_LABEL: Record<string, string> = {
  'order.finalize': 'Закрытие заказа',
  'order.cancel': 'Отмена заказа',
  'order.reopen': 'Возврат заказа в работу',
  'order.delete': 'Удаление заказа',
  'order.refund': 'Возврат клиенту',
  'period.close': 'Закрытие месяца',
  'period.reopen': 'Открытие месяца',
  'purchase.register': 'Закупка',
  'warehouse.supplier-return': 'Возврат поставщику',
  'transaction.delete': 'Удаление операции',
};

const DT_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function describeDiff(entry: AuditEntry): string {
  const d = entry.diff as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return '';
  const parts: string[] = [];
  if (typeof d.number === 'string') parts.push(d.number);
  if (typeof d.totalAmount === 'string') parts.push(`сумма ${d.totalAmount} ₽`);
  if (typeof d.amount === 'string') parts.push(`${d.amount} ₽`);
  if (typeof d.year === 'number' && typeof d.month === 'number') {
    parts.push(`${String(d.month).padStart(2, '0')}.${d.year}`);
  }
  if (typeof d.linesCount === 'number') parts.push(`${d.linesCount} позиций`);
  if (typeof d.previousStatus === 'string') parts.push(`было ${d.previousStatus}`);
  return parts.join(' · ');
}

export default function AuditPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId ?? '';
  const log = useAuditLog(wsId || null);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Журнал действий"
        description="История критичных операций: закрытие месяцев, заказы, закупки, удаления."
      />
      <div className="px-6 py-6">
        {log.isLoading ? (
          <div className="text-sm text-muted-foreground">Загрузка…</div>
        ) : !log.data || log.data.items.length === 0 ? (
          <EmptyState icon={ScrollText} title="Пока ничего не записано" />
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Когда</th>
                  <th className="px-3 py-2 text-left font-medium">Действие</th>
                  <th className="px-3 py-2 text-left font-medium">Объект</th>
                  <th className="px-3 py-2 text-left font-medium">Детали</th>
                </tr>
              </thead>
              <tbody>
                {log.data.items.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {DT_FMT.format(new Date(row.createdAt))}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge variant="outline">
                        {ACTION_LABEL[row.action] ?? row.action}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {row.entityType}
                    </td>
                    <td className="px-3 py-2 align-top">{describeDiff(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
