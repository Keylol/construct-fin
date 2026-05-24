'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const TABS = [
  { href: '/reports', label: 'P&L' },
  { href: '/reports/cashflow', label: 'Cash flow' },
  { href: '/reports/categories', label: 'Категории' },
  { href: '/reports/counterparties', label: 'Контрагенты' },
  { href: '/reports/rules', label: 'Правила' },
];

export default function ReportsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Отчёты</h1>
        <nav className="flex flex-wrap gap-2 border-b border-glass-border pb-2">
          {TABS.map((t) => {
            const active = pathname === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-t-md px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-glass/60 font-medium text-fg'
                    : 'text-muted hover:bg-glass/30 hover:text-fg'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}
