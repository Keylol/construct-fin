'use client';

import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { BottomTabBar } from './BottomTabBar';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { Toaster } from '@/components/ui/Toaster';
import { TooltipProvider } from '@/components/ui/Tooltip';

export function AppShell({ children }: { children: ReactNode }) {
  const [cmdOpen, setCmdOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-dvh bg-background">
        {/* Desktop: icon-rail 64px с расхлопом по hover (решение №17 блица) */}
        <div className="sticky top-0 hidden h-dvh md:flex">
          <Sidebar variant="rail" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <Header onCommandOpen={() => setCmdOpen(true)} />
          {/* На <md контент не прячется под нижним таб-баром (+safe-area). */}
          <main className="min-w-0 flex-1 animate-rise pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
            {children}
          </main>
        </div>
      </div>

      {/* Мобильная навигация одним пальцем (М-волна, решение №22) */}
      <BottomTabBar />

      <GlobalCommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      <Toaster />
    </TooltipProvider>
  );
}
