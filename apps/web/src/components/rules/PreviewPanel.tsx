'use client';

import type { RulePreview } from '@/lib/types';
import { formatRub } from '@construct/shared';
import { formatDate } from '@/lib/dates';

/** Охват черновика по загруженной выписке: сколько зацепит и что именно. */
export function PreviewPanel({ preview }: { preview: RulePreview }) {
  if (preview.total === 0) {
    return (
      <p className="rounded-md bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        Выписка ещё не загружена — проверить правило не на чем.
      </p>
    );
  }
  return (
    <div className="rounded-md bg-secondary/40 px-3 py-2 text-xs">
      {preview.matched === 0 ? (
        <span className="text-muted-foreground">
          Ни одна из {preview.total} загруженных строк не подходит под эти условия.
        </span>
      ) : (
        <>
          <span className="text-foreground">
            Подходит <span className="font-semibold tabular-nums">{preview.matched}</span> из{' '}
            {preview.total} строк
            {preview.matchedPending > 0 && (
              <>
                , из них в обработке{' '}
                <span className="font-semibold tabular-nums">{preview.matchedPending}</span>
              </>
            )}
            {preview.truncated && ' (проверены только последние строки)'}
          </span>
          <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
            {preview.samples.map((s) => (
              <li key={s.id} className="truncate">
                {formatDate(s.date)} · {s.direction === 'INCOME' ? '+' : '−'}
                {formatRub(s.amount, 2)} ·{' '}
                {s.description?.trim() || s.counterpartyName || 'без назначения'}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
