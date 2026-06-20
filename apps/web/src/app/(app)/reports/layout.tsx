'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/reports', label: 'P&L' },
  { href: '/reports/cashflow', label: 'Cash flow' },
  { href: '/reports/categories', label: 'Категории' },
  { href: '/reports/counterparties', label: 'Контрагенты' },
  { href: '/reports/margin', label: 'Маржа' },
  { href: '/reports/receivables', label: 'Дебиторка' },
  { href: '/reports/rules', label: 'Правила' },
] as const;

export default function ReportsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <PageHeader
        title="Отчёты"
        breadcrumbs={[{ label: 'Аналитика' }, { label: 'Отчёты' }]}
      />
      <nav
        aria-label="Разделы отчётов"
        className="border-b border-border bg-background"
      >
        <ul className="flex flex-wrap items-center gap-6 px-6">
          {TABS.map((t) => {
            const active = pathname === t.href;
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className={cn(
                    'inline-flex h-10 items-center border-b-2 px-1 text-sm transition-colors',
                    active
                      ? 'border-primary font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div>{children}</div>
    </>
  );
}
