'use client';

/**
 * Ошибка загрузки — отдельное состояние, не «данных нет». Пустой экран вместо
 * упавшего запроса читается как «всё разобрано» или «денег ноль»: в учёте это
 * опаснее самой ошибки, поэтому у каждого списка и отчёта должна быть эта
 * ветка. Живёт рядом с EmptyState и выглядит так же спокойно.
 */
export function ErrorState({
  error,
  onRetry,
  title = 'Не удалось загрузить данные',
}: {
  error?: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {error instanceof Error && error.message ? error.message : 'Ошибка соединения с сервером'}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-sm border border-input px-3 py-1.5 text-sm transition-colors hover:bg-secondary"
        >
          Повторить
        </button>
      )}
    </div>
  );
}
