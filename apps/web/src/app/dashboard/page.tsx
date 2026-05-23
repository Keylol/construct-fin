import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

async function fetchMe() {
  const cookie = cookies().get('construct_jwt');
  if (!cookie) return null;
  const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${api}/auth/me`, {
      headers: { authorization: `Bearer ${cookie.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as { user: { firstName: string | null; username: string | null } };
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  const data = await fetchMe();
  if (!data) redirect('/login');

  const name = data.user.firstName ?? data.user.username ?? 'друг';

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="glass rounded-3xl p-8 max-w-md w-full">
        <h1 className="text-2xl font-semibold mb-2">Привет, {name}</h1>
        <p className="text-muted text-sm">
          Это заглушка дашборда. Дальше будут KPI, графики и список последних транзакций.
        </p>
      </div>
    </main>
  );
}
