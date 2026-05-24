'use client';

import { useState } from 'react';
import type { PeriodPreset } from '@/lib/types';

export type PeriodValue =
  | { mode: 'preset'; preset: PeriodPreset }
  | { mode: 'custom'; from: string; to: string };

const PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'this-month', label: 'Этот месяц' },
  { value: 'prev-month', label: 'Прошлый месяц' },
  { value: 'this-quarter', label: 'Этот квартал' },
  { value: 'ytd', label: 'С начала года' },
  { value: 'prev-year', label: 'Прошлый год' },
  { value: 'last-30d', label: '30 дней' },
  { value: 'last-90d', label: '90 дней' },
  { value: 'last-12m', label: '12 месяцев' },
];

export function PeriodPicker({
  value,
  onChange,
}: {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
}) {
  const [showCustom, setShowCustom] = useState(value.mode === 'custom');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => {
            setShowCustom(false);
            onChange({ mode: 'preset', preset: p.value });
          }}
          className={`rounded-full px-3 py-1 text-sm transition ${
            value.mode === 'preset' && value.preset === p.value
              ? 'bg-blue-600 text-white'
              : 'bg-glass/40 hover:bg-glass/60 text-fg'
          }`}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setShowCustom((v) => !v)}
        className={`rounded-full px-3 py-1 text-sm transition ${
          value.mode === 'custom'
            ? 'bg-blue-600 text-white'
            : 'bg-glass/40 hover:bg-glass/60 text-fg'
        }`}
      >
        Свой диапазон
      </button>
      {showCustom && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={value.mode === 'custom' ? value.from : ''}
            onChange={(e) =>
              onChange({
                mode: 'custom',
                from: e.target.value,
                to: value.mode === 'custom' ? value.to : e.target.value,
              })
            }
            className="rounded border border-glass-border bg-glass/30 px-2 py-1 text-sm"
          />
          <span className="text-muted text-sm">—</span>
          <input
            type="date"
            value={value.mode === 'custom' ? value.to : ''}
            onChange={(e) =>
              onChange({
                mode: 'custom',
                from: value.mode === 'custom' ? value.from : e.target.value,
                to: e.target.value,
              })
            }
            className="rounded border border-glass-border bg-glass/30 px-2 py-1 text-sm"
          />
        </div>
      )}
    </div>
  );
}

export function periodToQuery(p: PeriodValue): {
  preset?: PeriodPreset;
  from?: string;
  to?: string;
} {
  if (p.mode === 'preset') return { preset: p.preset };
  return { from: p.from, to: p.to };
}
