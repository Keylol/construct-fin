import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-11 w-full px-3 rounded-xl bg-surface text-fg border border-white/10 outline-none',
          'placeholder:text-muted focus:border-tint focus:ring-2 focus:ring-tint/30',
          'transition disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
