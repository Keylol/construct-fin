import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning';

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
  /**
   * Если задан — вся карточка становится ссылкой (next/link) и получает
   * hover/focus-аффорданс «кликабельно». Без href ведёт себя как обычная плитка.
   */
  href?: string;
  /**
   * display — «главная цифра» экрана (решение №7 блица): 2.25–2.75rem mono,
   * видно через комнату. md — обычная плитка.
   */
  size?: 'md' | 'display';
  /** Мини-график под значением (Sparkline) — решение №24 блица. */
  chart?: ReactNode;
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: '',
  positive: 'text-success',
  negative: 'text-destructive',
  warning: 'text-warning',
};

const TONE_ACCENT: Record<Tone, string> = {
  neutral: '',
  positive: 'bg-success',
  negative: 'bg-destructive',
  warning: 'bg-warning',
};

export function KpiCard({
  label,
  value,
  hint,
  tone = 'neutral',
  className,
  href,
  size = 'md',
  chart,
}: KpiCardProps) {
  const body = (
    <>
      {tone !== 'neutral' && (
        <span className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])} aria-hidden />
      )}
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'num font-semibold',
          size === 'display' ? 'mt-3 text-4xl sm:text-5xl' : 'mt-2.5 text-2xl',
          TONE_TEXT[tone],
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>}
      {chart && <div className="mt-2">{chart}</div>}
    </>
  );

  const base = cn(
    'relative block overflow-hidden rounded-md border border-border bg-card',
    size === 'display' ? 'p-5' : 'p-4',
  );

  if (href) {
    return (
      <Link
        href={href as Parameters<typeof Link>[0]['href']}
        className={cn(
          base,
          'transition-all hover:-translate-y-0.5 hover:border-ring hover:shadow-sm ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        {body}
      </Link>
    );
  }

  return <div className={cn(base, className)}>{body}</div>;
}
