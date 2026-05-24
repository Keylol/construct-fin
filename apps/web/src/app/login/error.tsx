'use client';

import { useEffect } from 'react';

export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('LoginError boundary caught:', error);
  }, [error]);

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="glass rounded-3xl p-6 max-w-md w-full">
        <h1 className="text-xl font-semibold mb-3">Ошибка авторизации</h1>
        <p className="text-sm text-danger mb-2">{error.message || 'Unknown error'}</p>
        {error.digest && (
          <p className="text-xs text-muted mb-3">digest: {error.digest}</p>
        )}
        {error.stack && (
          <pre className="text-[10px] text-muted whitespace-pre-wrap break-all max-h-64 overflow-auto bg-glass/40 p-2 rounded">
            {error.stack}
          </pre>
        )}
        <button
          onClick={reset}
          className="mt-4 rounded-xl bg-tint px-4 py-2 text-sm text-white"
        >
          Перезапустить
        </button>
      </div>
    </main>
  );
}
