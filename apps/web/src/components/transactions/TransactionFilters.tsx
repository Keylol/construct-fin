'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, RotateCcw, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { FilterBar } from '@/components/ui/FilterBar';
import { BUCKET_LABEL } from '@/lib/buckets';
import type { ReportBucket, TxType, Account, Category, Counterparty } from '@/lib/types';
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
  /** P&L-группа — приходит только drill-down'ом из ОПиУ «По группам». */
  bucket?: ReportBucket;
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

  // Синк полей дат при ВНЕШНЕЙ смене диапазона (заезд из URL/drill-down, сброс).
  // Ввод в сами инпуты round-trip'ит через range → значение не меняется, цикла нет.
  useEffect(() => {
    setCustomFrom(active.range.from ? toLocalDateInput(active.range.from) : '');
    setCustomTo(active.range.to ? toLocalDateInput(active.range.to) : '');
  }, [active.range.from, active.range.to]);

  // Категории для комбобокса: та же иерархия групп, что в TransactionFormDialog —
  // заголовок = «kind · родитель», внутри «(общая)» + подкатегории. Список уже
  // без архивных (сервер), фильтр по isArchived не дублируем.
  const categoryOptions = useMemo<ComboboxOption[]>(() => {
    const forKind = (kind: 'INCOME' | 'EXPENSE', kindLabel: string) =>
      categories
        .filter((c) => c.kind === kind && c.parentId === null)
        .flatMap((root) => [
          {
            value: root.id,
            label: `${root.name} (общая)`,
            group: `${kindLabel} · ${root.name}`,
          },
          ...categories
            .filter((c) => c.parentId === root.id)
            .map((child) => ({
              value: child.id,
              label: child.name,
              group: `${kindLabel} · ${root.name}`,
            })),
        ]);
    return [...forKind('EXPENSE', 'Расходы'), ...forKind('INCOME', 'Доходы')];
  }, [categories]);

  const counterpartyOptions = useMemo<ComboboxOption[]>(
    () =>
      counterparties.map((c) => ({
        value: c.id,
        label: c.name,
        description: c.contact ?? undefined,
      })),
    [counterparties],
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
        <Combobox
          value={active.categoryId ?? ''}
          onChange={(v) =>
            // Категория сама определяет P&L-группу — выбор категории снимает
            // bucket-чип, иначе несовместимая пара дала бы пустой список.
            onChange({ ...active, categoryId: v || undefined, bucket: undefined })
          }
          options={categoryOptions}
          placeholder="Все"
          searchPlaceholder="Название категории…"
          clearLabel="Все категории"
          className="h-9 w-[160px]"
        />
      </FilterField>
      <FilterField label="Контрагент">
        <Combobox
          value={active.counterpartyId ?? ''}
          onChange={(v) =>
            onChange({
              ...active,
              counterpartyId: v || undefined,
            })
          }
          options={counterpartyOptions}
          placeholder="Все"
          searchPlaceholder="Имя или контакт…"
          clearLabel="Все контрагенты"
          className="h-9 w-[160px]"
        />
      </FilterField>

      {/* Чип группы ОПиУ: свой контрол не заводим — значение приходит только
          drill-down'ом из отчёта, здесь его можно лишь увидеть и снять. */}
      {active.bucket && (
        <FilterField label="Группа ОПиУ">
          <button
            type="button"
            onClick={() => onChange({ ...active, bucket: undefined })}
            title="Снять фильтр группы"
            className="flex h-9 items-center gap-1.5 rounded-sm border border-input bg-secondary px-2.5 text-sm text-foreground transition-colors hover:bg-secondary/70"
          >
            {BUCKET_LABEL[active.bucket]}
            <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </button>
        </FilterField>
      )}

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
