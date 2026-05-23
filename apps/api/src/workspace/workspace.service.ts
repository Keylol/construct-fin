import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateWorkspaceDto, UpdateWorkspaceDto } from './workspace.dto';

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { user: { id: userId }, workspace: { deletedAt: null } },
      include: { workspace: true },
      orderBy: { joinedAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      ownerId: m.workspace.ownerId,
      createdAt: m.workspace.createdAt,
    }));
  }

  async create(userId: string, input: CreateWorkspaceDto) {
    return this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: { name: input.name, ownerId: userId },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: ws.id, userId, role: 'OWNER' },
      });
      return { id: ws.id, name: ws.name, role: 'OWNER' as const, ownerId: ws.ownerId };
    });
  }

  async update(workspaceId: string, input: UpdateWorkspaceDto) {
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
    });
    if (!ws) throw new NotFoundException('Workspace not found');
    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name: input.name ?? undefined },
    });
    return { id: updated.id, name: updated.name };
  }

  async softDelete(workspaceId: string) {
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
    });
    if (!ws) throw new NotFoundException('Workspace not found');
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { deletedAt: new Date() },
    });
  }
}
