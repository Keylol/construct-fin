'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { NavTabs } from '@/components/ui/NavTabs';
import { useRole } from '@/hooks/useRole';

const TABS = [
  { href: '/reports', label: 'ОПиУ' },
  { href: '/reports/cashflow', label: 'ОДДС' },
  { href: '/reports/balance', label: 'Баланс' },
  { href: '/reports/categories', label: 'По категориям' },
  { href: '/reports/counterparties', label: 'По контрагентам' },
  { href: '/reports/margin', label: 'Валовая прибыль' },
  { href: '/reports/breakeven', label: 'Безубыточность' },
  { href: '/reports/budget', label: 'Бюджет' },
  { href: '/reports/receivables', label: 'Дебиторская задолженность' },
  { href: '/reports/rules', label: 'Правила', ownerOnly: true },
] as const;

export default function ReportsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { ownerSections } = useRole();
  // «Правила» — технический раздел, оператору не показываем (docs/roles.md).
  const tabs = TABS.filter((t) => !('ownerOnly' in t) || ownerSections);
  // Заголовок — имя открытого отчёта, а не слово «Отчёты»: раздел уже назван
  // в крошках сверху, а вкладок десять и на них легко потерять, где ты.
  const active = tabs.find((t) => t.href === pathname);
  return (
    <>
      <PageHeader title={active ? active.label : 'Отчёты'} />
      <NavTabs items={[...TABS]} ariaLabel="Разделы отчётов" />
      <div>{children}</div>
    </>
  );
}
