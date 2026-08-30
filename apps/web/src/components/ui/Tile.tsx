'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Плитка — единая карточка сущности для всех «плиточных» экранов: заказы,
 * клиенты, контрагенты. Анатомия у всех одна, меняются только данные:
 *
 *   ┌──────────────────────────────────────┐
 *   │ ФИО / название           штампы      │  ← кто это и в каком состоянии
 *   │ телефон или контакт                  │  ← чем опознаётся
 *   │ главная сумма              акцент    │  ← деньги; акцент цветной
 *   └──────────────────────────────────────┘
 *
 * Разные экраны отличаются тем, ЧТО подставлено в эти слоты, а не тем, как
 * плитка выглядит: одинаковые отступы, рамка, ховер и фокус задаются здесь.
 */
export function Tile({
  title,
  stamps,
  subtitle,
  primary,
  accent,
  selected,
  onClick,
  className,
}: {
  /** Кто это: ФИО клиента, название контрагента. */
  title: ReactNode;
  /** До двух штампов состояния либо счётчик группы. */
  stamps?: ReactNode;
  /** Чем опознаётся: телефон заказа, контакт клиента. Цифры моноширинные. */
  subtitle?: ReactNode;
  /** Главная величина: сумма заказа, оборот клиента. */
  primary?: ReactNode;
  /** Правый акцент: долг, прибыль, остаток. Цвет задаёт вызывающий. */
  accent?: ReactNode;
  /** Раскрытая группа подсвечивается, чтобы было видно, что открыто. */
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={selected === undefined ? undefined : selected}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border px-3.5 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary/40 bg-secondary/40'
          : 'border-border bg-card hover:border-primary/40 hover:bg-secondary/30',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{title}</span>
        {stamps && <span className="flex shrink-0 gap-1">{stamps}</span>}
      </div>

      {subtitle !== undefined && (
        <div className="truncate text-sm tabular-nums text-muted-foreground">{subtitle}</div>
      )}

      {(primary !== undefined || accent !== undefined) && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-base font-semibold tabular-nums">{primary}</span>
          {accent !== undefined && <span className="text-xs tabular-nums">{accent}</span>}
        </div>
      )}
    </button>
  );
}

/** Сетка плиток — одинаковая плотность на всех экранах. */
export function TileGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {children}
    </div>
  );
}

/** Переключатель «Список / Плитки» — общий для всех экранов с двумя видами. */
export function ViewToggle({
  view,
  onChange,
  label = 'Вид',
}: {
  view: 'list' | 'tiles';
  onChange: (next: 'list' | 'tiles') => void;
  label?: string;
}) {
  return (
    <label className="flex flex-col text-xs text-muted-foreground">
      <span className="pb-1">{label}</span>
      <div className="flex h-9 items-center rounded-sm border border-input bg-background p-0.5">
        {(['list', 'tiles'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={view === v}
            className={cn(
              'h-full rounded-sm px-3 text-sm transition-colors',
              view === v
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {v === 'list' ? 'Список' : 'Плитки'}
          </button>
        ))}
      </div>
    </label>
  );
}

/**
 * Выбранный вид с запоминанием. Экранов с плитками несколько, и выбор на каждом
 * свой: заказы обычно смотрят плитками, справочники — списком. Ключ хранилища
 * задаёт вызывающий («orders:view», «clients:view»).
 */
export function useTileView(storageKey: string) {
  const [view, setView] = useState<'list' | 'tiles'>('list');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === 'tiles' || saved === 'list') setView(saved);
    } catch {
      // Приватный режим и заблокированное хранилище — не повод падать.
    }
  }, [storageKey]);

  const change = (next: 'list' | 'tiles') => {
    setView(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // см. выше
    }
  };

  return [view, change] as const;
}
