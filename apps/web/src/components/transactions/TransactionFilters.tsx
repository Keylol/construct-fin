'use client';

import { useMemo, type RefObject } from 'react';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { SearchField } from '@/components/ui/SearchField';
import { DateRangeFields, PeriodSelect } from '@/components/ui/PeriodSelect';
import { BUCKET_LABEL } from '@/lib/buckets';
import { KIND_NO_CATEGORY_LABEL } from '@/lib/labels';
import type {
  ReportBucket,
  TransactionKind,
  TxType,
  Account,
  Category,
  Counterparty,
} from '@/lib/types';
import { type AnyPeriod, type DateRange, rangeForAny } from '@/lib/periods';
import { Chip } from '@/components/ui/Chip';

export interface ActiveFilters {
  period: AnyPeriod;
  range: DateRange;
  accountId?: string;
  categoryId?: string;
  counterpartyId?: string;
  type?: TxType;
  /** P&L-группа — приходит только drill-down'ом из ОПиУ «По группам». */
  bucket?: ReportBucket;
  /**
   * Группа расходов «Итогов месяца» — тоже только drill-down'ом: её статьи и
   * виды операций без статьи (условия внутри группы — через ИЛИ).
   */
  categoryIds?: string[];
  uncategorizedKinds?: TransactionKind[];
  search?: string;
}

/**
 * Подпись чипа группы: корневые статьи (подстатьи группы сворачиваются в свой
 * корень, как в «Итогах месяца») и виды операций без статьи; длинный список —
 * «и ещё N».
 */
function groupChipLabel(active: ActiveFilters, categories: Category[]): string {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const rootName = (id: string) => {
    let cur = byId.get(id);
    for (let depth = 0; cur?.parentId && byId.has(cur.parentId) && depth < 10; depth++) {
      cur = byId.get(cur.parentId);
    }
    return cur?.name ?? 'статья';
  };
  const names = [
    ...new Set((active.categoryIds ?? []).map(rootName)),
    ...(active.uncategorizedKinds ?? []).map((k) => KIND_NO_CATEGORY_LABEL[k]),
  ];
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} и ещё ${names.length - 2}`;
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
            placeholder="Описание, контрагент, статья или сумма"
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
            // bucket-чип и группу «Итогов месяца», иначе несовместимая пара дала
            // бы пустой список.
            onChange({
              ...active,
              categoryId: v || undefined,
              bucket: undefined,
              categoryIds: undefined,
              uncategorizedKinds: undefined,
            })
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
          <Chip
            label={BUCKET_LABEL[active.bucket]}
            onRemove={() => onChange({ ...active, bucket: undefined })}
            title="Снять фильтр группы"
          />
        </FilterField>
      )}
      {((active.categoryIds?.length ?? 0) > 0 || (active.uncategorizedKinds?.length ?? 0) > 0) && (
        <FilterField label="Группа расходов">
          <Chip
            label={groupChipLabel(active, categories)}
            onRemove={() =>
              onChange({ ...active, categoryIds: undefined, uncategorizedKinds: undefined })
            }
            title="Снять фильтр группы расходов"
          />
        </FilterField>
      )}

      <FilterReset onClick={() => onChange({ period: 'this-month', range: rangeForAny('this-month') })} />
    </FilterBar>
  );
}
