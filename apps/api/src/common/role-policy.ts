import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

/**
 * Что можно роли в пространстве. До этого роли лежали в `WorkspaceMember`
 * «на вырост» и нигде не проверялись: любой член пространства мог всё.
 * С появлением второго входа (оператор, см. AuthService.loginViaPassword)
 * правило простое и проверяется в одном месте — WorkspaceGuard:
 *
 *   OWNER / ADMIN — всё;
 *   MEMBER        — вносит и правит, но не удаляет и не отменяет: любой
 *                   DELETE и обработчики с `@Destructive()` закрыты;
 *   VIEWER        — только чтение.
 *
 * Тонкой матрицы прав нет нарочно: одному бизнесу нужны два человека, а не
 * система ролей.
 */
export const DESTRUCTIVE_KEY = 'destructive';

/** Помечает не-DELETE обработчик, который отменяет сделанное (отмена заказа, откат оплаты). */
export const Destructive = () => SetMetadata(DESTRUCTIVE_KEY, true);

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Причина отказа для роли, либо null — можно. */
export function deniedForRole(role: Role, method: string, destructive: boolean): string | null {
  if (role === 'OWNER' || role === 'ADMIN') return null;
  const m = method.toUpperCase();
  if (role === 'VIEWER') {
    return MUTATING_METHODS.has(m) ? 'Ваша роль — только просмотр' : null;
  }
  if (m === 'DELETE' || destructive) {
    return 'Удаление и отмена доступны только владельцу пространства';
  }
  return null;
}
