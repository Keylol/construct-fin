import { Card } from '@/components/ui/Card';

export default function TransactionsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Операции</h1>
      <Card>
        <div className="text-fg font-medium mb-2">Раздел в разработке</div>
        <p className="text-muted text-sm">
          В фазе 2 здесь появится список транзакций, фильтры по дате/счёту/категории/контрагенту,
          быстрый ввод через FAB и поиск по описанию. Импорт CSV/Excel — в фазе 3.
        </p>
      </Card>
    </div>
  );
}
