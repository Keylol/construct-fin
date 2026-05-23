'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? '';

export default function LoginPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !BOT_USERNAME) return;

    // глобальный коллбек для Telegram Login Widget
    (window as unknown as { onTelegramAuth?: (user: unknown) => void }).onTelegramAuth = async (
      user,
    ) => {
      try {
        const res = await fetch('/api/v1/auth/telegram/widget', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(user),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }
        router.push('/dashboard');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Login failed');
      }
    };

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '20');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    containerRef.current.appendChild(script);

    return () => {
      containerRef.current?.replaceChildren();
    };
  }, [router]);

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="glass rounded-3xl p-8 max-w-md w-full text-center">
        <h1 className="text-2xl font-semibold mb-2">Вход</h1>
        <p className="text-muted mb-6 text-sm">Подтвердите свой Telegram-аккаунт</p>
        <div ref={containerRef} className="flex justify-center" />
        {!BOT_USERNAME && (
          <p className="mt-4 text-sm text-danger">
            NEXT_PUBLIC_TELEGRAM_BOT_USERNAME не задан в .env
          </p>
        )}
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    </main>
  );
}
