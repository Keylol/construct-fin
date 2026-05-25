import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Native <select> styled to match the design system. Native is intentional —
 * it gives proper mobile UX (system picker) and zero JS weight. For richer
 * combobox use cases (search, async loading) reach for a Radix-based wrapper.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'flex w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm',
          'text-foreground shadow-xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'h-10 sm:h-9',
          'bg-[length:12px] bg-no-repeat bg-[position:calc(100%-12px)_center]',
          "bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none'><path d='M3 5l3 3 3-3' stroke='%2364748B' stroke-width='1.5' stroke-linecap='round'/></svg>\")]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
