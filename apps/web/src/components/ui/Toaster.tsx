'use client';

import { Toaster as Sonner } from 'sonner';

/**
 * Single toaster instance — mount once near the root.
 * Style tuned to match shadcn defaults but with our border + radius.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      // На мобиле тосты поднимаются над FAB «+ Создать» (56px + отступ),
      // чтобы не перекрывать кнопку и не прятать крестик закрытия под ней.
      mobileOffset={{ bottom: 88 }}
      toastOptions={{
        classNames: {
          toast:
            'group toast bg-card text-foreground border border-border shadow-md rounded-md',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground rounded-md',
          cancelButton: 'bg-muted text-muted-foreground rounded-md',
          error: 'bg-destructive text-destructive-foreground border-destructive',
          success: 'bg-success text-success-foreground border-success',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
