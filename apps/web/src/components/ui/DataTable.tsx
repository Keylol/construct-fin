'use client';

import type { ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from '@/components/ui/icons';
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
  empty?: ReactNode;
  /** Render rows as cards instead of a table on mobile. Default true. */
  mobileCards?: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  onRowClick,
  sort,
  onSortChange,
  loading,
  empty,
  mobileCards,
  className,
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
            <div key={i} className="h-10 w-full animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (!data.length && empty) {
    return <div className="py-6">{empty}</div>;
  }

  return (
    <>
      {/* Desktop / tablet */}
      <div className={cn('hidden overflow-auto sm:block', className)}>
        <table className="w-full border-collapse text-sm">
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
            {data.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-border last:border-0 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-secondary',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-4 py-3 align-middle text-foreground',
                      c.align === 'right' && 'text-right tabular-nums',
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
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
    </>
  );
}
