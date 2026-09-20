'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { api } from '@/lib/api';
import { describeLoginFailure } from '@/lib/login-errors';

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
      await api.post('/auth/login', { password });
      router.push('/dashboard');
    } catch (err) {
      setError(describeLoginFailure(err));
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
