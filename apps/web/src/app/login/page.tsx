'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? '';

interface TelegramWebApp {
  initData: string;
  ready?: () => void;
  expand?: () => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
    onTelegramAuth?: (user: unknown) => void;
  }
}

export default function LoginPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'detect' | 'miniapp' | 'widget'>('detect');

  // 1. Mini App: если открыты внутри Telegram, автоматически логинимся по initData.
  //    SDK подгружается в layout, но скрипт может быть ещё не выполнен на момент
  //    первого useEffect — поэтому пробуем несколько раз.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 20; // 20 × 100ms = 2 секунды

    const tryAuth = async () => {
      if (cancelled) return;
      const wa = window.Telegram?.WebApp;
      const initData = wa?.initData;
      if (initData && initData.length > 0) {
        setMode('miniapp');
        wa.ready?.();
        wa.expand?.();
        try {
          const res = await fetch('/api/v1/auth/telegram/miniapp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ initData }),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || `HTTP ${res.status}`);
          }
          router.push('/dashboard');
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Mini App login failed');
        }
        return;
      }
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) {
        setMode('widget');
        return;
      }
      setTimeout(tryAuth, 100);
    };
    tryAuth();

    return () => {
      cancelled = true;
    };
  }, [router]);

  // 2. Иначе — Login Widget (требует HTTPS-домен в BotFather)
  useEffect(() => {
    if (mode !== 'widget' || !containerRef.current || !BOT_USERNAME) return;

    window.onTelegramAuth = async (user) => {
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
  }, [mode, router]);

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="glass rounded-3xl p-8 max-w-md w-full text-center">
        <h1 className="text-2xl font-semibold mb-2">Вход</h1>
        <p className="text-muted mb-6 text-sm">
          {mode === 'miniapp'
            ? 'Авторизация через Telegram Mini App…'
            : 'Подтвердите свой Telegram-аккаунт'}
        </p>
        {mode === 'widget' && <div ref={containerRef} className="flex justify-center" />}
        {mode === 'miniapp' && !error && (
          <div className="text-muted text-sm">Один момент…</div>
        )}
        {mode === 'widget' && !BOT_USERNAME && (
          <p className="mt-4 text-sm text-danger">
            NEXT_PUBLIC_TELEGRAM_BOT_USERNAME не задан в .env
          </p>
        )}
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    </main>
  );
}
