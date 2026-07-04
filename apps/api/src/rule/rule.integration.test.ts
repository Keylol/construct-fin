/**
 * Движок правил Фаза B — CRUD + кросс-тенант ref-валидация + suggest.
 * RuleService поверх живого Prisma (construct_v6_test).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RuleService } from './rule.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let svc: RuleService;
let seed: Seed;
let tg = 2900000n;

beforeAll(() => {
  h = buildHarness();
  svc = new RuleService(h.prisma as unknown as PrismaService);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function makeCategory(name = 'Постоянные') {
  const c = await h.prisma.category.create({
    data: { workspaceId: seed.workspaceId, name, kind: 'EXPENSE' },
  });
  return c.id;
}
async function makeCounterparty(name = 'Арендодатель') {
  const c = await h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name },
  });
  return c.id;
}

describe('RuleService: CRUD + кросс-тенант', () => {
  it('создаёт правило и отдаёт его в списке', async () => {
    const categoryId = await makeCategory();
    const r = await svc.create(seed.workspaceId, {
      name: 'Аренда → Постоянные',
      priority: 5,
      isActive: true,
      appliesTo: 'BOTH',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'аренд' }],
      actions: [{ type: 'SET_CATEGORY', categoryId }],
    });
    expect(r.id).toBeTruthy();
    const list = await svc.list(seed.workspaceId);
    expect(list.map((x) => x.id)).toContain(r.id);
  });

  it('кросс-тенант: категория действия из чужого workspace → 400', async () => {
    // Чужой workspace + его категория.
    const otherTg = tg + 500000n;
    const other = await seedBase(h.prisma, otherTg);
    const foreignCat = await h.prisma.category.create({
      data: { workspaceId: other.workspaceId, name: 'Чужая', kind: 'EXPENSE' },
    });
    await expect(
      svc.create(seed.workspaceId, {
        name: 'x',
        priority: 0,
        isActive: true,
        appliesTo: 'BOTH',
        conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'а' }],
        actions: [{ type: 'SET_CATEGORY', categoryId: foreignCat.id }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('кросс-тенант: контрагент в УСЛОВИИ из чужого workspace → 400', async () => {
    const other = await seedBase(h.prisma, tg + 600000n);
    const foreignCp = await h.prisma.counterparty.create({
      data: { workspaceId: other.workspaceId, name: 'Чужой' },
    });
    const categoryId = await makeCategory();
    await expect(
      svc.create(seed.workspaceId, {
        name: 'x',
        priority: 0,
        isActive: true,
        appliesTo: 'BOTH',
        conditions: [{ type: 'COUNTERPARTY_EQUALS', counterpartyId: foreignCp.id }],
        actions: [{ type: 'SET_CATEGORY', categoryId }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update ревалидирует ссылки; softDelete убирает из списка', async () => {
    const categoryId = await makeCategory();
    const r = await svc.create(seed.workspaceId, {
      name: 'r',
      priority: 0,
      isActive: true,
      appliesTo: 'BOTH',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'а' }],
      actions: [{ type: 'SET_CATEGORY', categoryId }],
    });
    // update на чужую категорию → 400
    const other = await seedBase(h.prisma, tg + 700000n);
    const foreignCat = await h.prisma.category.create({
      data: { workspaceId: other.workspaceId, name: 'Ч', kind: 'EXPENSE' },
    });
    await expect(
      svc.update(seed.workspaceId, r.id, { actions: [{ type: 'SET_CATEGORY', categoryId: foreignCat.id }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // softDelete
    await svc.softDelete(seed.workspaceId, r.id);
    expect((await svc.list(seed.workspaceId)).map((x) => x.id)).not.toContain(r.id);
    // чужой id → 404
    await expect(svc.softDelete(seed.workspaceId, 'cme00000000000000000000zz')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RuleService: suggest', () => {
  it('подсказывает категорию по слову в описании', async () => {
    const categoryId = await makeCategory();
    await svc.create(seed.workspaceId, {
      name: 'Аренда',
      priority: 0,
      isActive: true,
      appliesTo: 'BOTH',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'аренд' }],
      actions: [{ type: 'SET_CATEGORY', categoryId }],
    });
    const s = await svc.suggest(seed.workspaceId, { source: 'MANUAL', description: 'Оплата аренды' });
    expect(s.categoryId).toBe(categoryId);
    expect(s.matchedRuleIds.length).toBe(1);
  });

  it('appliesTo=MANUAL правило НЕ подсказывается для источника IMPORT', async () => {
    const categoryId = await makeCategory();
    await svc.create(seed.workspaceId, {
      name: 'только ручной',
      priority: 0,
      isActive: true,
      appliesTo: 'MANUAL',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'кофе' }],
      actions: [{ type: 'SET_CATEGORY', categoryId }],
    });
    expect((await svc.suggest(seed.workspaceId, { source: 'IMPORT', description: 'кофе' })).categoryId).toBeUndefined();
    expect((await svc.suggest(seed.workspaceId, { source: 'MANUAL', description: 'кофе' })).categoryId).toBe(categoryId);
  });

  it('неактивное правило не подсказывается', async () => {
    const categoryId = await makeCategory();
    const r = await svc.create(seed.workspaceId, {
      name: 'выкл',
      priority: 0,
      isActive: true,
      appliesTo: 'BOTH',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'такси' }],
      actions: [{ type: 'SET_CATEGORY', categoryId }],
    });
    await svc.update(seed.workspaceId, r.id, { isActive: false });
    expect((await svc.suggest(seed.workspaceId, { source: 'MANUAL', description: 'такси' })).categoryId).toBeUndefined();
  });

  it('условие суммы + контрагента подставляет контрагента', async () => {
    const cpId = await makeCounterparty();
    await svc.create(seed.workspaceId, {
      name: 'крупный расход',
      priority: 0,
      isActive: true,
      appliesTo: 'BOTH',
      conditions: [
        { type: 'AMOUNT_RANGE', min: '10000', max: null },
        { type: 'TYPE_EQUALS', value: 'EXPENSE' },
      ],
      actions: [{ type: 'SET_COUNTERPARTY', counterpartyId: cpId }],
    });
    const s = await svc.suggest(seed.workspaceId, { source: 'MANUAL', amount: '15000', type: 'EXPENSE' });
    expect(s.counterpartyId).toBe(cpId);
    // ниже порога — не срабатывает
    expect((await svc.suggest(seed.workspaceId, { source: 'MANUAL', amount: '500', type: 'EXPENSE' })).counterpartyId).toBeUndefined();
  });

  it('кросс-тенант изоляция suggest: чужие правила не применяются', async () => {
    const other = await seedBase(h.prisma, tg + 800000n);
    const otherCat = await h.prisma.category.create({
      data: { workspaceId: other.workspaceId, name: 'Ч', kind: 'EXPENSE' },
    });
    await svc.create(other.workspaceId, {
      name: 'чужое',
      priority: 0,
      isActive: true,
      appliesTo: 'BOTH',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'общее' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: otherCat.id }],
    });
    // В нашем workspace слово то же, но правило чужое → нет подсказки.
    expect((await svc.suggest(seed.workspaceId, { source: 'MANUAL', description: 'общее' })).categoryId).toBeUndefined();
  });
});
