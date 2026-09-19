import type { WarehouseSection } from '@/lib/types';

/**
 * Разделы склада — в порядке складской таблицы владельца (корпуса → накопители),
 * в конце то, чего в таблице не было. Порядок массива = порядок групп на экране.
 */
export const WAREHOUSE_SECTIONS: { value: WarehouseSection; label: string }[] = [
  { value: 'CASE', label: 'Корпуса' },
  { value: 'MOTHERBOARD', label: 'Материнские платы' },
  { value: 'PSU', label: 'Блоки питания' },
  { value: 'GPU', label: 'Видеокарты' },
  { value: 'RAM', label: 'ОЗУ' },
  { value: 'CPU', label: 'Процессоры' },
  { value: 'COOLING', label: 'Охлаждение' },
  { value: 'STORAGE', label: 'Накопители' },
  { value: 'FANS', label: 'Вентиляторы' },
  { value: 'OTHER', label: 'Прочее' },
];

export function isWarehouseSection(v: string): v is WarehouseSection {
  return WAREHOUSE_SECTIONS.some((s) => s.value === v);
}

/** Ключ группы для позиций без раздела (заведены до разделов). */
export const NO_SECTION = 'NONE';

export function sectionLabel(key: string): string {
  return WAREHOUSE_SECTIONS.find((s) => s.value === key)?.label ?? 'Без раздела';
}

/** Порядковый номер раздела для сортировки; «без раздела» — в самом конце. */
export function sectionRank(section: WarehouseSection | null): number {
  const i = WAREHOUSE_SECTIONS.findIndex((s) => s.value === section);
  return i === -1 ? WAREHOUSE_SECTIONS.length : i;
}
