import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-11 w-full px-3 rounded-xl bg-surface text-fg border border-white/10 outline-none',
          'focus:border-tint focus:ring-2 focus:ring-tint/30 transition appearance-none',
          'bg-[length:12px] bg-no-repeat bg-[position:calc(100%-12px)_center]',
          // chevron-down SVG (inline)
          "bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none'><path d='M3 5l3 3 3-3' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/></svg>\")]",
          'pr-8',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
