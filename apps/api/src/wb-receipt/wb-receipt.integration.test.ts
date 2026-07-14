/**
 * Интеграционные тесты разбора чека WB (Ф6): деньги ровно один раз
 * (create/link), склад FIFO, позиции заказов, идемпотентность по ФПД,
 * полный откат. Реальная БД construct_v6_test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  buildHarness,
  resetDb,
  seedBase,
  seedStockItem,
  type Harness,
  type Seed,
} from '../test/money-harness';
import type { CommitWbReceiptDto } from './wb-receipt.dto';

let h: Harness;
let seed: Seed;
let tg = 900000n;

beforeAll(() => {
  h = buildHarness();
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

/** Заказ «Сборка ПК» 50 000 без клиента (внескладская позиция). */
async function seedOrder(): Promise<{ id: string }> {
  const order = await h.orders.create(seed.workspaceId, {
    items: [{ name: 'Сборка ПК', qty: '1', unitPrice: '50000.00' }],
  } as Parameters<typeof h.orders.create>[1]);
  return { id: order.id };
}

/** Смешанный чек: склад-существующий (3×590) + склад-новый (7018) + заказ (18438). */
function dto(over: Partial<CommitWbReceiptDto> & { itemId?: string; orderId?: string } = {}) {
  const { itemId, orderId, ...rest } = over;
  const base: CommitWbReceiptDto = {
    accountId: seed.accountId,
    money: { mode: 'create', categoryId: null },
    fpd: 'FPD-1',
    fd: '16669',
    checkNumber: '1471',
    receiptDate: '2026-05-21T03:25:00.000Z',
    totalAmount: '27226.00',
    note: null,
    lines: [
      {
        name: 'Вентилятор 120мм',
        qty: '3',
        unitPrice: '590.00',
        target: 'WAREHOUSE',
        warehouseItemId: itemId ?? '',
        sellerInn: '1111111111',
        sellerName: 'ООО "ПРОДАВЕЦ ОДИН"',
        wbOrderHash: 'aaaa',
      },
      {
        name: 'Блок питания 850W',
        qty: '1',
        unitPrice: '7018.00',
        target: 'WAREHOUSE',
        newItem: { name: 'БП 850W', unit: 'шт' },
      },
      {
        name: 'Процессор Core X',
        qty: '1',
        unitPrice: '18438.00',
        target: 'ORDER',
        orderId: orderId ?? '',
        wbOrderHash: 'bbbb',
      },
    ],
  };
  return { ...base, ...rest };
}

describe('WbReceipt commit (create-mode)', () => {
  it('смешанный чек: одна транзакция, FIFO-партии, позиция заказа, контрагент WB', async () => {
    const item = await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      name: 'Вентилятор 120мм',
      qty: '0',
      unitCost: '0',
    });
    const order = await seedOrder();

    const res = await h.wbReceipts.commit(
      seed.workspaceId,
      seed.userId,
      dto({ itemId: item.id, orderId: order.id }),
    );

    // Деньги: ровно одна транзакция на весь чек.
    expect(res.transactionCreated).toBe(true);
    expect(res.transaction?.amount.toFixed(2)).toBe('27226.00');
    const txs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, deletedAt: null, kind: 'OTHER' },
      include: { counterparty: true },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('EXPENSE');
    expect(txs[0]?.counterparty?.name).toBe('Wildberries');
    expect(txs[0]?.date.toISOString()).toBe('2026-05-21T03:25:00.000Z');

    // Склад: существующий товар оприходован партией с трассой на строку чека.
    const fanItem = await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fanItem.qty.toFixed(3)).toBe('3.000');
    expect(fanItem.avgCost.toFixed(2)).toBe('590.00');
    const fanLots = await h.prisma.stockLot.findMany({
      where: { warehouseItemId: item.id, deletedAt: null },
    });
    expect(fanLots).toHaveLength(1);
    expect(fanLots[0]?.sourceType).toBe('PURCHASE');
    expect(fanLots[0]?.unitCost.toFixed(2)).toBe('590.00');
    expect(fanLots[0]?.receivedAt.toISOString()).toBe('2026-05-21T03:25:00.000Z');

    // Новый товар создан и оприходован.
    const newItem = await h.prisma.warehouseItem.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, name: 'БП 850W' },
    });
    expect(newItem.qty.toFixed(3)).toBe('1.000');
    expect(newItem.avgCost.toFixed(2)).toBe('7018.00');

    // Заказ: позиция добавлена, суммы выросли, себестоимость = цене чека.
    const orderRow = await h.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { where: { deletedAt: null } } },
    });
    expect(orderRow.items).toHaveLength(2);
    const cpu = orderRow.items.find((i) => i.name === 'Процессор Core X');
    expect(cpu?.unitCost?.toFixed(2)).toBe('18438.00');
    expect(cpu?.unitPrice.toFixed(2)).toBe('18438.00'); // salePrice не задан → цена чека
    expect(cpu?.warehouseItemId).toBeNull();
    expect(orderRow.subtotal.toFixed(2)).toBe('68438.00');
    expect(orderRow.totalAmount.toFixed(2)).toBe('68438.00');

    // Строки чека: трасса orderItemId у заказной, лот ссылается на складскую.
    expect(res.lines).toHaveLength(3);
    const orderLine = res.lines.find((l) => l.target === 'ORDER');
    expect(orderLine?.orderItemId).toBe(cpu?.id);
    const fanLine = res.lines.find((l) => l.warehouseItemId === item.id);
    expect(fanLots[0]?.sourceId).toBe(fanLine?.id);
  });

  it('salePrice: продажная цена позиции ≠ себестоимости из чека', async () => {
    const order = await seedOrder();
    const res = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      totalAmount: '18438.00',
      lines: [
        {
          name: 'Процессор Core X',
          qty: '1',
          unitPrice: '18438.00',
          target: 'ORDER',
          orderId: order.id,
          salePrice: '25000.00',
        },
      ],
    });
    expect(res.lines).toHaveLength(1);
    const orderRow = await h.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { where: { deletedAt: null } } },
    });
    const cpu = orderRow.items.find((i) => i.name === 'Процессор Core X');
    expect(cpu?.unitPrice.toFixed(2)).toBe('25000.00');
    expect(cpu?.unitCost?.toFixed(2)).toBe('18438.00');
    expect(orderRow.totalAmount.toFixed(2)).toBe('75000.00');
  });

  it('заказ со 100% скидкой: добавление позиции из чека не роняет total в минус', async () => {
    // Инвариант discount ≤ subtotal держат create/update; addExternalItems
    // только растит subtotal — total монотонно неотрицателен. Фиксируем.
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Промо-сборка', qty: '1', unitPrice: '1000.00' }],
      discountAmount: '1000.00',
    } as Parameters<typeof h.orders.create>[1]);
    await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });
    const row = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.subtotal.toFixed(2)).toBe('19438.00');
    expect(row.totalAmount.toFixed(2)).toBe('18438.00'); // ≥ 0 всегда
  });

  it('Σ строк ≠ итогу чека → 400 (ловит потерянные парсером позиции)', async () => {
    const order = await seedOrder();
    await expect(
      h.wbReceipts.commit(seed.workspaceId, seed.userId, {
        ...dto({ orderId: order.id }),
        totalAmount: '99999.00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('повторный разбор того же ФПД → 409; после отката — проходит', async () => {
    const order = await seedOrder();
    const first = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });
    await expect(
      h.wbReceipts.commit(seed.workspaceId, seed.userId, {
        ...dto({ orderId: order.id }),
        totalAmount: '18438.00',
        lines: [
          { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await h.wbReceipts.revert(seed.workspaceId, first.id, seed.userId);
    const again = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });
    expect(again.id).not.toBe(first.id);
  });
});

describe('WbReceipt commit (link-mode)', () => {
  async function seedCardExpense(amount: string, kind: 'OTHER' | 'ORDER_PAYMENT' = 'OTHER') {
    return h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date('2026-05-20T00:00:00.000Z'),
        amount,
        type: 'EXPENSE',
        kind,
        createdById: seed.userId,
      },
      select: { id: true },
    });
  }

  it('привязка существующей операции: новых денег не создаётся', async () => {
    const t = await seedCardExpense('18438.00');
    const order = await seedOrder();
    const res = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      money: { mode: 'link', transactionId: t.id },
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });
    expect(res.transactionCreated).toBe(false);
    expect(res.transaction?.id).toBe(t.id);
    const count = await h.prisma.transaction.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(count).toBe(1); // только исходная операция
  });

  it('сумма операции ≠ итогу чека → 400; чужой kind → 400; занятая операция → 409', async () => {
    const order = await seedOrder();
    const lines: CommitWbReceiptDto['lines'] = [
      { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
    ];

    const wrongAmount = await seedCardExpense('100.00');
    await expect(
      h.wbReceipts.commit(seed.workspaceId, seed.userId, {
        ...dto(),
        money: { mode: 'link', transactionId: wrongAmount.id },
        totalAmount: '18438.00',
        lines,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const sysKind = await seedCardExpense('18438.00', 'ORDER_PAYMENT');
    await expect(
      h.wbReceipts.commit(seed.workspaceId, seed.userId, {
        ...dto(),
        money: { mode: 'link', transactionId: sysKind.id },
        totalAmount: '18438.00',
        lines,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const good = await seedCardExpense('18438.00');
    await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto(),
      money: { mode: 'link', transactionId: good.id },
      totalAmount: '18438.00',
      lines,
    });
    await expect(
      h.wbReceipts.commit(seed.workspaceId, seed.userId, {
        ...dto(),
        fpd: 'FPD-2',
        money: { mode: 'link', transactionId: good.id },
        totalAmount: '18438.00',
        lines,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('WbReceipt revert', () => {
  it('create-mode: партии сняты, позиция заказа убрана, расход soft-удалён', async () => {
    const item = await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      name: 'Вентилятор 120мм',
      qty: '0',
      unitCost: '0',
    });
    const order = await seedOrder();
    const receipt = await h.wbReceipts.commit(
      seed.workspaceId,
      seed.userId,
      dto({ itemId: item.id, orderId: order.id }),
    );

    const res = await h.wbReceipts.revert(seed.workspaceId, receipt.id, seed.userId);
    expect(res.reverted).toBe(3);

    // Склад вернулся к нулю, партии soft-deleted.
    const fanItem = await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fanItem.qty.toFixed(3)).toBe('0.000');
    expect(
      await h.prisma.stockLot.count({ where: { warehouseItemId: item.id, deletedAt: null } }),
    ).toBe(0);

    // Заказ вернулся к исходному составу и суммам.
    const orderRow = await h.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { where: { deletedAt: null } } },
    });
    expect(orderRow.items).toHaveLength(1);
    expect(orderRow.totalAmount.toFixed(2)).toBe('50000.00');

    // Созданный расход soft-удалён, чек закрыт и отвязан.
    expect(
      await h.prisma.transaction.count({
        where: { workspaceId: seed.workspaceId, deletedAt: null },
      }),
    ).toBe(0);
    const closed = await h.prisma.wbReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(closed.deletedAt).not.toBeNull();
    expect(closed.transactionId).toBeNull();
  });

  it('link-mode: операция выживает и освобождается для новой привязки', async () => {
    const t = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date('2026-05-20T00:00:00.000Z'),
        amount: '18438.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        createdById: seed.userId,
      },
      select: { id: true },
    });
    const order = await seedOrder();
    const lines: CommitWbReceiptDto['lines'] = [
      { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
    ];
    const receipt = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto(),
      money: { mode: 'link', transactionId: t.id },
      totalAmount: '18438.00',
      lines,
    });

    await h.wbReceipts.revert(seed.workspaceId, receipt.id, seed.userId);

    const alive = await h.prisma.transaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(alive.deletedAt).toBeNull();

    // Операция свободна — второй чек может привязаться к ней.
    await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto(),
      fpd: 'FPD-2',
      money: { mode: 'link', transactionId: t.id },
      totalAmount: '18438.00',
      lines,
    });
  });

  it('позиция заказа уже отгружена → 400, откат целиком отменён', async () => {
    const order = await seedOrder();
    const receipt = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });
    const line = receipt.lines[0];
    await h.prisma.orderItem.update({
      where: { id: line?.orderItemId ?? '' },
      data: { shippedQty: '1' },
    });

    await expect(
      h.wbReceipts.revert(seed.workspaceId, receipt.id, seed.userId),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Атомарность: чек жив, расход не удалён.
    const still = await h.prisma.wbReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(still.deletedAt).toBeNull();
    expect(
      await h.prisma.transaction.count({
        where: { workspaceId: seed.workspaceId, deletedAt: null },
      }),
    ).toBe(1);
  });
});

describe('Import preview: «уже учтено чеком» (анти-задвоение)', () => {
  it('строка выписки с суммой/датой расхода, созданного чеком → receiptMatch', async () => {
    const order = await seedOrder();
    const receipt = await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto({ orderId: order.id }),
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });

    // Выписка карты: списание на день позже даты чека + посторонняя строка.
    const csv = Buffer.from(
      'date,amount,type,description\n' +
        '2026-05-22,18438.00,расход,Оплата на Wildberries\n' +
        '2026-06-15,500.00,расход,кофе\n',
      'utf-8',
    );
    const preview = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: csv,
      filename: 'card.csv',
      mapping: { date: 'date', amount: 'amount', type: 'type', description: 'description' },
    });

    const wbRow = preview.rows.find((r) => r.amount === '18438.00');
    expect(wbRow?.receiptMatch?.receiptId).toBe(receipt.id);
    expect(wbRow?.receiptMatch?.transactionId).toBe(receipt.transaction?.id);
    const coffee = preview.rows.find((r) => r.amount === '500.00');
    expect(coffee?.receiptMatch).toBeNull();
  });

  it('привязанная (не созданная) чеком операция строку не метит', async () => {
    const t = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date('2026-05-21T00:00:00.000Z'),
        amount: '18438.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        createdById: seed.userId,
      },
      select: { id: true },
    });
    const order = await seedOrder();
    await h.wbReceipts.commit(seed.workspaceId, seed.userId, {
      ...dto(),
      money: { mode: 'link', transactionId: t.id },
      totalAmount: '18438.00',
      lines: [
        { name: 'Процессор', qty: '1', unitPrice: '18438.00', target: 'ORDER', orderId: order.id },
      ],
    });

    const csv = Buffer.from(
      'date,amount,type\n2026-05-21,18438.00,расход\n',
      'utf-8',
    );
    const preview = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: csv,
      filename: 'card.csv',
      mapping: { date: 'date', amount: 'amount', type: 'type' },
    });
    // Источник этой операции — сама выписка (link), метить нечего; строка
    // поймается обычным dup-детектом при совпадении importHash, не чеком.
    expect(preview.rows[0]?.receiptMatch).toBeNull();
  });
});
