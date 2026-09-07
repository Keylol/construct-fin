'use client';

import { DateRangeFields, PeriodSelect } from '@/components/ui/PeriodSelect';
import type { ReportPeriod } from '@/lib/report-filters';

/**
 * Период отчёта в полосе фильтров: тот же `PeriodSelect` + поля «С»/«По», что
 * в операциях. У отчёта всегда есть границы, поэтому пункт «Всё время» здесь
 * читается как «Свой диапазон»: выбор его не сбрасывает даты — человек правит
 * их от текущего периода, а отчёт остаётся ограниченным.
 */
const LABELS = { all: 'Свой диапазон' } as const;

export function ReportPeriodFields({
  value,
  onChange,
}: {
  value: ReportPeriod;
  onChange: (next: ReportPeriod) => void;
}) {
  return (
    <>
      <PeriodSelect
        value={value.period}
        labels={LABELS}
        onChange={(period, range) =>
          onChange(period === 'all' ? { period, range: value.range } : { period, range })
        }
      />
      <DateRangeFields range={value.range} onChange={(range) => onChange({ period: 'all', range })} />
    </>
  );
}
