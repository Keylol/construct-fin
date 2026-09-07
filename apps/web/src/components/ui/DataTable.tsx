'use client';

import { Fragment, type ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from '@/components/ui/icons';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadMore } from '@/components/ui/LoadMore';
import { cn } from '@/lib/cn';

export interface Column<T> {
  /** Stable key (used for sort state and React keys). */
  key: string;
  /** Header label or custom node. */
  header: ReactNode;
  /** Cell renderer. Receives the row. */
  cell: (row: T) => ReactNode;
  /** When set, header renders as a sortable trigger. */
  sortable?: boolean;
  /** Right-aligned cells (numbers, money). */
  align?: 'left' | 'right';
  /** Optional Tailwind classes applied to <th> AND <td>. */
  className?: string;
  /** Header-only classes (e.g. column width hints). */
  headClassName?: string;
  /**
   * Действия строки (решение №29 блица): на десктопе проявляются по hover
   * строки / фокусу, таблица чище. На <sm рендерятся mobileCards — там всё видно.
   */
  hoverOnly?: boolean;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  /** Stable key per row — usually `(r) => r.id`. */
  rowKey: (row: T) => string;
  /** Click handler — typically opens the edit drawer. */
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  loading?: boolean;
  /**
   * Ошибка загрузки. Когда задана — вместо пустой таблицы рисуется блок
   * «Не удалось загрузить» с кнопкой «Повторить» (ошибка ≠ «данных нет»).
   */
  error?: unknown;
  /** Обработчик «Повторить» — обычно `() => query.refetch()`. */
  onRetry?: () => void;
  empty?: ReactNode;
  /** Render rows as cards instead of a table on mobile. Default true. */
  mobileCards?: (row: T) => ReactNode;
  className?: string;
  /**
   * Группировка строк (решение №27 блица): ключ группы по строке — при смене
   * ключа вставляется строка-заголовок («Сегодня», «Вчера», дата).
   */
  groupBy?: (row: T) => string;
  /** Рендер заголовка группы (получает ключ и строки группы). */
  renderGroupHeader?: (key: string, rows: T[]) => ReactNode;
  /**
   * Итоговая строка (решение №28): ячейки по ключам колонок — Σ по видимым
   * данным без калькулятора. Рендерится в <tfoot>.
   */
  footer?: Partial<Record<string, ReactNode>>;
  /** Курсорная пагинация: есть ли ещё страницы — под таблицей появится «Загрузить ещё». */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  onRowClick,
  sort,
  onSortChange,
  loading,
  error,
  onRetry,
  empty,
  mobileCards,
  className,
  groupBy,
  renderGroupHeader,
  footer,
  hasMore,
  onLoadMore,
  loadingMore,
}: DataTableProps<T>) {
  const toggleSort = (key: string) => {
    if (!onSortChange) return;
    if (sort?.key === key) {
      onSortChange({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      onSortChange({ key, dir: 'desc' });
    }
  };

  if (loading) {
    return (
      <div className="px-6 py-3">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    );
  }

  if (error != null) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (!data.length && empty) {
    return <div className="py-6">{empty}</div>;
  }

  // Группировка: соседние строки с одним ключом собираются в блоки.
  const groups: { key: string | null; rows: T[] }[] = [];
  if (groupBy) {
    for (const row of data) {
      const k = groupBy(row);
      const last = groups[groups.length - 1];
      if (last && last.key === k) last.rows.push(row);
      else groups.push({ key: k, rows: [row] });
    }
  } else {
    groups.push({ key: null, rows: data });
  }

  const renderRow = (row: T) => (
    <tr
      key={rowKey(row)}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      className={cn(
        'group/row border-b border-border last:border-0 transition-colors',
        onRowClick && 'cursor-pointer hover:bg-secondary',
      )}
    >
      {columns.map((c) => (
        <td
          key={c.key}
          className={cn(
            'px-4 py-3 align-middle text-foreground',
            c.align === 'right' && 'text-right tabular-nums',
            // Действия по hover (№29): фокус тоже раскрывает — клавиатура не страдает.
            c.hoverOnly &&
              'opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100',
            c.className,
          )}
        >
          {c.cell(row)}
        </td>
      ))}
    </tr>
  );

  return (
    <>
      {/* Desktop / tablet. Кегль таблиц 15px (решение №10) — данные читаются легче. */}
      <div className={cn('hidden overflow-auto sm:block', className)}>
        <table className="w-full border-collapse text-base">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border">
              {columns.map((c) => {
                const isSorted = sort?.key === c.key;
                const align = c.align === 'right' ? 'text-right' : 'text-left';
                return (
                  <th
                    key={c.key}
                    className={cn(
                      'px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground',
                      align,
                      c.headClassName,
                      c.className,
                    )}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={cn(
                          'inline-flex items-center gap-1 text-inherit transition-colors',
                          'hover:text-foreground',
                          c.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        <span>{c.header}</span>
                        {isSorted ? (
                          sort?.dir === 'asc' ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) =>
              g.key === null ? (
                g.rows.map(renderRow)
              ) : (
                <Fragment key={`group-${g.key}`}>
                  <tr className="border-b border-border bg-sunken">
                    <td
                      colSpan={columns.length}
                      className="px-4 py-1.5 text-xs font-medium text-muted-foreground"
                    >
                      {renderGroupHeader ? renderGroupHeader(g.key, g.rows) : g.key}
                    </td>
                  </tr>
                  {g.rows.map(renderRow)}
                </Fragment>
              ),
            )}
          </tbody>
          {footer && (
            <tfoot>
              <tr className="border-t-2 border-border bg-sunken">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-4 py-2.5 text-sm font-semibold',
                      c.align === 'right' && 'text-right tabular-nums',
                      c.className,
                    )}
                  >
                    {footer[c.key] ?? null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile cards */}
      {mobileCards && (
        <div className="block divide-y divide-border sm:hidden">
          {data.map((row) => (
            <div
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'px-4 py-3',
                onRowClick && 'cursor-pointer hover:bg-secondary active:bg-secondary',
              )}
            >
              {mobileCards(row)}
            </div>
          ))}
        </div>
      )}

      {onLoadMore && <LoadMore hasMore={!!hasMore} loading={loadingMore} onClick={onLoadMore} />}
    </>
  );
}
