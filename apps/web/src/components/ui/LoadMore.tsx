import { Button } from '@/components/ui/Button';

/**
 * «Загрузить ещё» под списком с курсорной пагинацией. Один текст и одно место
 * на все экраны — раньше было четыре вёрстки и «Показать ещё» во «Входящих».
 * Ничего не рисует, когда добирать нечего.
 */
export function LoadMore({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center border-t border-border py-4">
      <Button variant="secondary" onClick={onClick} disabled={loading}>
        {loading ? 'Загрузка…' : 'Загрузить ещё'}
      </Button>
    </div>
  );
}
