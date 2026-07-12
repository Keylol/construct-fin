import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'flex w-full rounded-md border border-input bg-card px-3 py-1 text-sm',
          'text-foreground shadow-xs transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring',
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/40 aria-[invalid=true]:focus-visible:border-destructive',
          'disabled:cursor-not-allowed disabled:opacity-50',
          // Compact on desktop, slightly taller for touch on mobile
          'h-10 sm:h-9',
          className,
        )}
        {...props}
      />
    );
  },
);
