'use client';

import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { Toaster } from '@/components/ui/Toaster';
import { TooltipProvider } from '@/components/ui/Tooltip';

export function AppShell({ children }: { children: ReactNode }) {
  const [cmdOpen, setCmdOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-dvh bg-background">
        {/* Desktop sidebar — sticky full height */}
        <div className="sticky top-0 hidden h-dvh md:flex">
          <Sidebar />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <Header onCommandOpen={() => setCmdOpen(true)} />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>

      <GlobalCommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      <Toaster />
    </TooltipProvider>
  );
}
