'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { Locked } from '@/components/ui/icons';
import { isOwnerLike } from '@/lib/roles';
import type { Role } from '@/lib/types';
import { isPathOwnerOnly } from './nav-items';

/**
 * Прямой адрес технического раздела у оператора: меню его не показывает, но
 * ссылка из истории или чата открыла бы экран. Данные всё равно не пострадают
 * (сервер держит правило), а вот экран с ошибками на каждый клик — плохая
 * замена честному «недоступно».
 */
export function RoleGate({ role, children }: { role: Role; children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  if (isOwnerLike(role) || !isPathOwnerOnly(pathname)) return <>{children}</>;
  return (
    <div className="p-6">
      <EmptyState
        icon={Locked}
        title="Раздел недоступен"
        hint="Технические разделы и настройки справочников открыты только владельцу пространства."
        action={
          <Button asChild variant="secondary">
            <Link href="/dashboard">На главную</Link>
          </Button>
        }
      />
    </div>
  );
}
