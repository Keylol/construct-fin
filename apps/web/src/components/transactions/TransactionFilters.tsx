'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
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

export function TransactionFilters({
  active,
  onChange,
  accounts,
  categories,
  counterparties,
}: {
  active: ActiveFilters;
  onChange: (next: ActiveFilters) => void;
  accounts: Account[];
  categories: Category[];
  counterparties: Counterparty[];
}) {
  const [advanced, setAdvanced] = useState(false);
  const [customFrom, setCustomFrom] = useState<string>(
    active.range.from ? toLocalDateInput(active.range.from) : '',
  );
  const [customTo, setCustomTo] = useState<string>(
    active.range.to ? toLocalDateInput(active.range.to) : '',
  );

  const setPeriod = (key: PeriodKey) => {
    onChange({ ...active, period: key, range: rangeFor(key) });
  };

  const applyCustom = () => {
    onChange({
      ...active,
      period: 'all',
      range: {
        from: customFrom ? fromLocalDateInput(customFrom) : undefined,
        to: customTo ? fromLocalDateInput(customTo) : undefined,
      },
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
        {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setPeriod(k)}
            className={`px-3 h-8 text-sm rounded-xl whitespace-nowrap transition ${
              active.period === k
                ? 'bg-tint text-white'
                : 'bg-surface border border-white/10 text-fg/70 hover:bg-glass/50'
            }`}
          >
            {PERIOD_LABELS[k]}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          type="search"
          value={active.search ?? ''}
          onChange={(e) => onChange({ ...active, search: e.target.value || undefined })}
          placeholder="Поиск по описанию"
          className="flex-1"
        />
        <Button
          variant={advanced ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setAdvanced((v) => !v)}
        >
          Фильтры
        </Button>
      </div>

      {advanced && (
        <div className="glass rounded-2xl p-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div>
            <label className="text-xs text-muted">Тип</label>
            <Select
              value={active.type ?? ''}
              onChange={(e) =>
                onChange({ ...active, type: (e.target.value || undefined) as TxType | undefined })
              }
            >
              <option value="">Все</option>
              <option value="INCOME">Доход</option>
              <option value="EXPENSE">Расход</option>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Счёт</label>
            <Select
              value={active.accountId ?? ''}
              onChange={(e) => onChange({ ...active, accountId: e.target.value || undefined })}
            >
              <option value="">Все</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Категория</label>
            <Select
              value={active.categoryId ?? ''}
              onChange={(e) => onChange({ ...active, categoryId: e.target.value || undefined })}
            >
              <option value="">Все</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Контрагент</label>
            <Select
              value={active.counterpartyId ?? ''}
              onChange={(e) => onChange({ ...active, counterpartyId: e.target.value || undefined })}
            >
              <option value="">Все</option>
              {counterparties.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Период с</label>
            <Input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-muted">по</label>
            <Input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button size="sm" onClick={applyCustom}>Применить даты</Button>
          </div>
        </div>
      )}
    </div>
  );
}
