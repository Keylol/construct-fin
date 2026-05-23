import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '../providers';
import { AppShell } from '@/components/layout/AppShell';

async function ensureAuthed(): Promise<void> {
  const cookie = cookies().get('construct_jwt');
  if (!cookie) redirect('/login');
  const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${api}/auth/me`, {
      headers: { authorization: `Bearer ${cookie.value}` },
      cache: 'no-store',
    });
    if (!res.ok) redirect('/login');
  } catch {
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
