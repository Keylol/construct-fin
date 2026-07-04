import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ReceivablesService } from './receivables.service';

/**
 * Юнит-тесты дебиторки. PrismaService мокается. Дата «сегодня» прокидывается
 * параметром, чтобы тесты были детерминированными. Проверяем: долг = total−paid,
 * корректная aging-корзина по возрасту заказа, итоги по корзинам и клиентам.
 */

const ASOF = new Date('2026-06-14T12:00:00.000Z');

function order(over: {
  id: string;
  number?: string;
  clientId?: string | null;
  clientName?: string;
  createdAt: string;
  total: string;
  paid: string;
  /** F2: строки графика платежей (id/seq/dueDate/amount/note). */
  schedule?: { id: string; seq: number; dueDate: Date; amount: Prisma.Decimal; note: string | null }[];
  /** DE1: возвращённые единицы позиций (для чистой выручки). */
  items?: { returnedQty: string; unitPrice: string }[];
}) {
  return {
    id: over.id,
    number: over.number ?? `ORD-${over.id}`,
    clientId: over.clientId ?? null,
    createdAt: new Date(over.createdAt),
    totalAmount: new Prisma.Decimal(over.total),
    paidAmount: new Prisma.Decimal(over.paid),
    client: over.clientName ? { name: over.clientName } : null,
    // DE1: netRevenue = total − Σ(returnedQty·unitPrice); по умолчанию нет возвратов.
    items: (over.items ?? []).map((it) => ({
      returnedQty: new Prisma.Decimal(it.returnedQty),
      unitPrice: new Prisma.Decimal(it.unitPrice),
    })),
    schedule: over.schedule ?? [],
  };
}

function buildService(orders: ReturnType<typeof order>[]) {
  const prisma = {
    order: { findMany: vi.fn().mockResolvedValue(orders) },
  };
  return { service: new ReceivablesService(prisma as never), prisma };
}

describe('ReceivablesService.build', () => {
  it('долг по заказу = total − paid', async () => {
    const { service } = buildService([
      order({ id: '1', clientId: 'c1', clientName: 'Клиент', createdAt: '2026-06-10', total: '1000', paid: '300' }),
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.totalDue).toBe('700.00');
    expect(r.clients[0]!.orders[0]!.due).toBe('700.00');
  });

  it('заказ возрастом <30 дней попадает в корзину 0-30', async () => {
    const { service } = buildService([
      order({ id: '1', createdAt: '2026-06-01', total: '1000', paid: '0' }), // 13 дней
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.clients[0]!.orders[0]!.bucket).toBe('0-30');
    expect(r.buckets['0-30']).toBe('1000.00');
    expect(r.buckets['30-60']).toBe('0.00');
  });

  it('заказ ровно 30 дней попадает в корзину 30-60 (граница вверх)', async () => {
    const { service } = buildService([
      order({ id: '1', createdAt: '2026-05-15', total: '1000', paid: '0' }), // ровно 30 дней
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.clients[0]!.orders[0]!.ageDays).toBe(30);
    expect(r.clients[0]!.orders[0]!.bucket).toBe('30-60');
    expect(r.buckets['30-60']).toBe('1000.00');
  });

  it('заказ возрастом 60+ дней попадает в корзину 60+', async () => {
    const { service } = buildService([
      order({ id: '1', createdAt: '2026-03-01', total: '500', paid: '0' }), // ~105 дней
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.clients[0]!.orders[0]!.bucket).toBe('60+');
    expect(r.buckets['60+']).toBe('500.00');
  });

  it('группирует по клиенту, суммирует корзины и долг', async () => {
    const { service } = buildService([
      order({ id: '1', clientId: 'c1', clientName: 'A', createdAt: '2026-06-01', total: '1000', paid: '0' }),
      order({ id: '2', clientId: 'c1', clientName: 'A', createdAt: '2026-03-01', total: '300', paid: '100' }),
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.clients).toHaveLength(1);
    const c = r.clients[0]!;
    expect(c.clientId).toBe('c1');
    expect(c.due).toBe('1200.00'); // 1000 + 200
    expect(c.buckets['0-30']).toBe('1000.00');
    expect(c.buckets['60+']).toBe('200.00');
    expect(r.totalDue).toBe('1200.00');
  });

  it('заказ без долга (due<=0) исключается', async () => {
    const { service } = buildService([
      order({ id: '1', createdAt: '2026-06-01', total: '1000', paid: '1000' }),
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.totalDue).toBe('0.00');
    expect(r.clients).toHaveLength(0);
  });

  it('заказ без клиента → «Без клиента» (clientId=null)', async () => {
    const { service } = buildService([
      order({ id: '1', clientId: null, createdAt: '2026-06-01', total: '500', paid: '0' }),
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.clients[0]!.clientId).toBeNull();
    expect(r.clients[0]!.clientName).toBe('Без клиента');
  });

  it('фильтрует UNPAID/PARTIAL воркспейса (where в Prisma)', async () => {
    const { service, prisma } = buildService([]);
    await service.build('wsX', ASOF);
    const arg = prisma.order.findMany.mock.calls[0]![0];
    expect(arg.where.workspaceId).toBe('wsX');
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.paymentStatus).toEqual({ in: ['UNPAID', 'PARTIAL'] });
  });

  it('F2: просрочка по графику — на заказ, клиента и общий итог; без графика null', async () => {
    const { service } = buildService([
      order({
        id: '1',
        clientId: 'c1',
        clientName: 'Клиент',
        createdAt: '2026-06-10',
        total: '1000',
        paid: '100',
        schedule: [
          // Просрочен к ASOF (2026-06-14): покрыт 100 из 300 → просрочено 200.
          { id: 's1', seq: 1, dueDate: new Date('2026-06-12T00:00:00.000Z'), amount: new Prisma.Decimal('300'), note: null },
          { id: 's2', seq: 2, dueDate: new Date('2026-07-20T00:00:00.000Z'), amount: new Prisma.Decimal('700'), note: null },
        ],
      }),
      order({ id: '2', clientId: 'c1', clientName: 'Клиент', createdAt: '2026-06-10', total: '500', paid: '0' }),
    ]);
    const r = await service.build('ws1', ASOF);
    expect(r.overdueByPlanTotal).toBe('200.00');
    expect(r.clients[0]!.overdueByPlan).toBe('200.00');
    const withPlan = r.clients[0]!.orders.find((o) => o.orderId === '1')!;
    expect(withPlan.overdueByPlan).toBe('200.00');
    expect(withPlan.nextDueDate).toBe('2026-06-12T00:00:00.000Z');
    expect(r.clients[0]!.orders.find((o) => o.orderId === '2')!.overdueByPlan).toBeNull();
  });
});
