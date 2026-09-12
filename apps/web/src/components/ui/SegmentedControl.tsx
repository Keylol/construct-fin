'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  /** Подсказка (title) — когда сегмент только с иконкой. */
  title?: string;
  /** Смысловой цвет текста активного сегмента: «Расход» красным, «Доход» зелёным. */
  tone?: 'success' | 'destructive';
}

/**
 * Переключатель из нескольких взаимоисключающих сегментов: «Список / Плитки»
 * в заказах, «Склад / Заказ / Расход» у строки чека. Один примитив вместо
 * двух наборов сырых `<button>` с разной раскраской. Семантика — группа
 * радиокнопок (стрелки, aria-checked), вид — тихий: активный сегмент на
 * secondary-подложке, а не заливкой navy (она — для главного действия).
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'sm',
  fullWidth,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: SegmentOption<T>[];
  ariaLabel: string;
  size?: 'sm' | 'md';
  /** Растянуть на ширину контейнера, сегменты поровну (тип операции в форме). */
  fullWidth?: boolean;
  className?: string;
}) {
  const move = (delta: number) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + delta + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-input bg-card p-0.5',
        size === 'sm' ? 'h-8' : 'h-9',
        fullWidth && 'flex w-full',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-full items-center gap-1.5 rounded-sm px-2.5 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              fullWidth && 'flex-1 justify-center',
              active
                ? cn(
                    'bg-secondary font-medium',
                    o.tone === 'success'
                      ? 'text-success'
                      : o.tone === 'destructive'
                        ? 'text-destructive'
                        : 'text-foreground',
                  )
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
