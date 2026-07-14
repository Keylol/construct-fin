import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Требует роль OWNER в workspace. Ставится ПОСЛЕ WorkspaceGuard (тот кладёт
 * req.workspace с role по членству).
 *
 * Первый ролевой гейт в проекте — осознанное отступление от плоской модели
 * ролей (все члены равны), ТОЛЬКО для настроек интеграций и банковских
 * секретов (Ф1, решение №11/№18): токены видит/меняет лишь владелец, оператор
 * работает с результатом (Inbox/операции), но не с ключами.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const ws = req.workspace;
    if (!ws) throw new ForbiddenException('Нет контекста пространства');
    if (ws.role !== 'OWNER') {
      throw new ForbiddenException('Управление интеграциями доступно только владельцу пространства');
    }
    return true;
  }
}
