import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Button } from '@/components/ui/Button';

export default function HomePage() {
  const cookie = cookies().get('construct_jwt');
  if (cookie) redirect('/dashboard');

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            C
          </div>
          <div className="text-base font-semibold tracking-tight">Construct</div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Финансовый учёт</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Доходы, расходы и отчёты для малого бизнеса и самозанятых.
        </p>
        <Button asChild className="mt-6 w-full">
          <Link href="/login">Войти</Link>
        </Button>
      </div>
    </main>
  );
}
