import { describe, expect, it, vi } from 'vitest';
import { AuditService } from './audit.service';

/**
 * Юнит-тесты AuditService.record — поведение при ошибке зависит от контекста:
 *  - автономно (PrismaService): ошибку глотаем, домен не падает;
 *  - внутри интерактивной tx (передан TxClient): пробрасываем — tx уже aborted,
 *    глотание лишь маскирует причину отката («current transaction is aborted»).
 */

const ENTRY = {
  workspaceId: 'ws1',
  actorId: 'u1',
  action: 'order.finalize' as const,
  entityType: 'Order',
  entityId: 'o1',
};

function buildService(prismaCreate: ReturnType<typeof vi.fn>) {
  const prisma = { auditLog: { create: prismaCreate } };
  return { service: new AuditService(prisma as never), prisma };
}

describe('AuditService.record', () => {
  it('happy path: создаёт запись', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'a1' });
    const { service } = buildService(create);
    await service.record(undefined, ENTRY);
    expect(create).toHaveBeenCalledOnce();
  });

  it('автономно (без tx): ошибка ГЛОТАЕТСЯ — домен не падает', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const { service } = buildService(create);
    // Не бросает.
    await expect(service.record(undefined, ENTRY)).resolves.toBeUndefined();
  });

  it('внутри tx: ошибка ПРОБРАСЫВАЕТСЯ (tx уже aborted)', async () => {
    // Автономный prisma — ОК; tx-клиент — падает на create.
    const okCreate = vi.fn().mockResolvedValue({ id: 'a1' });
    const { service } = buildService(okCreate);
    const txClient = {
      auditLog: { create: vi.fn().mockRejectedValue(new Error('constraint')) },
    };
    await expect(service.record(txClient as never, ENTRY)).rejects.toThrow(/constraint/);
  });
});
