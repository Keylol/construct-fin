'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Search } from '@/components/ui/icons';
import { openGlobalSearch } from '@/components/layout/global-search';

/**
 * Поиск на Главной: выглядит как поле и открывает общий поиск — ту же палитру,
 * что ⌘K. Он находит заказ, клиента, операцию, строку выписки, закупку или товар
 * в любом разделе. На телефоне от поиска в шапке остаётся только значок, поэтому
 * на Главной поле видно всегда.
 */
export function DashboardSearch() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);

  return (
    <Button
      variant="secondary"
      onClick={openGlobalSearch}
      aria-label="Поиск по всем разделам"
      className="h-11 w-full justify-start gap-3 px-3 font-normal text-muted-foreground"
    >
      <span aria-hidden className="flex">
        <Search />
      </span>
      <span className="min-w-0 truncate">Найти заказ, клиента, сумму или операцию</span>
      <kbd className="ml-auto hidden rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground sm:inline">
        {isMac ? '⌘K' : 'Ctrl+K'}
      </kbd>
    </Button>
  );
}
