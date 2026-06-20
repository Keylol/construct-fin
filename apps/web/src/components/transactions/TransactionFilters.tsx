'use client';

import { useState } from 'react';
import { Search, RotateCcw } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { FilterBar } from '@/components/ui/FilterBar';
import type { TxType, Account, Category, Counterparty } from '@/lib/types';
import {
  type DateRange,
  type PeriodKey,
  PERIOD_LABELS,
  rangeFor,
  toLocalDateInput,
  fromLocalDateInput,
} from '@/lib/periods';

export interface ActiveFilters {
  period: PeriodKey;
  range: DateRange;
  accountId?: string;
  categoryId?: string;
  counterpartyId?: string;
  type?: TxType;
  search?: string;
}

interface Props {
  active: ActiveFilters;
  onChange: (next: ActiveFilters) => void;
  accounts: Account[];
  categories: Category[];
  counterparties: Counterparty[];
}

export function TransactionFilters({
  active,
  onChange,
  accounts,
  categories,
  counterparties,
}: Props) {
  const [customFrom, setCustomFrom] = useState<string>(
    active.range.from ? toLocalDateInput(active.range.from) : '',
  );
  const [customTo, setCustomTo] = useState<string>(
    active.range.to ? toLocalDateInput(active.range.to) : '',
  );

  const setPeriod = (key: PeriodKey) => {
    const range = rangeFor(key);
    onChange({ ...active, period: key, range });
    setCustomFrom(range.from ? toLocalDateInput(range.from) : '');
    setCustomTo(range.to ? toLocalDateInput(range.to) : '');
  };

  const applyCustomDates = (from?: string, to?: string) => {
    onChange({
      ...active,
      period: 'all',
      range: {
        from: from ? fromLocalDateInput(from) : undefined,
        to: to ? fromLocalDateInput(to) : undefined,
      },
    });
  };

  const reset = () => {
    onChange({ period: 'month', range: rangeFor('month') });
    setCustomFrom('');
    setCustomTo('');
  };

  return (
    <FilterBar>
      <div className="min-w-[180px] max-w-xs flex-1">
        <FilterField label="Поиск">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={active.search ?? ''}
              onChange={(e) =>
                onChange({ ...active, search: e.target.value || undefined })
              }
              placeholder="Описание, контрагент…"
              className="h-9 pl-8"
            />
          </div>
        </FilterField>
      </div>

      <FilterField label="Период">
        <Select
          value={active.period}
          onChange={(e) => setPeriod(e.target.value as PeriodKey)}
          className="h-9 w-[150px]"
        >
          {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
            <option key={k} value={k}>
              {PERIOD_LABELS[k]}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="С">
        <Input
          type="date"
          value={customFrom}
          onChange={(e) => {
            setCustomFrom(e.target.value);
            applyCustomDates(e.target.value, customTo);
          }}
          className="h-9 w-[150px]"
        />
      </FilterField>
      <FilterField label="По">
        <Input
          type="date"
          value={customTo}
          onChange={(e) => {
            setCustomTo(e.target.value);
            applyCustomDates(customFrom, e.target.value);
          }}
          className="h-9 w-[150px]"
        />
      </FilterField>
      <FilterField label="Тип">
        <Select
          value={active.type ?? ''}
          onChange={(e) =>
            onChange({
              ...active,
              type: (e.target.value || undefined) as TxType | undefined,
            })
          }
          className="h-9 w-[100px]"
        >
          <option value="">Все</option>
          <option value="INCOME">Доход</option>
          <option value="EXPENSE">Расход</option>
        </Select>
      </FilterField>
      <FilterField label="Счёт">
        <Select
          value={active.accountId ?? ''}
          onChange={(e) =>
            onChange({ ...active, accountId: e.target.value || undefined })
          }
          className="h-9 w-[140px]"
        >
          <option value="">Все</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Категория">
        <Select
          value={active.categoryId ?? ''}
          onChange={(e) =>
            onChange({ ...active, categoryId: e.target.value || undefined })
          }
          className="h-9 w-[160px]"
        >
          <option value="">Все</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Контрагент">
        <Select
          value={active.counterpartyId ?? ''}
          onChange={(e) =>
            onChange({
              ...active,
              counterpartyId: e.target.value || undefined,
            })
          }
          className="h-9 w-[160px]"
        >
          <option value="">Все</option>
          {counterparties.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FilterField>

      <Button variant="ghost" size="sm" onClick={reset} className="self-end">
        <RotateCcw className="h-3.5 w-3.5" />
        Сброс
      </Button>
    </FilterBar>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col text-xs text-muted-foreground">
      <span className="pb-1">{label}</span>
      {children}
    </label>
  );
}
