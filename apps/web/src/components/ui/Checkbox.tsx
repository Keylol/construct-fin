import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Подпись справа; без неё — голый квадрат (в ячейках таблиц). */
  label?: ReactNode;
  /** Пояснение под подписью серым. */
  hint?: ReactNode;
}

/**
 * Флажок системы: тот же акцент, что у активной навигации и кнопок, та же
 * высота строки, что у полей. До него в двадцати местах лежал сырой
 * `<input type="checkbox">` с классами, набранными каждый раз заново.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, className, id, ...props },
  ref,
) {
  const box = (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      className={cn('h-4 w-4 shrink-0 rounded border-input accent-primary', hint && 'mt-0.5', className)}
      {...props}
    />
  );
  if (!label) return box;
  return (
    <label className="flex items-start gap-2 text-sm">
      {box}
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
});
