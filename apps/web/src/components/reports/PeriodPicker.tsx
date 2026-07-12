'use client';

import type { PeriodPreset } from '@/lib/types';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';

export type PeriodValue =
  | { mode: 'preset'; preset: PeriodPreset }
  | { mode: 'custom'; from: string; to: string };

const PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'this-month', label: 'Этот месяц' },
  { value: 'prev-month', label: 'Прошлый месяц' },
  { value: 'this-quarter', label: 'Этот квартал' },
  { value: 'prev-quarter', label: 'Прошлый квартал' },
  { value: 'this-year', label: 'Этот год' },
  { value: 'ytd', label: 'С начала года' },
  { value: 'prev-year', label: 'Прошлый год' },
  { value: 'last-30d', label: '30 дней' },
  { value: 'last-90d', label: '90 дней' },
  { value: 'last-12m', label: '12 месяцев' },
];

interface PeriodPickerProps {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
}

export function PeriodPicker({ value, onChange }: PeriodPickerProps) {
  const presetValue =
    value.mode === 'preset' ? value.preset : ('custom' as const);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col text-xs text-muted-foreground">
        <span className="pb-1">Период</span>
        <Select
          value={presetValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') {
              onChange({
                mode: 'custom',
                from: value.mode === 'custom' ? value.from : '',
                to: value.mode === 'custom' ? value.to : '',
              });
            } else {
              onChange({ mode: 'preset', preset: v as PeriodPreset });
            }
          }}
          className="h-9 w-[180px]"
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="custom">Свой диапазон…</option>
        </Select>
      </label>
      {/* Поля дат показываем только для «Свой диапазон…» — при пресете они пустые и лишь шумят. */}
      {value.mode === 'custom' && (
        <>
          <label className="flex flex-col text-xs text-muted-foreground">
            <span className="pb-1">С</span>
            <Input
              type="date"
              value={value.from}
              onChange={(e) =>
                onChange({ mode: 'custom', from: e.target.value, to: value.to })
              }
              className="h-9 w-[150px]"
            />
          </label>
          <label className="flex flex-col text-xs text-muted-foreground">
            <span className="pb-1">По</span>
            <Input
              type="date"
              value={value.to}
              onChange={(e) =>
                onChange({ mode: 'custom', from: value.from, to: e.target.value })
              }
              className="h-9 w-[150px]"
            />
          </label>
        </>
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
