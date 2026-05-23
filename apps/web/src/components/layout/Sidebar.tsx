'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ThemeToggle } from './ThemeToggle';

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 h-dvh sticky top-0 p-4 gap-2 border-r border-white/5">
      <div className="font-semibold text-lg mb-2">Construct</div>
      <div className="glass rounded-2xl p-3 mb-2">
        <WorkspaceSwitcher />
      </div>
      <nav className="flex flex-col gap-1 flex-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 h-10 px-3 rounded-xl transition',
                active ? 'bg-glass text-fg' : 'text-fg/70 hover:bg-glass/50',
              )}
            >
              <span className="w-5 text-center">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <ThemeToggle />
    </aside>
  );
}
