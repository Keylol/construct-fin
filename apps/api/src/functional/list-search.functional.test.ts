/**
 * Поиск в списках через HTTP: одни правила на всех экранах (common/text-search.ts).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp) — с ZodPipe, где раньше запрос из
 * одних пробелов отвечал 400. Проверяем то, чего не хватало людям: операцию
 * находят по контрагенту, статье и сумме в любом виде; заказ — по клиенту,
 * телефону с 8, остатку и позиции; закупку — на сервере, а не среди 200 последних.
 *
 * Диапазон telegramId: 2800000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TransactionKind } from '@prisma/client';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2800000n;

beforeAll(async () => {
  H = await buildHttpApp();
});

afterAll(async () => {
  await H.app.close();
});

beforeEach(async () => {
  await resetDb(H.prisma);
  tg += 1n;
  seed = await seedBase(H.prisma, tg);
  await seedMember(H.prisma, seed.workspaceId, seed.userId);
  token = await H.jwtFor(seed.userId, tg);
});

const get = (path: string) =>
  H.inject({ method: 'GET', url: `/workspaces/${seed.workspaceId}${path}`, token });

const q = (value: string) => encodeURIComponent(value);

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

function tx(data: {
  amount: string;
  date: string;
  description?: string;
  counterpartyId?: string;
  categoryId?: string;
  kind?: TransactionKind;
}) {
  return H.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      createdById: seed.userId,
      type: 'EXPENSE',
      kind: data.kind ?? 'OTHER',
      amount: data.amount,
      date: new Date(data.date),
      description: data.description ?? null,
      counterpartyId: data.counterpartyId ?? null,
      categoryId: data.categoryId ?? null,
    },
  });
}

describe('Поиск в списках', () => {
  it('запрос из одних пробелов — 200 и список целиком, а не 400', async () => {
    for (const path of [
      '/transactions?search=%20%20',
      '/counterparties?search=%20',
      '/warehouse?search=%20',
      '/orders?search=%20',
      '/inbox?q=%20',
      '/purchases?search=%20',
    ]) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
    }
  });

  it('операции: по контрагенту, статье и сумме в любом виде', async () => {
    const cp = await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Семёнов' },
    });
    const cat = await H.prisma.category.create({
      data: { workspaceId: seed.workspaceId, name: 'Аренда офиса', kind: 'EXPENSE' },
    });
    const rent = await tx({
      amount: '12500.00',
      date: '2026-08-10T07:00:00.000Z',
      categoryId: cat.id,
      counterpartyId: cp.id,
      description: 'за август',
    });
    await tx({ amount: '999.00', date: '2026-08-11T07:00:00.000Z', description: 'канцелярия' });

    for (const query of ['семенов', 'аренда', '12 500', '12500,00', '12 500 ₽']) {
      const res = await get(`/transactions?search=${q(query)}`);
      expect(res.statusCode, query).toBe(200);
      expect(ids(res.json<{ items: Array<{ id: string }> }>().items), query).toEqual([rent.id]);
    }
  });

  it('операции: «ещё N за другие даты» считает найденное вне периода', async () => {
    await tx({ amount: '500.00', date: '2026-07-05T07:00:00.000Z', description: 'Интернет, июль' });
    const august = await tx({
      amount: '500.00',
      date: '2026-08-05T07:00:00.000Z',
      description: 'Интернет, август',
    });
    const period = `from=${q('2026-08-01T07:00:00.000Z')}&to=${q('2026-08-31T07:00:00.000Z')}`;

    const searched = await get(`/transactions?search=${q('интернет')}&${period}`);
    const body = searched.json<{ items: Array<{ id: string }>; outsideCount: number | null }>();
    expect(ids(body.items)).toEqual([august.id]);
    expect(body.outsideCount).toBe(1);

    // Без поиска подсказке нечего сказать.
    const plain = await get(`/transactions?${period}`);
    expect(plain.json<{ outsideCount: number | null }>().outsideCount).toBeNull();
  });

  it('заказы: по клиенту, телефону с 8, остатку, позиции и номеру', async () => {
    const client = await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Прозоров Илья', role: 'CLIENT' },
    });
    const order = await H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-2026-0042',
        phone: '+79123456789',
        title: 'Сборка ПК',
        clientId: client.id,
        subtotal: '150000.00',
        totalAmount: '150000.00',
        paidAmount: '50000.00',
      },
    });
    await H.prisma.orderItem.create({
      data: {
        orderId: order.id,
        name: 'Видеокарта RTX 4070',
        qty: '1',
        unitPrice: '60000.00',
        lineTotal: '60000.00',
      },
    });
    await H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-2026-0043',
        phone: '+79990000000',
        title: 'Ремонт',
        subtotal: '3000.00',
        totalAmount: '3000.00',
      },
    });

    for (const query of ['прозоров', '8 912 345 67 89', '100 000', 'rtx 4070', '0042']) {
      const res = await get(`/orders?search=${q(query)}`);
      expect(res.statusCode, query).toBe(200);
      expect(ids(res.json<{ items: Array<{ id: string }> }>().items), query).toEqual([order.id]);
    }
  });

  it('контрагенты: ИНН и телефон по цифрам; карточка по id — и архивная', async () => {
    const supplier = await H.prisma.counterparty.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'ООО Поставщик',
        role: 'SUPPLIER',
        inn: '7701234567',
        contact: '8 (912) 345-67-89',
        isArchived: true,
      },
    });

    const byInn = await get(`/counterparties?includeArchived=true&search=${q('770123')}`);
    expect(ids(byInn.json<Array<{ id: string }>>())).toEqual([supplier.id]);
    const byPhone = await get(`/counterparties?includeArchived=true&search=${q('+7 912 345')}`);
    expect(ids(byPhone.json<Array<{ id: string }>>())).toEqual([supplier.id]);

    const card = await get(`/counterparties/${supplier.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({
      id: supplier.id,
      isArchived: true,
      summary: { ordersCount: 0 },
    });
  });

  it('контрагенты: карточка чужой организации — 404', async () => {
    const other = await seedBase(H.prisma, tg + 50000n);
    const foreign = await H.prisma.counterparty.create({
      data: { workspaceId: other.workspaceId, name: 'Чужой' },
    });

    const res = await get(`/counterparties/${foreign.id}`);
    expect(res.statusCode).toBe(404);
  });

  it('склад: артикул и «ё» в названии', async () => {
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'Кулер Зелёный', sku: 'CL-120' },
    });
    await H.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'Корпус', sku: 'CS-1' },
    });

    for (const query of ['зеленый', 'cl-120']) {
      const res = await get(`/warehouse?search=${q(query)}`);
      expect(ids(res.json<Array<{ id: string }>>()), query).toEqual([item.id]);
    }
  });

  it('входящие: сумма со знаком рубля, неразрывным пробелом и плюсом; «ё» в контрагенте', async () => {
    const connection = await H.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'FILE',
        accountId: seed.accountId,
        createdById: seed.userId,
      },
    });
    const line = (externalId: string, amount: string, counterpartyName: string | null) =>
      H.prisma.bankStatementLine.create({
        data: {
          workspaceId: seed.workspaceId,
          connectionId: connection.id,
          externalId,
          date: new Date('2026-08-10T07:00:00.000Z'),
          amount,
          direction: 'INCOME',
          counterpartyName,
          status: 'NEW',
        },
      });
    const target = await line('a', '66019.00', 'Семёнов П.');
    await line('b', '9300.00', null);

    for (const query of ['66 019 ₽', '66 019', '+66019', 'семенов']) {
      const res = await get(`/inbox?q=${q(query)}`);
      expect(ids(res.json<{ items: Array<{ id: string }> }>().items), query).toEqual([target.id]);
    }
  });

  it('закупки: поставщик, позиция, комментарий и сумма — поиск на сервере', async () => {
    const supplier = await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'ДНС', role: 'SUPPLIER' },
    });
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'Блок питания', sku: 'PSU-650' },
    });
    const created = await H.inject({
      method: 'POST',
      url: `/workspaces/${seed.workspaceId}/purchases`,
      token,
      payload: {
        accountId: seed.accountId,
        supplierId: supplier.id,
        note: 'для сборки',
        lines: [{ warehouseItemId: item.id, qty: '2', unitPrice: '1500' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const purchaseId = created.json<{ id: string }>().id;

    for (const query of ['днс', 'блок питания', 'psu-650', '3 000', 'для сборки']) {
      const res = await get(`/purchases?search=${q(query)}`);
      expect(ids(res.json<Array<{ id: string }>>()), query).toEqual([purchaseId]);
    }
    expect((await get(`/purchases?search=${q('ремонт')}`)).json<unknown[]>()).toEqual([]);
  });
});
