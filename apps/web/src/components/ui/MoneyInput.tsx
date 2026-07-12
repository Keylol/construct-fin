import { forwardRef, type InputHTMLAttributes } from 'react';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

/**
 * Денежное поле (решение №32 блица): mono-цифры прямо в инпуте + суффикс ₽.
 * Ввод ощущается как бухгалтерия — цифры ровно выровнены, валюта видна.
 * Тонкая обёртка над Input: aria/id-инъекция FormField работает как обычно.
 */
export const MoneyInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode'>
>(function MoneyInput({ className, ...props }, ref) {
  return (
    <div className="relative">
      <Input
        ref={ref}
        inputMode="decimal"
        className={cn('num pr-8', className)}
        {...props}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
      >
        ₽
      </span>
    </div>
  );
});
