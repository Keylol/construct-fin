import { forwardRef, type InputHTMLAttributes } from 'react';
import { Search } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

/**
 * Поиск по списку: лупа слева, `type="search"` (крестик очистки от браузера),
 * высота как у остальных контролов полосы фильтров. Ref пробрасывается наружу —
 * его берёт `useListHotkeys`, чтобы «/» ставил курсор сюда.
 */
export const SearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SearchField({ className, ...props }, ref) {
    return (
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input ref={ref} type="search" className={cn('h-9 pl-8', className)} {...props} />
      </div>
    );
  },
);
