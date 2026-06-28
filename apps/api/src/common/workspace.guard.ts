import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.service';
import type { Role } from '@prisma/client';

export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    workspace?: WorkspaceContext;
  }
}

/**
 * Проверяет, что аутентифицированный пользователь — член workspace из URL-параметра :wsId.
 * Должен идти после JwtAuthGuard.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: JwtPayload }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    const params = req.params as { wsId?: string } | undefined;
    const wsId = params?.wsId;
    if (!wsId) throw new ForbiddenException('No workspace in path');

    // Один запрос: членство + сам workspace (для проверки soft-delete).
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: user.sub } },
      include: { workspace: { select: { deletedAt: true } } },
    });
    if (!membership) throw new ForbiddenException('Not a member of this workspace');

    // Soft-deleted workspace недоступен на чтение/запись по вложенным URL (R1).
    if (membership.workspace.deletedAt) throw new ForbiddenException('Workspace is deleted');

    req.workspace = { workspaceId: wsId, userId: user.sub, role: membership.role };
    return true;
  }
}
