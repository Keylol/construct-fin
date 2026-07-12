'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, Plus, Search } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export interface ComboboxOption {
  value: string;
  /** Основная строка опции и подпись выбранного значения в триггере. */
  label: string;
  /** Вторичная строка серым: «ост. 12 шт · посл. закупка 450 ₽», «долг 8 500 ₽»… */
  description?: string;
  /** Дополнительные слова для поиска (SKU, телефон) — не отображаются. */
  keywords?: string[];
  /** Заголовок секции (например, родительская категория). */
  group?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  /** Текущее значение; '' = не выбрано. */
  value: string;
  onChange: (value: string) => void;
  /** Текст триггера, пока ничего не выбрано. */
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  /**
   * Ключ секции «Недавние» в localStorage (`${wsId}:${entity}`).
   * Без ключа секция не показывается.
   */
  recentKey?: string;
  /** Пункт «не выбрано» в начале списка (например «— Без клиента —»). */
  clearLabel?: string;
  /** «+ Создать „{query}“»: включает создание-на-лету. Получает текущий query. */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  /**
   * local (по умолчанию) — фильтрует cmdk по label+description+keywords.
   * server — фильтрацию делает вызывающий (options уже отфильтрованы API),
   * строка поиска прокидывается через onSearchChange.
   */
  searchMode?: 'local' | 'server';
  onSearchChange?: (query: string) => void;
  /** Данные ещё грузятся (для server-режима). */
  loading?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

const RECENT_LIMIT = 5;

function readRecents(key: string): string[] {
  try {
    const raw = localStorage.getItem(`combobox-recent:${key}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(key: string, id: string) {
  try {
    const next = [id, ...readRecents(key).filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(`combobox-recent:${key}`, JSON.stringify(next));
  } catch {
    // localStorage недоступен (приватный режим) — «Недавние» просто не работают.
  }
}

/**
 * Searchable-селект для справочников: поиск, клавиатурная навигация (cmdk),
 * «Недавние», вторичная строка в опции, «+ Создать» на лету. Для коротких
 * закрытых перечислений (тип счёта, статус) остаётся нативный ui/Select.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Выбрать…',
  searchPlaceholder = 'Поиск…',
  emptyLabel = 'Ничего не найдено',
  recentKey,
  clearLabel,
  onCreate,
  createLabel = (q) => `Создать «${q}»`,
  searchMode = 'local',
  onSearchChange,
  loading,
  disabled,
  id,
  className,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedby,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  // Снимок «Недавних» на момент открытия — чтобы список не прыгал после выбора.
  const [recents, setRecents] = React.useState<string[]>([]);
  const listId = React.useId();

  const selected = options.find((o) => o.value === value) ?? null;

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      setQuery('');
      onSearchChange?.('');
      if (recentKey) setRecents(readRecents(recentKey));
    }
  };

  const handleSelect = (v: string) => {
    onChange(v);
    if (v && recentKey) pushRecent(recentKey, v);
    setOpen(false);
  };

  const handleQuery = (q: string) => {
    setQuery(q);
    onSearchChange?.(q);
  };

  // «Недавние» — только пока строка поиска пуста; резолвим по текущим options.
  const recentOptions =
    query === ''
      ? recents
          .map((id) => options.find((o) => o.value === id))
          .filter((o): o is ComboboxOption => !!o && !o.disabled)
      : [];

  // Группировка: опции без group идут одной безымянной секцией в порядке подачи.
  const grouped = React.useMemo(() => {
    const map = new Map<string, ComboboxOption[]>();
    for (const o of options) {
      const g = o.group ?? '';
      const arr = map.get(g);
      if (arr) arr.push(o);
      else map.set(g, [o]);
    }
    return [...map.entries()];
  }, [options]);

  const trimmedQuery = query.trim();

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedby}
          disabled={disabled}
          className={cn(
            // Стили Input/Select — триггер выглядит как обычное поле формы.
            'flex w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm',
            'text-foreground shadow-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring',
            'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/40 aria-[invalid=true]:focus-visible:border-destructive',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'h-10 sm:h-9',
            className,
          )}
        >
          <span className={cn('truncate text-left', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            'z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-md border border-border bg-card shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'motion-reduce:animate-none',
          )}
        >
          <CommandPrimitive shouldFilter={searchMode === 'local'} className="flex flex-col">
            <div className="flex items-center border-b border-border px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                autoFocus
                value={query}
                onValueChange={handleQuery}
                placeholder={searchPlaceholder}
                className="flex h-9 w-full bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <CommandPrimitive.List
              id={listId}
              className="max-h-[280px] overflow-y-auto overflow-x-hidden p-1"
            >
              <CommandPrimitive.Empty className="px-2 py-4 text-center text-sm text-muted-foreground">
                {loading ? 'Загрузка…' : emptyLabel}
              </CommandPrimitive.Empty>

              {clearLabel && query === '' && (
                <ComboboxItem
                  option={{ value: '', label: clearLabel }}
                  isSelected={value === ''}
                  muted
                  onSelect={() => handleSelect('')}
                />
              )}

              {recentOptions.length > 0 && (
                <CommandPrimitive.Group
                  heading="Недавние"
                  className={GROUP_CLASSES}
                >
                  {recentOptions.map((o) => (
                    <ComboboxItem
                      key={`recent-${o.value}`}
                      option={o}
                      isSelected={o.value === value}
                      onSelect={() => handleSelect(o.value)}
                      // value должен отличаться от основного пункта, иначе cmdk
                      // подсветит оба; поиск по «Недавним» не нужен — секция
                      // видна только при пустом query.
                      cmdkValue={`recent-${o.value}`}
                    />
                  ))}
                </CommandPrimitive.Group>
              )}

              {grouped.map(([group, opts]) => (
                <CommandPrimitive.Group
                  key={group || '__default__'}
                  heading={group || undefined}
                  className={GROUP_CLASSES}
                >
                  {opts.map((o) => (
                    <ComboboxItem
                      key={o.value}
                      option={o}
                      isSelected={o.value === value}
                      onSelect={() => handleSelect(o.value)}
                    />
                  ))}
                </CommandPrimitive.Group>
              ))}

              {onCreate && trimmedQuery !== '' && (
                <CommandPrimitive.Item
                  // value содержит сам query → пункт проходит фильтр cmdk всегда.
                  value={`__create__ ${trimmedQuery}`}
                  onSelect={() => {
                    setOpen(false);
                    onCreate(trimmedQuery);
                  }}
                  className={cn(ITEM_CLASSES, 'text-primary')}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{createLabel(trimmedQuery)}</span>
                </CommandPrimitive.Item>
              )}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

const ITEM_CLASSES =
  'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none ' +
  'data-[selected=true]:bg-secondary data-[selected=true]:text-foreground ' +
  'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50';

const GROUP_CLASSES =
  'overflow-hidden [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 ' +
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide ' +
  '[&_[cmdk-group-heading]]:text-muted-foreground';

function ComboboxItem({
  option,
  isSelected,
  onSelect,
  muted,
  cmdkValue,
}: {
  option: ComboboxOption;
  isSelected: boolean;
  onSelect: () => void;
  muted?: boolean;
  cmdkValue?: string;
}) {
  return (
    <CommandPrimitive.Item
      // Фильтр cmdk матчит по value + keywords: ищем и по подписи, и по
      // вторичной строке (SKU, контакт), не показывая их приоритет.
      value={cmdkValue ?? `${option.value} ${option.label}`}
      keywords={[option.label, option.description ?? '', ...(option.keywords ?? [])].filter(Boolean)}
      disabled={option.disabled}
      onSelect={onSelect}
      className={ITEM_CLASSES}
    >
      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center')}>
        {isSelected && <Check className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', muted && 'text-muted-foreground')}>
          {option.label}
        </span>
        {option.description && (
          <span className="block truncate text-xs text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </CommandPrimitive.Item>
  );
}
