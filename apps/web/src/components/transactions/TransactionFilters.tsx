'use client';

import { useMemo, type RefObject } from 'react';
import { RotateCcw, X } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { SearchField } from '@/components/ui/SearchField';
import { DateRangeFields, PeriodSelect } from '@/components/ui/PeriodSelect';
import { BUCKET_LABEL } from '@/lib/buckets';
import type { ReportBucket, TxType, Account, Category, Counterparty } from '@/lib/types';
import { type AnyPeriod, type DateRange, rangeForAny } from '@/lib/periods';

export interface ActiveFilters {
  period: AnyPeriod;
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
  /** Поле поиска фокусируется по «/» с экрана операций. */
  searchRef?: RefObject<HTMLInputElement>;
}

/**
 * Полоса фильтров операций — эталон для остальных списков: поиск, период с
 * произвольными датами, измерения, «Сброс». Все контролы — из ui/*, здесь
 * только их порядок и словари опций.
 */
export function TransactionFilters({
  active,
  onChange,
  accounts,
  categories,
  counterparties,
  searchRef,
}: Props) {
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

  return (
    <FilterBar>
      <div className="min-w-[180px] max-w-xs flex-1">
        <FilterField label="Поиск">
          <SearchField
            ref={searchRef}
            value={active.search ?? ''}
            onChange={(e) => onChange({ ...active, search: e.target.value || undefined })}
            placeholder="Описание, контрагент…"
          />
        </FilterField>
      </div>

      <PeriodSelect
        value={active.period}
        onChange={(period, range) => onChange({ ...active, period, range })}
      />
      <DateRangeFields
        range={active.range}
        // Свой диапазон: пресет становится «Всё время», границы — явными.
        onChange={(range) => onChange({ ...active, period: 'all', range })}
      />
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

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange({ period: 'this-month', range: rangeForAny('this-month') })}
        className="self-end"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Сброс
      </Button>
    </FilterBar>
  );
}
