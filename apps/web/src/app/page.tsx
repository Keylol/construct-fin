import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export default function HomePage() {
  const cookie = cookies().get('construct_jwt');
  if (cookie) redirect('/dashboard');

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="glass rounded-3xl p-8 max-w-md w-full text-center">
        <h1 className="text-3xl font-semibold mb-2">Construct</h1>
        <p className="text-muted mb-6">Финансовый учёт для малого бизнеса</p>
        <Link
          href="/login"
          className="inline-block bg-tint text-white font-medium px-6 py-3 rounded-2xl hover:opacity-90 transition"
        >
          Войти через Telegram
        </Link>
      </div>
    </main>
  );
}
