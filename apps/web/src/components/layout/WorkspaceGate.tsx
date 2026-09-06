'use client';

import { useState, type ReactNode } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Plus, Wallet } from '@/components/ui/icons';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

/**
 * Один вход для всех экранов: пока список пространств грузится — скелетон
 * страницы; упал — честная ошибка с «Повторить»; пространств нет — «создайте
 * первое». Раньше каждый экран нёс свою копию блока «Нет активного
 * пространства» и показывал её и на загрузке, и на ошибке, и когда
 * пространств правда нет — три разных ситуации одним текстом.
 *
 * Дальше экраны получают гарантию: `useCurrentWorkspace().current` не null.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { current, workspaces, select } = useCurrentWorkspace();
  const [creating, setCreating] = useState(false);

  if (current) return <>{children}</>;

  if (workspaces.isError) {
    return (
      <ErrorState
        error={workspaces.error}
        onRetry={() => void workspaces.refetch()}
        title="Не удалось загрузить пространства"
      />
    );
  }

  if (workspaces.isSuccess) {
    return (
      <>
        <div className="p-6">
          <EmptyState
            icon={Wallet}
            title="Пространств пока нет"
            hint="Пространство — это один бизнес: свои счета, заказы и отчёты."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                Создать пространство
              </Button>
            }
          />
        </div>
        <CreateWorkspaceModal open={creating} onOpenChange={setCreating} onCreated={select} />
      </>
    );
  }

  return <PageSkeleton />;
}

/** Каркас экрана на время загрузки: шапка, полоса KPI, строки таблицы. */
function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Загрузка">
      <div className="flex items-end justify-between border-b border-border px-6 py-5">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid gap-3 px-6 py-4 sm:grid-cols-3">
        <Skeleton className="h-[88px]" />
        <Skeleton className="h-[88px]" />
        <Skeleton className="h-[88px]" />
      </div>
      <div className="space-y-2 px-6 py-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
