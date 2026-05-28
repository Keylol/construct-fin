import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TxClient } from '../common/unit-of-work';

/**
 * Доменные действия, фиксируемые в AuditLog. Имена — kebab-case "entity.action".
 * Расширяй список по мере появления новых критичных операций.
 */
export type AuditAction =
  | 'order.finalize'
  | 'order.cancel'
  | 'order.reopen'
  | 'order.delete'
  | 'order.refund'
  | 'period.close'
  | 'period.reopen'
  | 'purchase.register'
  | 'warehouse.supplier-return'
  | 'transaction.delete';

export interface AuditEntry {
  workspaceId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  diff?: Prisma.InputJsonValue;
}

type AuditClient = PrismaService | TxClient;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Записать аудит-событие. Принимает PrismaService ИЛИ TxClient — для UoW.
   * Не бросает: ошибки аудита не должны разваливать основную операцию,
   * но логируются.
   */
  async record(client: AuditClient | undefined, entry: AuditEntry): Promise<void> {
    const c = client ?? this.prisma;
    try {
      await c.auditLog.create({
        data: {
          workspaceId: entry.workspaceId,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          diff: (entry.diff ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Не пробрасываем — аудит не должен ломать домен.
      console.error('[audit] failed to record', entry.action, err);
    }
  }

  /** Список последних событий workspace. */
  async list(workspaceId: string, limit = 100, cursor?: string) {
    const items = await this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        actor: { select: { id: true, firstName: true, lastName: true, username: true } },
      },
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        diff: row.diff,
        createdAt: row.createdAt.toISOString(),
        actor: row.actor
          ? {
              id: row.actor.id,
              name:
                [row.actor.firstName, row.actor.lastName].filter(Boolean).join(' ') ||
                row.actor.username ||
                row.actor.id,
            }
          : null,
      })),
      nextCursor: hasMore && last ? last.id : null,
    };
  }
}
