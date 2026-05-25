'use client';

import { Button } from '@/components/ui/Button';

export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Ошибка авторизации</h1>
        <p className="mt-2 text-sm text-destructive">
          {error.message || 'Не удалось войти. Попробуйте ещё раз.'}
        </p>
        <Button onClick={reset} className="mt-6 w-full">
          Попробовать снова
        </Button>
      </div>
    </main>
  );
}
