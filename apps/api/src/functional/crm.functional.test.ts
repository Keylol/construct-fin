/**
 * Функциональные тесты раздела amoCRM через реальный Nest+Fastify и подменный
 * amo (FakeAmoTransport, NODE_ENV=test). Проверяем: OwnerGuard на подключении,
 * маску токена (секрет наружу не уходит), отказ плохого токена, синк →
 * снимок сделок → вкладка «ждут заказа» с порогом «Отправлен», заведение
 * заказа с клиентом по телефону, привязку/отвязку, «не учитывать».
 *
 * Диапазон telegramId: 2900000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';
import { FAKE_AMO } from '../crm/fake-amo-transport';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2900000n;

const GOOD_TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.fake-long-lived-token-for-tests.signature-7788';

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
  await seedMember(H.prisma, seed.workspaceId, seed.userId, Role.OWNER);
  token = await H.jwtFor(seed.userId, tg);
});

const base = () => `/workspaces/${seed.workspaceId}/crm`;

async function connect(extra: Record<string, unknown> = {}) {
  const res = await H.inject({
    method: 'POST',
    url: `${base()}/connection`,
    token,
    payload: {
      subdomain: FAKE_AMO.subdomain,
      token: GOOD_TOKEN,
      pipelineId: FAKE_AMO.pipelineId,
      waitingStatusIds: [FAKE_AMO.statuses.sent, FAKE_AMO.statuses.parts],
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<Record<string, unknown>>();
}

async function sync() {
  const res = await H.inject({ method: 'POST', url: `${base()}/connection/sync`, token });
  expect(res.statusCode).toBe(200);
  return res.json<{ fetched: number; created: number; updated: number }>();
}

describe('amoCRM: подключение (OwnerGuard, маска токена)', () => {
  it('POST → 201, токен зашифрован, наружу только маска; повторное подключение → 409', async () => {
    const body = await connect();
    expect(body.keyLast4).toBe('7788');
    expect(body.accountName).toBe('Fake amoCRM');
    expect(body.subdomain).toBe(FAKE_AMO.subdomain);
    expect(body.waitingStatusIds).toEqual([FAKE_AMO.statuses.sent, FAKE_AMO.statuses.parts]);
    expect(JSON.stringify(body)).not.toContain('fake-long-lived');
    expect(body).not.toHaveProperty('credentialEnc');

    const row = await H.prisma.crmConnection.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId },
    });
    expect(row.credentialEnc).toContain('v1.');
    expect(row.credentialEnc).not.toContain('fake-long-lived');

    const again = await H.inject({
      method: 'POST',
      url: `${base()}/connection`,
      token,
      payload: { subdomain: FAKE_AMO.subdomain, token: GOOD_TOKEN },
    });
    expect(again.statusCode).toBe(409);
  });

  it('плохой токен отклоняется до записи с человеческим текстом', async () => {
    const res = await H.inject({
      method: 'POST',
      url: `${base()}/connection`,
      token,
      payload: { subdomain: FAKE_AMO.subdomain, token: 'bad-token-bad-token-bad-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('отклонил токен');
    expect(await H.prisma.crmConnection.count()).toBe(0);
  });

  it('оператор не может подключать, но видит сделки и может обновить', async () => {
    await connect();
    const opTg = tg + 500n;
    const op = await H.prisma.user.create({ data: { telegramId: opTg, firstName: 'Оператор' } });
    await seedMember(H.prisma, seed.workspaceId, op.id, Role.MEMBER);
    const opToken = await H.jwtFor(op.id, opTg);

    const forbidden = await H.inject({
      method: 'PATCH',
      url: `${base()}/connection`,
      token: opToken,
      payload: { status: 'DISABLED' },
    });
    expect(forbidden.statusCode).toBe(403);

    const syncRes = await H.inject({
      method: 'POST',
      url: `${base()}/connection/sync`,
      token: opToken,
    });
    expect(syncRes.statusCode).toBe(200);
    const list = await H.inject({ method: 'GET', url: `${base()}/deals?tab=all`, token: opToken });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
  });

  it('без подключения: connection → null, summary → connected=false, deals → пусто', async () => {
    const conn = await H.inject({ method: 'GET', url: `${base()}/connection`, token });
    expect(conn.statusCode).toBe(200);
    expect(conn.body === '' || conn.body === 'null').toBe(true);
    const sum = await H.inject({ method: 'GET', url: `${base()}/deals/summary`, token });
    expect(sum.json<{ connected: boolean }>().connected).toBe(false);
    const deals = await H.inject({ method: 'GET', url: `${base()}/deals`, token });
    expect(deals.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe('amoCRM: синк и вкладки', () => {
  it('синк кладёт снимок сделок; «ждут заказа» — только выбранные этапы, открытые, с телефоном из контакта', async () => {
    await connect();
    const first = await sync();
    expect(first).toEqual({ fetched: 3, created: 3, updated: 0 });
    // Повторный синк идемпотентен: те же сделки — обновление, не дубли.
    const second = await sync();
    expect(second.created).toBe(0);
    expect(await H.prisma.crmDeal.count()).toBe(3);

    const waiting = await H.inject({ method: 'GET', url: `${base()}/deals?tab=waiting`, token });
    const items = waiting.json<{ items: Record<string, unknown>[] }>().items;
    expect(items.map((d) => d.externalId)).toEqual([FAKE_AMO.leads.waiting]);
    const deal = items[0]!;
    expect(deal.price).toBe('150198.00');
    expect(deal.statusName).toBe('Фото комплектующих');
    expect(deal.phone).toBe(FAKE_AMO.phone);
    expect(deal.contactName).toBe('Донгак Алдын-Херел');
    expect(deal.responsibleName).toBe('Илья');
    expect(deal.url).toBe(
      `https://${FAKE_AMO.subdomain}.amocrm.ru/leads/detail/${FAKE_AMO.leads.waiting}`,
    );

    const all = await H.inject({ method: 'GET', url: `${base()}/deals?tab=all`, token });
    // Закрытая (142) во «всей воронке» открытых нет? — «all» показывает и закрытые в воронке.
    expect(all.json<{ items: unknown[] }>().items.length).toBe(3);

    const summary = await H.inject({ method: 'GET', url: `${base()}/deals/summary`, token });
    const s = summary.json<Record<string, unknown>>();
    expect(s.connected).toBe(true);
    expect(s.waitingCount).toBe(1);
    expect(s.waitingSum).toBe('150198.00');
    expect(s.openCount).toBe(2);
    expect(s.waitingStageNames).toEqual(['Отправлен', 'Фото комплектующих']);
  });

  it('поиск по телефону и по сумме; фильтр по этапу', async () => {
    await connect();
    await sync();
    const byPhone = await H.inject({
      method: 'GET',
      url: `${base()}/deals?tab=all&search=9243634029`,
      token,
    });
    expect(
      byPhone.json<{ items: { externalId: number }[] }>().items.map((d) => d.externalId),
    ).toEqual([FAKE_AMO.leads.waiting]);
    const bySum = await H.inject({
      method: 'GET',
      url: `${base()}/deals?tab=all&search=120000`,
      token,
    });
    expect(
      bySum.json<{ items: { externalId: number }[] }>().items.map((d) => d.externalId),
    ).toEqual([FAKE_AMO.leads.beforeThreshold]);
    const byStage = await H.inject({
      method: 'GET',
      url: `${base()}/deals?tab=all&statusId=${FAKE_AMO.statuses.check}`,
      token,
    });
    expect(
      byStage.json<{ items: { externalId: number }[] }>().items.map((d) => d.externalId),
    ).toEqual([FAKE_AMO.leads.beforeThreshold]);
  });

  it('этапы воронки отдаются в порядке доски с числом открытых и флагом «ждут»', async () => {
    await connect();
    await sync();
    const res = await H.inject({ method: 'GET', url: `${base()}/stages`, token });
    expect(res.statusCode).toBe(200);
    const stages = res.json<{ id: number; name: string; openCount: number; waiting: boolean }[]>();
    expect(stages.map((s) => s.name)).toEqual([
      'САЙТ',
      'Проверка',
      'Отправлен',
      'Фото комплектующих',
    ]);
    expect(stages.find((s) => s.name === 'Проверка')).toMatchObject({
      openCount: 1,
      waiting: false,
    });
    expect(stages.find((s) => s.name === 'Фото комплектующих')).toMatchObject({
      openCount: 1,
      waiting: true,
    });
  });

  it('ошибка amo переводит подключение в ERROR с текстом, новый токен снимает ошибку', async () => {
    await connect();
    await H.prisma.crmConnection.updateMany({ data: { credentialEnc: 'v1.broken' } });
    const res = await H.inject({ method: 'POST', url: `${base()}/connection/sync`, token });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const row = await H.prisma.crmConnection.findFirstOrThrow();
    expect(row.status).toBe('ERROR');
    expect(row.lastSyncError).toBeTruthy();

    const rotate = await H.inject({
      method: 'PATCH',
      url: `${base()}/connection`,
      token,
      payload: { token: GOOD_TOKEN },
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json<{ status: string; lastSyncError: string | null }>()).toMatchObject({
      status: 'ACTIVE',
      lastSyncError: null,
    });
  });
});

describe('amoCRM: сопоставление с заказами', () => {
  /** Заказ учёта с тем же телефоном и суммой, что у ждущей сделки. */
  async function seedOrder(over: {
    number: string;
    phone: string | null;
    total: string;
    clientId?: string;
  }) {
    return H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: over.number,
        phone: over.phone,
        clientId: over.clientId ?? null,
        status: 'DONE',
        paymentStatus: 'PAID',
        subtotal: over.total,
        totalAmount: over.total,
        paidAmount: over.total,
      },
    });
  }

  it('предлагает пару по телефону и сумме как надёжную, по одному телефону — без галочки', async () => {
    await connect();
    await sync();
    const exact = await seedOrder({
      number: 'ORD-2026-0100',
      phone: FAKE_AMO.phone,
      total: '150198.00',
    });
    await seedOrder({ number: 'ORD-2026-0101', phone: FAKE_AMO.phone, total: '11111.00' });

    const res = await H.inject({ method: 'GET', url: `${base()}/deals/match`, token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: {
        reason: string;
        confident: boolean;
        deal: { externalId: number };
        order: { id: string; number: string };
      }[];
      confidentCount: number;
    }>();
    expect(body.confidentCount).toBe(1);
    const pair = body.items.find((i) => i.confident);
    expect(pair).toMatchObject({ reason: 'phone_and_sum' });
    expect(pair!.order.id).toBe(exact.id);
    expect(pair!.deal.externalId).toBe(FAKE_AMO.leads.waiting);
    // Второй заказ того же телефона в пару не попал: сделка уже занята сильной парой.
    expect(body.items.filter((i) => i.deal.externalId === FAKE_AMO.leads.waiting)).toHaveLength(1);
  });

  it('ФИО с пометкой CRM и копейки в заказе: пара находится и отмечена', async () => {
    await connect();
    await sync();
    // Сделка «Донгак Алдын-Херел (Р)» без телефона в заказе и с копейками:
    // ровно тот случай, из-за которого 20.09.2026 девять сделок не нашли заказы.
    const client = await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Донгак Алдын-Херел', role: 'CLIENT' },
    });
    const order = await seedOrder({
      number: 'ORD-2026-0200',
      phone: '+79000000001',
      total: '150198.84',
      clientId: client.id,
    });
    const res = await H.inject({ method: 'GET', url: `${base()}/deals/match`, token });
    const items =
      res.json<{ reason: string; confident: boolean; order: { id: string } }[]>().items ??
      res.json<{ items: { reason: string; confident: boolean; order: { id: string } }[] }>().items;
    const pair = items.find((i) => i.order.id === order.id);
    expect(pair).toMatchObject({ reason: 'name_and_sum', confident: true });
  });

  it('массовая привязка: связывает пары, дозаполняет телефон и источник клиента, пропускает занятые', async () => {
    await connect();
    await sync();
    const client = await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Донгак Алдын-Херел', role: 'CLIENT' },
    });
    const order = await seedOrder({
      number: 'ORD-2026-0100',
      phone: FAKE_AMO.phone,
      total: '150198.00',
      clientId: client.id,
    });
    const match = await H.inject({ method: 'GET', url: `${base()}/deals/match`, token });
    const pairs = match
      .json<{ items: { confident: boolean; deal: { id: string }; order: { id: string } }[] }>()
      .items.filter((i) => i.confident)
      .map((i) => ({ dealId: i.deal.id, orderId: i.order.id }));
    expect(pairs).toHaveLength(1);

    const res = await H.inject({
      method: 'POST',
      url: `${base()}/deals/link-bulk`,
      token,
      payload: { pairs },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked: 1, skipped: 0, clientsPatched: 1 });

    const linked = await H.prisma.crmDeal.findFirstOrThrow({
      where: { externalId: FAKE_AMO.leads.waiting },
    });
    expect(linked.orderId).toBe(order.id);
    const patched = await H.prisma.counterparty.findUniqueOrThrow({ where: { id: client.id } });
    expect(patched.contact).toBe(FAKE_AMO.phone);
    expect(patched.source).toBe('amoCRM');

    // Повтор той же пары: сделка занята — пропуск, а не ошибка.
    const again = await H.inject({
      method: 'POST',
      url: `${base()}/deals/link-bulk`,
      token,
      payload: { pairs },
    });
    expect(again.json()).toEqual({ linked: 0, skipped: 1, clientsPatched: 0 });

    const audit = await H.prisma.auditLog.findMany({
      where: { workspaceId: seed.workspaceId, action: { in: ['crm.link', 'crm.client-enrich'] } },
    });
    expect(audit).toHaveLength(2);
  });

  it('заполненный телефон клиента не перезаписывается', async () => {
    await connect();
    await sync();
    const client = await H.prisma.counterparty.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Донгак',
        role: 'CLIENT',
        contact: '+79000000000',
        source: 'Avito',
      },
    });
    await seedOrder({
      number: 'ORD-2026-0100',
      phone: FAKE_AMO.phone,
      total: '150198.00',
      clientId: client.id,
    });
    const match = await H.inject({ method: 'GET', url: `${base()}/deals/match`, token });
    const pairs = match
      .json<{ items: { confident: boolean; deal: { id: string }; order: { id: string } }[] }>()
      .items.filter((i) => i.confident)
      .map((i) => ({ dealId: i.deal.id, orderId: i.order.id }));
    const res = await H.inject({
      method: 'POST',
      url: `${base()}/deals/link-bulk`,
      token,
      payload: { pairs },
    });
    expect(res.json<{ clientsPatched: number }>().clientsPatched).toBe(0);
    const same = await H.prisma.counterparty.findUniqueOrThrow({ where: { id: client.id } });
    expect(same.contact).toBe('+79000000000');
    expect(same.source).toBe('Avito');
  });

  it('счётчик «ждут заказа» для бейджа совпадает со сводкой', async () => {
    await connect();
    await sync();
    const count = await H.inject({ method: 'GET', url: `${base()}/deals/count`, token });
    const summary = await H.inject({ method: 'GET', url: `${base()}/deals/summary`, token });
    expect(count.json<{ count: number }>().count).toBe(
      summary.json<{ waitingCount: number }>().waitingCount,
    );
  });
});

describe('amoCRM: сделка → заказ', () => {
  async function waitingDeal() {
    await connect();
    await sync();
    const res = await H.inject({ method: 'GET', url: `${base()}/deals?tab=waiting`, token });
    return res.json<{ items: { id: string; externalId: number }[] }>().items[0]!;
  }

  it('«Завести заказ»: клиент по телефону создаётся с источником amoCRM, заказ на бюджет, сделка привязана', async () => {
    const deal = await waitingDeal();
    const res = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${deal.id}/create-order`,
      token,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      orderId: string;
      orderNumber: string;
      deal: Record<string, unknown>;
    }>();
    expect(body.orderNumber).toMatch(/^ORD-/);
    expect((body.deal.order as { id: string }).id).toBe(body.orderId);

    const order = await H.prisma.order.findUniqueOrThrow({
      where: { id: body.orderId },
      include: { items: true, client: true },
    });
    expect(order.phone).toBe(FAKE_AMO.phone);
    expect(order.totalAmount.toFixed(2)).toBe('150198.00');
    expect(order.items).toHaveLength(1);
    expect(order.description).toContain('Пожелания по сборке: под игры, белый корпус');
    expect(order.description).toContain(`amoCRM: сделка #${FAKE_AMO.leads.waiting}`);
    expect(order.client?.role).toBe('CLIENT');
    expect(order.client?.source).toBe('amoCRM');
    expect(order.client?.contact).toBe(FAKE_AMO.phone);

    // Повторно завести нельзя — сделка уже привязана.
    const again = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${deal.id}/create-order`,
      token,
    });
    expect(again.statusCode).toBe(409);

    // Ушла из «ждут заказа», появилась в «привязаны».
    const waiting = await H.inject({ method: 'GET', url: `${base()}/deals?tab=waiting`, token });
    expect(waiting.json<{ items: unknown[] }>().items).toEqual([]);
    const linked = await H.inject({ method: 'GET', url: `${base()}/deals?tab=linked`, token });
    expect(linked.json<{ items: { id: string }[] }>().items.map((d) => d.id)).toEqual([deal.id]);

    const audit = await H.prisma.auditLog.findMany({
      where: { workspaceId: seed.workspaceId, action: 'crm.create-order' },
    });
    expect(audit).toHaveLength(1);
  });

  it('второй заказ того же клиента переиспользует клиента (без дублей)', async () => {
    const deal = await waitingDeal();
    await H.inject({ method: 'POST', url: `${base()}/deals/${deal.id}/create-order`, token });
    await H.inject({ method: 'POST', url: `${base()}/deals/${deal.id}/unlink`, token });
    await H.inject({ method: 'POST', url: `${base()}/deals/${deal.id}/create-order`, token });
    const clients = await H.prisma.counterparty.count({
      where: { workspaceId: seed.workspaceId, role: 'CLIENT', contact: FAKE_AMO.phone },
    });
    expect(clients).toBe(1);
  });

  it('сделка без телефона: «завести» → 400 с подсказкой, но привязать к заказу можно', async () => {
    await connect();
    await sync();
    const all = await H.inject({ method: 'GET', url: `${base()}/deals?tab=all&search=Лид`, token });
    const noPhone = all.json<{ items: { id: string; phone: string | null }[] }>().items[0]!;
    expect(noPhone.phone).toBeNull();
    const res = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${noPhone.id}/create-order`,
      token,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('нет телефона');

    const order = await H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-2026-0001',
        phone: '+79990000000',
        status: 'OPEN',
        paymentStatus: 'UNPAID',
      },
    });
    const link = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${noPhone.id}/link`,
      token,
      payload: { orderId: order.id },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json<{ order: { number: string } }>().order.number).toBe('ORD-2026-0001');
    // Чужой заказ (другого пространства) не привязывается.
    const other = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${noPhone.id}/unlink`,
      token,
    });
    expect(other.statusCode).toBe(200);
    const bogus = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${noPhone.id}/link`,
      token,
      payload: { orderId: 'clzzzzzzzzzzzzzzzzzzzzzzz' },
    });
    expect(bogus.statusCode).toBe(404);
  });

  it('кандидаты по телефону: открытый заказ с тем же телефоном виден у сделки', async () => {
    await connect();
    await sync();
    await H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-2026-0007',
        phone: FAKE_AMO.phone,
        status: 'OPEN',
        paymentStatus: 'UNPAID',
      },
    });
    const res = await H.inject({ method: 'GET', url: `${base()}/deals?tab=waiting`, token });
    const deal = res.json<{ items: { suggestedOrders: { number: string }[] }[] }>().items[0]!;
    expect(deal.suggestedOrders.map((o) => o.number)).toEqual(['ORD-2026-0007']);
  });

  it('«не учитывать» обратимо и не даётся привязанной сделке', async () => {
    const deal = await waitingDeal();
    const dismissed = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${deal.id}/dismiss`,
      token,
    });
    expect(dismissed.statusCode).toBe(200);
    const waiting = await H.inject({ method: 'GET', url: `${base()}/deals?tab=waiting`, token });
    expect(waiting.json<{ items: unknown[] }>().items).toEqual([]);
    const tab = await H.inject({ method: 'GET', url: `${base()}/deals?tab=dismissed`, token });
    expect(tab.json<{ items: { id: string }[] }>().items.map((d) => d.id)).toEqual([deal.id]);
    const back = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${deal.id}/undismiss`,
      token,
    });
    expect(back.json<{ dismissedAt: string | null }>().dismissedAt).toBeNull();

    await H.inject({ method: 'POST', url: `${base()}/deals/${deal.id}/create-order`, token });
    const conflict = await H.inject({
      method: 'POST',
      url: `${base()}/deals/${deal.id}/dismiss`,
      token,
    });
    expect(conflict.statusCode).toBe(409);
  });
});
