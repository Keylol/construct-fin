'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message || `HTTP ${res.status}`);
      }
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            C
          </div>
          <div className="text-base font-semibold tracking-tight">Construct</div>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Вход</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Введите пароль для доступа к приложению.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <FormField label="Пароль" htmlFor="password" error={error ?? undefined}>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </FormField>
          <Button type="submit" disabled={loading || !password} className="w-full">
            {loading ? 'Вход…' : 'Войти'}
          </Button>
        </form>
      </div>
    </main>
  );
}
