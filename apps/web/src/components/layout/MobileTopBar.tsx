'use client';

import { useState } from 'react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ThemeToggle } from './ThemeToggle';

export function MobileTopBar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="md:hidden sticky top-0 z-30 glass border-b border-white/10 px-4 py-3 flex items-center justify-between">
      <div className="font-semibold">Construct</div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 rounded-xl bg-surface text-sm border border-white/10"
      >
        {open ? 'Скрыть' : 'Меню'}
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 glass border-b border-white/10 p-4 flex flex-col gap-3">
          <WorkspaceSwitcher />
          <ThemeToggle />
        </div>
      )}
    </header>
  );
}
