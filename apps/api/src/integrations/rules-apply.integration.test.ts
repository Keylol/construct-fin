import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { SyncService } from './sync.service';
import { InboxService } from './inbox.service';

/**
 * Правила поверх УЖЕ загруженной выписки: предпросмотр, переприменение к строкам
 * на разборе, массовый откат. До этой волны правила действовали только в момент
 * приезда строки — набор правил, заведённый после загрузки, не влиял ни на что.
 *
 * Плюс два признака, которые движок раньше не видел, хотя банк их отдаёт: ИНН
 * контрагента и счёт подключения.
 */
const KEY32 = Buffer.alloc(32, 3).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

let h: Harness;
let seed: Seed;
let sync: SyncService;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 2900000n;

beforeAll(() => {
  h = buildHarness();
  crypto = new CryptoService({ get: () => KEY32 } as never);
  sync = new SyncService(
    h.prisma as never,
    crypto,
    new AdapterRegistry(new FakeBankAdapter(), { get: () => 'test' } as never),
  );
  inbox = new InboxService(h.prisma as never, h.orders as never, h.rules as never, h.transfer as never, h.planning as never);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function makeConnection() {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'ALFA',
      accountId: seed.accountId,
      credentialEnc: crypto.encrypt('secret-token-1234'),
      keyLast4: '1234',
      createdById: seed.userId,
    },
  });
}

async function makeCategory(name = 'Закупка товара') {
  return h.categories.create(seed.workspaceId, {
    name,
    kind: 'INCOME',
    isFixedCost: false,
    bucket: 'REVENUE',
  });
}

/** Правило «ИНН из списка → категория». ИНН 7701234567 — у строки fake-1. */
async function makeInnRule(categoryId: string, inn = '7701234567') {
  return h.prisma.rule.create({
    data: {
      workspaceId: seed.workspaceId,
      name: `ИНН ${inn} → категория`,
      appliesTo: 'BOTH',
      conditions: [{ type: 'COUNTERPARTY_INN_IN', values: [inn] }],
      actions: [{ type: 'SET_CATEGORY', categoryId }],
    },
  });
}

describe('правила по ИНН на синке', () => {
  it('ИНН из выписки доезжает до движка: строка проводится автоматически', async () => {
    const cat = await makeCategory();
    const rule = await makeInnRule(cat.id);
    const conn = await makeConnection();

    const res = await sync.syncConnection(conn.id);

    expect(res.autoPosted).toBe(1);
    const posted = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id, status: 'AUTO_POSTED' },
    });
    expect(posted.externalId).toBe('fake-1'); // единственная строка с этим ИНН
    expect(posted.counterpartyInn).toBe('7701234567');
    // Помним, КАКОЕ правило провело строку — иначе массовый откат невозможен.
    expect(posted.appliedRuleId).toBe(rule.id);
  });

  it('авто-проводка несёт маркировку АУСН банка (как и ручной разбор)', async () => {
    const cat = await makeCategory();
    await makeInnRule(cat.id);
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);

    const posted = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id, status: 'AUTO_POSTED' },
    });
    const tx = await h.prisma.transaction.findUniqueOrThrow({
      where: { id: posted.transactionId! },
    });
    // fake-1 приходит с ausnMark=INCOME. Раньше авто-ветка её теряла, и строка
    // выпадала из базы налога, хотя разобранная руками — попадала.
    expect(tx.ausnMark).toBe('INCOME');
  });

  it('счёт подключения виден правилу: ACCOUNT_EQUALS срабатывает на синке', async () => {
    const cat = await makeCategory();
    await h.prisma.rule.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Всё с этого счёта',
        appliesTo: 'BOTH',
        conditions: [
          { type: 'ACCOUNT_EQUALS', accountId: seed.accountId },
          { type: 'DESCRIPTION_CONTAINS', value: 'канцтовары' },
        ],
        actions: [{ type: 'SET_CATEGORY', categoryId: cat.id }],
      },
    });
    const conn = await makeConnection();

    const res = await sync.syncConnection(conn.id);
    expect(res.autoPosted).toBe(1); // fake-4 «Канцтовары»
  });
});

describe('RuleService.preview', () => {
  it('считает совпадения по уже загруженным строкам и отдаёт примеры', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id); // 4 строки, все NEW (правил нет)

    const res = await h.rules.preview(seed.workspaceId, [
      { type: 'COUNTERPARTY_INN_IN', values: ['7701234567'] },
    ]);

    expect(res.matched).toBe(1);
    expect(res.matchedPending).toBe(1); // строка ещё на разборе — её и проведёт применение
    expect(res.total).toBe(4);
    expect(res.truncated).toBe(false);
    expect(res.samples).toHaveLength(1);
    expect(res.samples[0]!.description).toBe('Оплата по договору №14');
  });

  it('условие ни во что не попало → ноль совпадений, без примеров', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);

    const res = await h.rules.preview(seed.workspaceId, [
      { type: 'DESCRIPTION_CONTAINS', value: 'такого назначения нет' },
    ]);
    expect(res.matched).toBe(0);
    expect(res.samples).toEqual([]);
  });

  it('чужие строки в предпросмотр не попадают', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    // Соседнее пространство со своим набором строк.
    const other = await seedBase(h.prisma, tg + 500n);

    const res = await h.rules.preview(other.workspaceId, [
      { type: 'COUNTERPARTY_INN_IN', values: ['7701234567'] },
    ]);
    expect(res.total).toBe(0);
    expect(res.matched).toBe(0);
  });
});

describe('InboxService.applyRulesToPending', () => {
  it('проводит строки, лежавшие на разборе до появления правила', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id); // правил ещё нет → 4 строки в NEW
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 4 });

    const cat = await makeCategory();
    const rule = await makeInnRule(cat.id);

    const res = await inbox.applyRulesToPending(seed.workspaceId, seed.userId);

    expect(res.posted).toBe(1);
    expect(res.scanned).toBe(4);
    expect(res.remaining).toBe(3);

    const posted = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, status: 'AUTO_POSTED' },
    });
    expect(posted.appliedRuleId).toBe(rule.id);
    const tx = await h.prisma.transaction.findUniqueOrThrow({
      where: { id: posted.transactionId! },
    });
    expect(tx.categoryId).toBe(cat.id);
    expect(num(tx.amount)).toBe(15000);
    expect(tx.accountId).toBe(seed.accountId);
    expect(tx.ausnMark).toBe('INCOME');
  });

  it('повторный прогон ничего не дублирует', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const cat = await makeCategory();
    await makeInnRule(cat.id);

    await inbox.applyRulesToPending(seed.workspaceId, seed.userId);
    const second = await inbox.applyRulesToPending(seed.workspaceId, seed.userId);

    expect(second.posted).toBe(0); // строка уже AUTO_POSTED, под правило не попадает
    const txCount = await h.prisma.transaction.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(txCount).toBe(1);
  });

  it('не трогает разобранные и отклонённые строки', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { externalId: 'fake-1' },
    });
    await inbox.dismiss(seed.workspaceId, line.id);

    const cat = await makeCategory();
    await makeInnRule(cat.id);
    const res = await inbox.applyRulesToPending(seed.workspaceId, seed.userId);

    expect(res.posted).toBe(0);
    const after = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after.status).toBe('DISMISSED'); // решение оператора важнее правила
  });

  it('правило с удалённой категорией пропускается, а не роняет пачку', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const cat = await makeCategory();
    await makeInnRule(cat.id);
    // Категорию удалили уже после того, как правило на неё сослалось (FK внутри
    // JSON не enforce-ится, каскада нет).
    await h.prisma.category.update({ where: { id: cat.id }, data: { deletedAt: new Date() } });

    const res = await inbox.applyRulesToPending(seed.workspaceId, seed.userId);

    expect(res.posted).toBe(0);
    expect(res.skipped).toBe(4);
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 4 }); // всё осталось на разборе
  });

  it('без активных правил — ничего не делает', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);

    const res = await inbox.applyRulesToPending(seed.workspaceId, seed.userId);
    expect(res).toEqual({ scanned: 0, posted: 0, skipped: 0, remaining: 0 });
  });

  it('чужие строки не проводит', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const other = await seedBase(h.prisma, tg + 700n);
    const cat = await makeCategory();
    await makeInnRule(cat.id);

    // Правило и строки — в нашем пространстве; прогон запускаем в соседнем.
    const res = await inbox.applyRulesToPending(other.workspaceId, other.userId);

    expect(res.posted).toBe(0);
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 4 });
  });
});

describe('ревизия авто-проведённого', () => {
  it('список по статусу AUTO_POSTED показывает, какое правило провело строку', async () => {
    const cat = await makeCategory();
    const rule = await makeInnRule(cat.id);
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);

    const list = await inbox.list(seed.workspaceId, { limit: 50, status: 'AUTO_POSTED' });

    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.status).toBe('AUTO_POSTED');
    expect(list.items[0]!.appliedRule).toEqual({ id: rule.id, name: rule.name });
  });

  it('массовый откат по правилу снимает проводки и возвращает строки на разбор', async () => {
    const cat = await makeCategory();
    const rule = await makeInnRule(cat.id);
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);

    const res = await inbox.undoBulk(seed.workspaceId, { appliedRuleId: rule.id });

    expect(res).toEqual({ undone: 1, skipped: 0 });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { externalId: 'fake-1' },
    });
    expect(line.status).toBe('NEW');
    expect(line.transactionId).toBeNull();
    // Проводка снята мягко — деньги из отчётов ушли.
    const live = await h.prisma.transaction.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(live).toBe(0);
  });

  it('массовый откат перечислением строк', async () => {
    const cat = await makeCategory();
    await makeInnRule(cat.id);
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const posted = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { status: 'AUTO_POSTED' },
    });

    const res = await inbox.undoBulk(seed.workspaceId, { lineIds: [posted.id] });

    expect(res.undone).toBe(1);
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 4 }); // все четыре снова на разборе
  });

  it('чужие строки массовый откат не трогает', async () => {
    const cat = await makeCategory();
    const rule = await makeInnRule(cat.id);
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const other = await seedBase(h.prisma, tg + 900n);

    const res = await inbox.undoBulk(other.workspaceId, { appliedRuleId: rule.id });

    expect(res).toEqual({ undone: 0, skipped: 0 });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { externalId: 'fake-1' },
    });
    expect(line.status).toBe('AUTO_POSTED'); // осталась проведённой
  });
});
