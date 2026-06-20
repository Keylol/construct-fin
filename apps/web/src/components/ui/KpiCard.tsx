import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning';

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
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

export function KpiCard({ label, value, hint, tone = 'neutral', className }: KpiCardProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-border bg-card p-4',
        className,
      )}
    >
      {tone !== 'neutral' && (
        <span className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])} aria-hidden />
      )}
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn('num mt-2.5 text-2xl font-semibold', TONE_TEXT[tone])}>{value}</div>
      {hint && <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
