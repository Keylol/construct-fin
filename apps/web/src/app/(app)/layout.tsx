import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '../providers';
import { AppShell } from '@/components/layout/AppShell';

async function ensureAuthed(): Promise<void> {
  const cookie = cookies().get('construct_jwt');
  if (!cookie) redirect('/login');
  // INTERNAL_API_URL is server-only and read at runtime (no NEXT_PUBLIC_ prefix
  // so it's not inlined at build time). In docker-compose it points to the
  // api service on the internal network.
  const api = process.env.INTERNAL_API_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${api}/auth/me`, {
      headers: { authorization: `Bearer ${cookie.value}` },
      cache: 'no-store',
    });
    if (!res.ok) redirect('/login');
  } catch (err) {
    if (err && typeof err === 'object' && 'digest' in err) throw err;
    redirect('/login');
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  await ensureAuthed();
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
