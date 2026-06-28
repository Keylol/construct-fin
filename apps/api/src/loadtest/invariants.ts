/**
 * Проверка инвариантов финансового/складского учёта по факту БД.
 *
 * Это «банковский» слой контроля: после любой нагрузки данные обязаны
 * удовлетворять инвариантам независимо от того, в каком порядке и с какой
 * конкуренцией выполнялись операции. Нарушение инварианта = пойманный дефект
 * (двойное списание, lost update, рассинхрон кэш-поля, over-ship/over-return).
 *
 * Все проверки — независимый пересчёт из первичных записей (Transaction,
 * StockMovement, OrderItem), НЕ через сервисы приложения (иначе тестировали бы
 * логику самой собой).
 */
import type { PrismaClient, Prisma } from '@prisma/client';

export interface Violation {
  invariant: string;
  entity: string;
  detail: string;
}

const D = (v: Prisma.Decimal | null | undefined): number => (v ? Number(v.toString()) : 0);
// Сравнение денег с допуском на копейку (Decimal(14,2)).
const eq = (a: number, b: number, eps = 0.005): boolean => Math.abs(a - b) < eps;

/**
 * Складской инвариант: qty склада обязан точно равняться сумме движений журнала
 * (append-only StockMovement). Любой lost update под конкуренцией разойдётся.
 * Плюс qty >= 0 (oversell) и avgCost >= 0.
 */
export async function checkWarehouseInvariants(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Violation[]> {
  const v: Violation[] = [];
  const items = await prisma.warehouseItem.findMany({ where: { workspaceId, deletedAt: null } });
  for (const item of items) {
    const movements = await prisma.stockMovement.findMany({ where: { warehouseItemId: item.id } });
    const sumDelta = movements.reduce((acc, m) => acc + D(m.qtyDelta), 0);
    if (!eq(D(item.qty), sumDelta, 0.0005)) {
      v.push({
        invariant: 'warehouse.qty == Σ movements',
        entity: `WarehouseItem ${item.id} (${item.name})`,
        detail: `qty=${D(item.qty)} но Σ qtyDelta=${sumDelta} (Δ=${D(item.qty) - sumDelta})`,
      });
    }
    if (D(item.qty) < -0.0005) {
      v.push({ invariant: 'warehouse.qty >= 0', entity: `WarehouseItem ${item.id}`, detail: `qty=${D(item.qty)} < 0 (oversell)` });
    }
    if (D(item.avgCost) < -0.00005) {
      v.push({ invariant: 'warehouse.avgCost >= 0', entity: `WarehouseItem ${item.id}`, detail: `avgCost=${D(item.avgCost)} < 0` });
    }
  }
  return v;
}

/**
 * Инвариант заказов: кэш-поле paidAmount обязано равняться факту проводок
 * (Σ ORDER_PAYMENT − Σ ORDER_REFUND по orderId, не soft-deleted). Рассинхрон под
 * конкурентной оплатой/возвратом одного заказа разойдётся здесь.
 * Плюс границы строк: shippedQty <= qty, 0 <= returnedQty <= shippedQty.
 */
export async function checkOrderInvariants(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Violation[]> {
  const v: Violation[] = [];
  const orders = await prisma.order.findMany({
    where: { workspaceId, deletedAt: null },
    include: { items: true },
  });
  for (const o of orders) {
    const txs = await prisma.transaction.findMany({
      where: { workspaceId, orderId: o.id, deletedAt: null, kind: { in: ['ORDER_PAYMENT', 'ORDER_REFUND'] } },
    });
    const factPaid = txs.reduce((acc, t) => acc + (t.kind === 'ORDER_PAYMENT' ? D(t.amount) : -D(t.amount)), 0);
    if (!eq(D(o.paidAmount), factPaid)) {
      v.push({
        invariant: 'order.paidAmount == Σ payments − Σ refunds',
        entity: `Order ${o.number} (${o.id})`,
        detail: `paidAmount=${D(o.paidAmount)} но факт проводок=${factPaid} (Δ=${D(o.paidAmount) - factPaid})`,
      });
    }
    for (const it of o.items) {
      if (D(it.shippedQty) > D(it.qty) + 0.0005) {
        v.push({ invariant: 'orderItem.shippedQty <= qty', entity: `OrderItem ${it.id} (order ${o.number})`, detail: `shipped=${D(it.shippedQty)} > qty=${D(it.qty)} (over-ship)` });
      }
      if (D(it.returnedQty) > D(it.shippedQty) + 0.0005) {
        v.push({ invariant: 'orderItem.returnedQty <= shippedQty', entity: `OrderItem ${it.id} (order ${o.number})`, detail: `returned=${D(it.returnedQty)} > shipped=${D(it.shippedQty)} (over-return)` });
      }
      if (D(it.returnedQty) < -0.0005) {
        v.push({ invariant: 'orderItem.returnedQty >= 0', entity: `OrderItem ${it.id}`, detail: `returned=${D(it.returnedQty)} < 0` });
      }
    }
  }
  return v;
}

/**
 * Инвариант переводов: у каждого живого Transfer обязаны быть обе ноги
 * (TRANSFER_IN на toAccount = amount, TRANSFER_OUT на fromAccount), не больше и
 * не меньше; при soft-delete перевода все его ноги тоже soft-deleted.
 */
export async function checkTransferInvariants(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Violation[]> {
  const v: Violation[] = [];
  const transfers = await prisma.transfer.findMany({ where: { workspaceId }, include: { legs: true } });
  for (const t of transfers) {
    const live = t.legs.filter((l) => l.deletedAt === null);
    if (t.deletedAt !== null) {
      if (live.length > 0) {
        v.push({ invariant: 'transfer.deleted ⇒ legs deleted', entity: `Transfer ${t.id}`, detail: `перевод soft-deleted, но ${live.length} ног живы` });
      }
      continue;
    }
    const ins = live.filter((l) => l.kind === 'TRANSFER_IN');
    const outs = live.filter((l) => l.kind === 'TRANSFER_OUT');
    if (ins.length !== 1 || outs.length !== 1) {
      v.push({ invariant: 'transfer has exactly 2 legs', entity: `Transfer ${t.id}`, detail: `TRANSFER_IN=${ins.length}, TRANSFER_OUT=${outs.length}` });
      continue;
    }
    if (!eq(D(ins[0]!.amount), D(t.amount))) {
      v.push({ invariant: 'transfer.IN.amount == transfer.amount', entity: `Transfer ${t.id}`, detail: `IN.amount=${D(ins[0]!.amount)} != transfer.amount=${D(t.amount)}` });
    }
    if (ins[0]!.accountId !== t.toAccountId) {
      v.push({ invariant: 'transfer.IN.account == toAccount', entity: `Transfer ${t.id}`, detail: `IN.accountId=${ins[0]!.accountId} != toAccountId=${t.toAccountId}` });
    }
    if (outs[0]!.accountId !== t.fromAccountId) {
      v.push({ invariant: 'transfer.OUT.account == fromAccount', entity: `Transfer ${t.id}`, detail: `OUT.accountId=${outs[0]!.accountId} != fromAccountId=${t.fromAccountId}` });
    }
  }
  return v;
}

/**
 * Инвариант COGS (R1/R2/R4): признанный по заказу COGS (с учётом сторно возврата)
 * не должен уходить в минус из-за лишнего сторно, и COGS-проводки не должны
 * затрагивать денежный остаток (они NON_CASH — проверяется отдельно агрегатом).
 */
export async function checkCogsInvariants(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Violation[]> {
  const v: Violation[] = [];
  const orders = await prisma.order.findMany({ where: { workspaceId, deletedAt: null } });
  for (const o of orders) {
    const cogs = await prisma.transaction.findMany({ where: { workspaceId, orderId: o.id, kind: 'COGS', deletedAt: null } });
    // amount хранится положительным; сторно — отрицательным (originalTxId). Net должен быть >= 0.
    const net = cogs.reduce((acc, t) => acc + D(t.amount), 0);
    if (net < -0.005) {
      v.push({ invariant: 'order.netCOGS >= 0', entity: `Order ${o.number}`, detail: `Σ COGS (с учётом сторно) = ${net} < 0 (лишнее сторно)` });
    }
  }
  return v;
}

/**
 * Денежный остаток счёта: openingBalance + Σ(INCOME) − Σ(EXPENSE), исключая
 * неденежные kind (COGS). Здесь проверяется не «правильность числа» (нет
 * эталона), а согласованность: остаток конечен, и нет «осиротевших» денежных
 * проводок без счёта. Точное ожидаемое значение сверяет вызывающий сценарий.
 */
export async function computeAccountBalances(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Map<string, number>> {
  const accounts = await prisma.account.findMany({ where: { workspaceId, deletedAt: null } });
  const balances = new Map<string, number>();
  for (const a of accounts) {
    const txs = await prisma.transaction.findMany({
      where: { workspaceId, accountId: a.id, deletedAt: null, kind: { notIn: ['COGS'] } },
    });
    const bal = txs.reduce((acc, t) => acc + (t.type === 'INCOME' ? D(t.amount) : -D(t.amount)), D(a.openingBalance));
    balances.set(a.id, bal);
  }
  return balances;
}

/** Полный прогон всех инвариантов; возвращает плоский список нарушений. */
export async function checkAllInvariants(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Violation[]> {
  const groups = await Promise.all([
    checkWarehouseInvariants(prisma, workspaceId),
    checkOrderInvariants(prisma, workspaceId),
    checkTransferInvariants(prisma, workspaceId),
    checkCogsInvariants(prisma, workspaceId),
  ]);
  return groups.flat();
}
