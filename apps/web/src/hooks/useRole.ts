'use client';

import { useCurrentWorkspace } from './useCurrentWorkspace';
import { ROLE_LABEL, isOwnerLike } from '@/lib/roles';

/**
 * Роль в текущем пространстве и что из неё следует для экрана: `canDelete` —
 * рисовать ли «Удалить»/«Отменить», `ownerSections` — показывать ли
 * технические разделы и справочники. Сервер проверяет то же сам.
 */
export function useRole() {
  const { current } = useCurrentWorkspace();
  const role = current?.role ?? null;
  const owner = isOwnerLike(role);
  return { role, label: role ? ROLE_LABEL[role] : '', canDelete: owner, ownerSections: owner };
}
