import type { Role } from '@/lib/types';

/**
 * Роли пространства (см. docs/roles.md). Владелец — он же разработчик; оператор
 * (MEMBER) вносит и правит, но не удаляет и не отменяет, технические разделы
 * ему не показываются. Правило держит сервер (WorkspaceGuard); здесь — только
 * что рисовать.
 */
export const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Владелец',
  ADMIN: 'Управляющий',
  MEMBER: 'Оператор',
  VIEWER: 'Наблюдатель',
};

/** Видит технические разделы и справочники, может удалять и отменять. */
export function isOwnerLike(role: Role | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
