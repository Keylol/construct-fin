'use client';

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { FilterField } from '@/components/ui/FilterField';
import {
  ANY_PERIOD_LABELS,
  ANY_PERIOD_ORDER,
  type AnyPeriod,
  type DateRange,
  fromLocalDateInput,
  rangeForAny,
  toLocalDateInput,
} from '@/lib/periods';

/**
 * Выбор периода «как в операциях» — один контрол на все списки и отчёты.
 * Пресеты — общий словарь `AnyPeriod` (зеркало пресетов бэкенда, см.
 * `rangeForPreset`), поэтому клик из отчёта в список показывает те же
 * границы, что и сам отчёт. Свой диапазон задаётся полями «С» / «По»
 * (`DateRangeFields`) — при их правке пресет становится «Всё время», а
 * границы — явными.
 */
export function PeriodSelect({
  value,
  onChange,
  className,
  label = 'Период',
}: {
  value: AnyPeriod;
  onChange: (period: AnyPeriod, range: DateRange) => void;
  className?: string;
  label?: string;
}) {
  return (
    <FilterField label={label}>
      <Select
        value={value}
        onChange={(e) => {
          const key = e.target.value as AnyPeriod;
          onChange(key, rangeForAny(key));
        }}
        className={className ?? 'h-9 w-[150px]'}
      >
        {ANY_PERIOD_ORDER.map((k) => (
          <option key={k} value={k}>
            {ANY_PERIOD_LABELS[k]}
          </option>
        ))}
      </Select>
    </FilterField>
  );
}

/**
 * Поля «С» / «По» для произвольного диапазона. Держат локальный текст полей и
 * синхронизируются при ВНЕШНЕЙ смене диапазона (заезд из URL, сброс) — ввод
 * в сами поля round-trip'ит через `range`, цикла нет.
 */
export function DateRangeFields({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const [from, setFrom] = useState(range.from ? toLocalDateInput(range.from) : '');
  const [to, setTo] = useState(range.to ? toLocalDateInput(range.to) : '');

  useEffect(() => {
    setFrom(range.from ? toLocalDateInput(range.from) : '');
    setTo(range.to ? toLocalDateInput(range.to) : '');
  }, [range.from, range.to]);

  const apply = (f: string, t: string) =>
    onChange({
      from: f ? fromLocalDateInput(f) : undefined,
      to: t ? fromLocalDateInput(t) : undefined,
    });

  return (
    <>
      <FilterField label="С">
        <Input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            apply(e.target.value, to);
          }}
          className="h-9 w-[150px]"
        />
      </FilterField>
      <FilterField label="По">
        <Input
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            apply(from, e.target.value);
          }}
          className="h-9 w-[150px]"
        />
      </FilterField>
    </>
  );
}
