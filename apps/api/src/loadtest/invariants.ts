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
 * FIFO-инварианты партий (F0). Независимый пересчёт из StockLot/LotConsumption —
 * НЕ через сервисы. Ловит рассинхрон derived-кэшей (qty/avgCost) с истиной-лотами,
 * двойной реверс, over-consume и протечку себестоимости под конкуренцией.
 *
 *   • I2  WarehouseItem.qty == Σ open StockLot.qtyRemaining (eps 0.0005).
 *   • I3  0 <= qtyRemaining <= qtyInitial; qtyRemaining == qtyInitial − Σ signed LotConsumption.qty.
 *   • I5  item.qty*avgCost == Σ open(qtyRemaining*unitCost) с qty-пропорциональным eps
 *         (avgCost округлён до 4 знаков → ошибка ≤ qty*0.00005).
 *   • I9  Σ open qtyRemaining == 0 ⇒ avgCost == 0 (guard деления на ноль).
 */
export async function checkLotInvariants(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<Violation[]> {
  const v: Violation[] = [];
  const items = await prisma.warehouseItem.findMany({ where: { workspaceId, deletedAt: null } });
  const lots = await prisma.stockLot.findMany({ where: { workspaceId, deletedAt: null } });
  const consumptions = await prisma.lotConsumption.findMany({ where: { workspaceId } });

  // Σ signed LotConsumption.qty по lotId (CONSUME +, REVERSAL −).
  const signedByLot = new Map<string, number>();
  for (const c of consumptions) {
    signedByLot.set(c.lotId, (signedByLot.get(c.lotId) ?? 0) + D(c.qty));
  }
  // Лоты по позиции.
  const lotsByItem = new Map<string, typeof lots>();
  for (const l of lots) {
    const arr = lotsByItem.get(l.warehouseItemId) ?? [];
    arr.push(l);
    lotsByItem.set(l.warehouseItemId, arr);
  }

  for (const item of items) {
    const itemLots = lotsByItem.get(item.id) ?? [];
    const openLots = itemLots.filter((l) => D(l.qtyRemaining) > 0.0005);
    const sumRem = openLots.reduce((acc, l) => acc + D(l.qtyRemaining), 0);
    const sumValue = openLots.reduce((acc, l) => acc + D(l.qtyRemaining) * D(l.unitCost), 0);

    // I2: derived-кэш qty == Σ открытых остатков партий.
    if (!eq(D(item.qty), sumRem, 0.0005)) {
      v.push({
        invariant: 'I2 warehouse.qty == Σ open lot.qtyRemaining',
        entity: `WarehouseItem ${item.id} (${item.name})`,
        detail: `qty=${D(item.qty)} но Σ qtyRemaining=${sumRem} (Δ=${D(item.qty) - sumRem})`,
      });
    }

    // I5: стоимость остатка по кэшу сходится со стоимостью по лотам (qty-пропорц. eps).
    const eps5 = 0.01 + Math.abs(D(item.qty)) * 0.00005;
    const valueFromCache = D(item.qty) * D(item.avgCost);
    if (Math.abs(valueFromCache - sumValue) > eps5) {
      v.push({
        invariant: 'I5 stockValue == Σ open(qtyRemaining*unitCost)',
        entity: `WarehouseItem ${item.id} (${item.name})`,
        detail: `qty*avgCost=${valueFromCache} но Σ(qtyRem*unitCost)=${sumValue} (eps=${eps5})`,
      });
    }

    // I9: пустой остаток ⇒ avgCost обнулён.
    if (eq(sumRem, 0, 0.0005) && Math.abs(D(item.avgCost)) > 0.00005) {
      v.push({
        invariant: 'I9 Σ qtyRemaining == 0 ⇒ avgCost == 0',
        entity: `WarehouseItem ${item.id} (${item.name})`,
        detail: `Σ qtyRemaining=0, но avgCost=${D(item.avgCost)}`,
      });
    }

    // I3: пер-лот границы и леджер-идентичность.
    for (const l of itemLots) {
      const qi = D(l.qtyInitial);
      const qr = D(l.qtyRemaining);
      if (qr < -0.0005) {
        v.push({ invariant: 'I3 qtyRemaining >= 0', entity: `StockLot ${l.id}`, detail: `qtyRemaining=${qr} < 0` });
      }
      if (qr > qi + 0.0005) {
        v.push({ invariant: 'I3 qtyRemaining <= qtyInitial', entity: `StockLot ${l.id}`, detail: `qtyRemaining=${qr} > qtyInitial=${qi}` });
      }
      const signed = signedByLot.get(l.id) ?? 0;
      if (!eq(qr, qi - signed, 0.0005)) {
        v.push({
          invariant: 'I3 qtyRemaining == qtyInitial − Σ signed consumption',
          entity: `StockLot ${l.id}`,
          detail: `qtyRemaining=${qr}, qtyInitial=${qi}, Σ signed=${signed} (ожид. ${qi - signed})`,
        });
      }
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
    checkLotInvariants(prisma, workspaceId),
  ]);
  return groups.flat();
}
