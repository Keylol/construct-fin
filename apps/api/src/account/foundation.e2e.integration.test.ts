/**
 * E2E (DB-backed) сценарии домена «Счета / категории / контрагенты».
 *
 * Сервис-уровень поверх живого PrismaClient (construct_v6_test). Проверяем
 * каждый значимый флоу по данным: завести → выполнить → проверить эффект в БД
 * либо в ответе сервиса, включая edge-кейсы и гварды (throw).
 *
 * НЕ дублирует existingCoverage:
 *  - account.service.test.ts (unit: Account.class propagation)
 *  - category.dto.test.ts (unit: bucket enum)
 * Здесь — именно DB-backed специфика CRUD/иерархии/фильтров/soft-delete/гвардов.
 *
 * Уникальный диапазон telegramId: 1000000n.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 1000000n;

const num = (v: unknown) => Number((v as { toString(): string }).toString());

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

// ──────────────────────────────────────────────────────────────────────────
// ACCOUNTS
// ──────────────────────────────────────────────────────────────────────────
describe('Accounts — create', () => {
  it('создаёт счёт с дефолтами class=OPERATING, openingBalance=0, isArchived=false, deletedAt=null', async () => {
    const created = await h.accounts.create(seed.workspaceId, {
      name: 'Р/с Сбер',
      type: 'BANK',
      class: 'OPERATING',
      openingBalance: '0',
    });
    expect(created.name).toBe('Р/с Сбер');
    expect(created.type).toBe('BANK');
    expect(created.class).toBe('OPERATING');
    expect(created.openingBalance).toBe('0.00'); // serialize → toFixed(2)
    expect(created.isArchived).toBe(false);

    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.isArchived).toBe(false);
    expect(row.class).toBe('OPERATING');
    expect(num(row.openingBalance)).toBe(0);
  });

  it('сохраняет openingBalance с 2 знаками и note', async () => {
    const created = await h.accounts.create(seed.workspaceId, {
      name: 'Эквайринг',
      type: 'OTHER',
      class: 'TRANSIT',
      openingBalance: '1500.55',
      note: 'Маркетплейс',
    });
    expect(created.openingBalance).toBe('1500.55');
    expect(created.note).toBe('Маркетплейс');
    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: created.id } });
    expect(num(row.openingBalance)).toBe(1500.55);
    expect(row.class).toBe('TRANSIT');
    expect(row.note).toBe('Маркетплейс');
  });

  it('class=PERSONAL сохраняется отдельным классом (для консолидации cashflow)', async () => {
    const created = await h.accounts.create(seed.workspaceId, {
      name: 'Личная карта',
      type: 'BANK',
      class: 'PERSONAL',
      openingBalance: '0',
    });
    expect(created.class).toBe('PERSONAL');
  });
});

describe('Accounts — list', () => {
  it('по умолчанию исключает архивные и удалённые, сортирует isArchived ASC → name ASC', async () => {
    // seedBase уже создал один счёт «Каса»; добавим ещё.
    const bArch = await h.accounts.create(seed.workspaceId, {
      name: 'Архивный', type: 'BANK', class: 'OPERATING', openingBalance: '0',
    });
    await h.accounts.update(seed.workspaceId, bArch.id, { isArchived: true });
    const bDel = await h.accounts.create(seed.workspaceId, {
      name: 'Удалённый', type: 'BANK', class: 'OPERATING', openingBalance: '0',
    });
    await h.accounts.softDelete(seed.workspaceId, bDel.id);
    await h.accounts.create(seed.workspaceId, {
      name: 'Альфа', type: 'BANK', class: 'OPERATING', openingBalance: '0',
    });

    const list = await h.accounts.list(seed.workspaceId, { includeArchived: false });
    const names = list.map((a) => a.name);
    // удалённый отсутствует, архивный отсутствует; «Альфа» и «Каса» по алфавиту
    expect(names).toEqual(['Альфа', 'Каса']);
    expect(list.every((a) => a.isArchived === false)).toBe(true);
  });

  it('includeArchived=true показывает архивные, но НЕ удалённые; архивные идут после активных', async () => {
    const arch = await h.accounts.create(seed.workspaceId, {
      name: 'ААрхив', type: 'BANK', class: 'OPERATING', openingBalance: '0',
    });
    await h.accounts.update(seed.workspaceId, arch.id, { isArchived: true });
    const del = await h.accounts.create(seed.workspaceId, {
      name: 'Удалённый', type: 'BANK', class: 'OPERATING', openingBalance: '0',
    });
    await h.accounts.softDelete(seed.workspaceId, del.id);

    const list = await h.accounts.list(seed.workspaceId, { includeArchived: true });
    const names = list.map((a) => a.name);
    // активная «Каса» первой (isArchived ASC), архивный «ААрхив» — после, удалённого нет
    expect(names).toEqual(['Каса', 'ААрхив']);
  });
});

describe('Accounts — update', () => {
  it('переименование и смена типа/класса (р/с → транзитный эквайринг)', async () => {
    const acc = await h.accounts.create(seed.workspaceId, {
      name: 'Р/с', type: 'BANK', class: 'OPERATING', openingBalance: '0',
    });
    const upd = await h.accounts.update(seed.workspaceId, acc.id, {
      name: 'Эквайринг МП', type: 'OTHER', class: 'TRANSIT', openingBalance: '250.00',
    });
    expect(upd.name).toBe('Эквайринг МП');
    expect(upd.type).toBe('OTHER');
    expect(upd.class).toBe('TRANSIT');
    expect(upd.openingBalance).toBe('250.00');
  });

  it('undefined-поля не трогаются; note=null зануляет явно', async () => {
    const acc = await h.accounts.create(seed.workspaceId, {
      name: 'Со заметкой', type: 'CASH', class: 'OPERATING', openingBalance: '10.00', note: 'старая',
    });
    // только name — note должна остаться
    const u1 = await h.accounts.update(seed.workspaceId, acc.id, { name: 'Новое имя' });
    expect(u1.name).toBe('Новое имя');
    expect(u1.note).toBe('старая');
    expect(u1.openingBalance).toBe('10.00');
    // явный null зануляет note
    const u2 = await h.accounts.update(seed.workspaceId, acc.id, { note: null });
    expect(u2.note).toBeNull();
    expect(u2.name).toBe('Новое имя'); // имя не потеряно
  });

  it('NotFoundException при несуществующем id', async () => {
    await expect(
      h.accounts.update(seed.workspaceId, 'no-such-id', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('NotFoundException при попытке обновить уже удалённый счёт', async () => {
    const acc = await h.accounts.create(seed.workspaceId, {
      name: 'X', type: 'CASH', class: 'OPERATING', openingBalance: '0',
    });
    await h.accounts.softDelete(seed.workspaceId, acc.id);
    await expect(
      h.accounts.update(seed.workspaceId, acc.id, { name: 'y' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Accounts — softDelete', () => {
  it('проставляет deletedAt, скрывает из list, оставляет строку в БД', async () => {
    const acc = await h.accounts.create(seed.workspaceId, {
      name: 'Удаляемый', type: 'CASH', class: 'OPERATING', openingBalance: '0',
    });
    const res = await h.accounts.softDelete(seed.workspaceId, acc.id);
    expect(res).toBeUndefined(); // контроллер отдаёт 204

    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.deletedAt).not.toBeNull(); // строка осталась для отчётов

    const list = await h.accounts.list(seed.workspaceId, { includeArchived: true });
    expect(list.find((a) => a.id === acc.id)).toBeUndefined();
  });

  it('NotFoundException при повторном удалении', async () => {
    const acc = await h.accounts.create(seed.workspaceId, {
      name: 'X', type: 'CASH', class: 'OPERATING', openingBalance: '0',
    });
    await h.accounts.softDelete(seed.workspaceId, acc.id);
    await expect(
      h.accounts.softDelete(seed.workspaceId, acc.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('M3: счёт с активными операциями удалить нельзя (не осиротить транзакции)', async () => {
    const acc = await h.accounts.create(seed.workspaceId, {
      name: 'С операцией', type: 'CASH', class: 'OPERATING', openingBalance: '0',
    });
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: acc.id,
        date: new Date(),
        amount: '100.00',
        type: 'INCOME',
        kind: 'OTHER',
        createdById: seed.userId,
      },
    });
    await expect(h.accounts.softDelete(seed.workspaceId, acc.id)).rejects.toThrow();
    // счёт жив
    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.deletedAt).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CATEGORIES
// ──────────────────────────────────────────────────────────────────────────
describe('Categories — create', () => {
  it('создаёт корневую категорию с дефолтами bucket=OTHER, isFixedCost=false', async () => {
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Прочее', kind: 'EXPENSE', isFixedCost: false,
    });
    expect(cat.bucket).toBe('OTHER'); // БД-дефолт
    expect(cat.parentId).toBeNull();
    expect(cat.isFixedCost).toBe(false);
    expect(cat.isArchived).toBe(false);
  });

  it('сохраняет переданный bucket и isFixedCost', async () => {
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Аренда', kind: 'EXPENSE', bucket: 'FIXED', isFixedCost: true,
    });
    expect(cat.bucket).toBe('FIXED');
    expect(cat.isFixedCost).toBe(true);
  });

  it('создаёт подкатегорию под корнем того же kind (2 уровня)', async () => {
    const parent = await h.categories.create(seed.workspaceId, {
      name: 'Расходы', kind: 'EXPENSE', isFixedCost: false,
    });
    const child = await h.categories.create(seed.workspaceId, {
      name: 'Канцелярия', kind: 'EXPENSE', parentId: parent.id, isFixedCost: false,
    });
    expect(child.parentId).toBe(parent.id);
  });

  it('BadRequestException при parentId на несуществующего родителя', async () => {
    await expect(
      h.categories.create(seed.workspaceId, {
        name: 'X', kind: 'EXPENSE', parentId: 'no-id', isFixedCost: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('BadRequestException: запрет 3-го уровня (parent уже сам дочерний)', async () => {
    const root = await h.categories.create(seed.workspaceId, {
      name: 'Корень', kind: 'EXPENSE', isFixedCost: false,
    });
    const lvl2 = await h.categories.create(seed.workspaceId, {
      name: 'Уровень2', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    await expect(
      h.categories.create(seed.workspaceId, {
        name: 'Уровень3', kind: 'EXPENSE', parentId: lvl2.id, isFixedCost: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('BadRequestException: подкатегория с kind ≠ kind родителя', async () => {
    const parent = await h.categories.create(seed.workspaceId, {
      name: 'Доходы', kind: 'INCOME', isFixedCost: false,
    });
    await expect(
      h.categories.create(seed.workspaceId, {
        name: 'Несовпад', kind: 'EXPENSE', parentId: parent.id, isFixedCost: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Categories — list (flat)', () => {
  it('сортирует parentId ASC (корни первыми) → name ASC, исключает архивные/удалённые', async () => {
    const root = await h.categories.create(seed.workspaceId, {
      name: 'Зарплата', kind: 'EXPENSE', isFixedCost: false,
    });
    await h.categories.create(seed.workspaceId, {
      name: 'Аренда', kind: 'EXPENSE', isFixedCost: false,
    });
    const child = await h.categories.create(seed.workspaceId, {
      name: 'Премия', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    const arch = await h.categories.create(seed.workspaceId, {
      name: 'Старая', kind: 'EXPENSE', isFixedCost: false,
    });
    await h.categories.update(seed.workspaceId, arch.id, { isArchived: true });

    const flat = await h.categories.list(seed.workspaceId, { includeArchived: false });
    const names = flat.map((c) => c.name);
    // parentId ASC: в Postgres NULL сортируется последним при ASC,
    // поэтому дочерняя (с непустым parentId) идёт перед корнями.
    expect(names).toContain('Аренда');
    expect(names).toContain('Зарплата');
    expect(names).toContain('Премия');
    expect(names).not.toContain('Старая'); // архивная исключена
    // дочерняя «Премия» (parentId != null) раньше корней (parentId null)
    expect(names.indexOf('Премия')).toBeLessThan(names.indexOf('Аренда'));
    // только выбранные поля
    expect(Object.keys(flat[0]!).sort()).toEqual(
      ['bucket', 'id', 'isArchived', 'isFixedCost', 'kind', 'name', 'parentId'].sort(),
    );
    expect(child.parentId).toBe(root.id);
  });

  it('фильтр по kind', async () => {
    await h.categories.create(seed.workspaceId, { name: 'Выручка', kind: 'INCOME', isFixedCost: false });
    await h.categories.create(seed.workspaceId, { name: 'Налог', kind: 'EXPENSE', isFixedCost: false });
    const income = await h.categories.list(seed.workspaceId, { kind: 'INCOME', includeArchived: false });
    expect(income.map((c) => c.name)).toEqual(['Выручка']);
    expect(income.every((c) => c.kind === 'INCOME')).toBe(true);
  });
});

describe('Categories — tree', () => {
  it('строит иерархию parent → children', async () => {
    const root = await h.categories.create(seed.workspaceId, {
      name: 'Операционные', kind: 'EXPENSE', isFixedCost: false,
    });
    await h.categories.create(seed.workspaceId, {
      name: 'Аренда', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    await h.categories.create(seed.workspaceId, {
      name: 'Связь', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });

    const tree = await h.categories.tree(seed.workspaceId, { includeArchived: false });
    const rootNode = tree.find((n) => n.id === root.id);
    expect(rootNode).toBeDefined();
    expect(rootNode!.children.map((c) => c.name).sort()).toEqual(['Аренда', 'Связь']);
  });

  it('orphan → root: если parent заархивирован (отфильтрован), child становится корнем', async () => {
    const root = await h.categories.create(seed.workspaceId, {
      name: 'Корень', kind: 'EXPENSE', isFixedCost: false,
    });
    const child = await h.categories.create(seed.workspaceId, {
      name: 'Дочерняя', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    // архивируем родителя — он выпадает из list/tree при includeArchived=false
    await h.categories.update(seed.workspaceId, root.id, { isArchived: true });

    const tree = await h.categories.tree(seed.workspaceId, { includeArchived: false });
    // родителя в дереве нет, но дочерняя поднялась в корни
    expect(tree.find((n) => n.id === root.id)).toBeUndefined();
    const orphan = tree.find((n) => n.id === child.id);
    expect(orphan).toBeDefined();
    expect(orphan!.children).toEqual([]);
  });
});

describe('Categories — update', () => {
  it('переименование, смена bucket, isFixedCost, архивирование', async () => {
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Старое', kind: 'EXPENSE', bucket: 'OTHER', isFixedCost: false,
    });
    const upd = await h.categories.update(seed.workspaceId, cat.id, {
      name: 'Новое', bucket: 'VARIABLE', isFixedCost: true, isArchived: true,
    });
    expect(upd.name).toBe('Новое');
    expect(upd.bucket).toBe('VARIABLE');
    expect(upd.isFixedCost).toBe(true);
    expect(upd.isArchived).toBe(true);
  });

  it('перемещение корня под другой корень (изменение parentId)', async () => {
    const a = await h.categories.create(seed.workspaceId, { name: 'A', kind: 'EXPENSE', isFixedCost: false });
    const b = await h.categories.create(seed.workspaceId, { name: 'B', kind: 'EXPENSE', isFixedCost: false });
    const moved = await h.categories.update(seed.workspaceId, b.id, { parentId: a.id });
    expect(moved.parentId).toBe(a.id);
  });

  it('сброс parentId в null поднимает категорию в корни', async () => {
    const parent = await h.categories.create(seed.workspaceId, { name: 'P', kind: 'EXPENSE', isFixedCost: false });
    const child = await h.categories.create(seed.workspaceId, {
      name: 'C', kind: 'EXPENSE', parentId: parent.id, isFixedCost: false,
    });
    const upd = await h.categories.update(seed.workspaceId, child.id, { parentId: null });
    expect(upd.parentId).toBeNull();
  });

  it('гвард: категория не может быть родителем самой себя', async () => {
    const cat = await h.categories.create(seed.workspaceId, { name: 'Self', kind: 'EXPENSE', isFixedCost: false });
    await expect(
      h.categories.update(seed.workspaceId, cat.id, { parentId: cat.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: нельзя сделать дочерней категорию, у которой есть свои дети', async () => {
    const root = await h.categories.create(seed.workspaceId, { name: 'Root', kind: 'EXPENSE', isFixedCost: false });
    await h.categories.create(seed.workspaceId, {
      name: 'Kid', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    const other = await h.categories.create(seed.workspaceId, { name: 'Other', kind: 'EXPENSE', isFixedCost: false });
    // root имеет ребёнка → нельзя засунуть его под other (иначе вышел бы 3-й уровень)
    await expect(
      h.categories.update(seed.workspaceId, root.id, { parentId: other.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: нельзя сделать дочерней под нероневой parent (запрет 3 уровней)', async () => {
    const root = await h.categories.create(seed.workspaceId, { name: 'R', kind: 'EXPENSE', isFixedCost: false });
    const mid = await h.categories.create(seed.workspaceId, {
      name: 'M', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    const free = await h.categories.create(seed.workspaceId, { name: 'F', kind: 'EXPENSE', isFixedCost: false });
    await expect(
      h.categories.update(seed.workspaceId, free.id, { parentId: mid.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: parent с другим kind отклоняется', async () => {
    const incomeRoot = await h.categories.create(seed.workspaceId, { name: 'Inc', kind: 'INCOME', isFixedCost: false });
    const expense = await h.categories.create(seed.workspaceId, { name: 'Exp', kind: 'EXPENSE', isFixedCost: false });
    await expect(
      h.categories.update(seed.workspaceId, expense.id, { parentId: incomeRoot.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('NotFoundException при несуществующем id', async () => {
    await expect(
      h.categories.update(seed.workspaceId, 'no-id', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Categories — softDelete', () => {
  it('удаляет лист, скрывает из list, оставляет строку', async () => {
    const cat = await h.categories.create(seed.workspaceId, { name: 'Удаляемая', kind: 'EXPENSE', isFixedCost: false });
    const res = await h.categories.softDelete(seed.workspaceId, cat.id);
    expect(res).toBeUndefined();
    const row = await h.prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.deletedAt).not.toBeNull();
    const list = await h.categories.list(seed.workspaceId, { includeArchived: true });
    expect(list.find((c) => c.id === cat.id)).toBeUndefined();
  });

  it('BadRequestException при удалении категории с активными детьми', async () => {
    const root = await h.categories.create(seed.workspaceId, { name: 'Корень', kind: 'EXPENSE', isFixedCost: false });
    await h.categories.create(seed.workspaceId, {
      name: 'Ребёнок', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    await expect(
      h.categories.softDelete(seed.workspaceId, root.id),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('после удаления ребёнка родителя можно удалить', async () => {
    const root = await h.categories.create(seed.workspaceId, { name: 'Корень', kind: 'EXPENSE', isFixedCost: false });
    const child = await h.categories.create(seed.workspaceId, {
      name: 'Ребёнок', kind: 'EXPENSE', parentId: root.id, isFixedCost: false,
    });
    await h.categories.softDelete(seed.workspaceId, child.id);
    // теперь активных детей нет → удаление родителя проходит
    await expect(h.categories.softDelete(seed.workspaceId, root.id)).resolves.toBeUndefined();
  });

  it('NotFoundException при повторном удалении', async () => {
    const cat = await h.categories.create(seed.workspaceId, { name: 'X', kind: 'EXPENSE', isFixedCost: false });
    await h.categories.softDelete(seed.workspaceId, cat.id);
    await expect(
      h.categories.softDelete(seed.workspaceId, cat.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// COUNTERPARTIES
// ──────────────────────────────────────────────────────────────────────────
describe('Counterparties — create', () => {
  it('создаёт с дефолтной ролью OTHER и null-полями', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, { name: 'Без роли' });
    expect(cp.role).toBe('OTHER');
    expect(cp.contact).toBeNull();
    expect(cp.inn).toBeNull();
    expect(cp.source).toBeNull();
    expect(cp.position).toBeNull();
    expect(cp.payRate).toBeNull();
    expect(cp.isArchived).toBe(false);
  });

  it('SUPPLIER с inn', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, {
      name: 'ООО Поставщик', role: 'SUPPLIER', inn: '7701234567', contact: '+7 999',
    });
    expect(cp.role).toBe('SUPPLIER');
    expect(cp.inn).toBe('7701234567');
    expect(cp.contact).toBe('+7 999');
  });

  it('CLIENT с source (источник привлечения)', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, {
      name: 'Иван', role: 'CLIENT', source: 'Авито',
    });
    expect(cp.role).toBe('CLIENT');
    expect(cp.source).toBe('Авито');
  });

  it('EMPLOYEE с position и payRate (money string → Decimal)', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, {
      name: 'Сотрудник', role: 'EMPLOYEE', position: 'Менеджер', payRate: '50000.00',
    });
    expect(cp.role).toBe('EMPLOYEE');
    expect(cp.position).toBe('Менеджер');
    expect(num(cp.payRate)).toBe(50000);
    const row = await h.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    expect(num(row.payRate)).toBe(50000);
  });
});

describe('Counterparties — list', () => {
  it('по умолчанию исключает архивные/удалённые, сортирует isArchived ASC → name ASC', async () => {
    await h.counterparties.create(seed.workspaceId, { name: 'Борис' });
    await h.counterparties.create(seed.workspaceId, { name: 'Анна' });
    const arch = await h.counterparties.create(seed.workspaceId, { name: 'ААрхив' });
    await h.counterparties.update(seed.workspaceId, arch.id, { isArchived: true });
    const del = await h.counterparties.create(seed.workspaceId, { name: 'Удалённый' });
    await h.counterparties.softDelete(seed.workspaceId, del.id);

    const list = await h.counterparties.list(seed.workspaceId, { includeArchived: false });
    const names = list.map((c) => c.name);
    expect(names).toEqual(['Анна', 'Борис']);
  });

  it('includeArchived=true: архивные после активных, удалённых нет', async () => {
    await h.counterparties.create(seed.workspaceId, { name: 'Актив' });
    const arch = await h.counterparties.create(seed.workspaceId, { name: 'Архив' });
    await h.counterparties.update(seed.workspaceId, arch.id, { isArchived: true });
    const list = await h.counterparties.list(seed.workspaceId, { includeArchived: true });
    expect(list.map((c) => c.name)).toEqual(['Актив', 'Архив']);
  });

  it('фильтр по role', async () => {
    await h.counterparties.create(seed.workspaceId, { name: 'Клиент1', role: 'CLIENT' });
    await h.counterparties.create(seed.workspaceId, { name: 'Постав1', role: 'SUPPLIER' });
    const clients = await h.counterparties.list(seed.workspaceId, { role: 'CLIENT', includeArchived: false });
    expect(clients.map((c) => c.name)).toEqual(['Клиент1']);
    expect(clients.every((c) => c.role === 'CLIENT')).toBe(true);
  });

  it('search: OR по name ИЛИ contact, регистронезависимо', async () => {
    await h.counterparties.create(seed.workspaceId, { name: 'Магазин Ромашка', contact: 'info@x' });
    await h.counterparties.create(seed.workspaceId, { name: 'Прочее', contact: 'Ромашка-сервис' });
    await h.counterparties.create(seed.workspaceId, { name: 'Несвязанный', contact: 'zzz' });

    // ILIKE: совпадение по name ('Магазин Ромашка') ИЛИ по contact ('Прочее' → 'Ромашка-сервис').
    // Поиск в нижнем регистре подтверждает регистронезависимость.
    const found = await h.counterparties.list(seed.workspaceId, { search: 'ромашка', includeArchived: false });
    const names = found.map((c) => c.name).sort();
    expect(names).toEqual(['Магазин Ромашка', 'Прочее']);
    expect(found.find((c) => c.name === 'Несвязанный')).toBeUndefined();
  });

  it('search комбинируется с role (AND)', async () => {
    await h.counterparties.create(seed.workspaceId, { name: 'Альфа', role: 'CLIENT' });
    await h.counterparties.create(seed.workspaceId, { name: 'Альфа', role: 'SUPPLIER' });
    const res = await h.counterparties.list(seed.workspaceId, {
      search: 'альфа', role: 'CLIENT', includeArchived: false,
    });
    expect(res.length).toBe(1);
    expect(res[0]!.role).toBe('CLIENT');
  });
});

describe('Counterparties — update', () => {
  it('смена роли, добавление inn, обновление payRate', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, { name: 'X', role: 'OTHER' });
    const upd = await h.counterparties.update(seed.workspaceId, cp.id, {
      role: 'SUPPLIER', inn: '500100732259', payRate: '777.50',
    });
    expect(upd.role).toBe('SUPPLIER');
    expect(upd.inn).toBe('500100732259');
    expect(num(upd.payRate)).toBe(777.5);
  });

  it('payRate: undefined не меняет, null зануляет, money string обновляет', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, {
      name: 'Emp', role: 'EMPLOYEE', payRate: '100.00',
    });
    // undefined → без изменений
    const u1 = await h.counterparties.update(seed.workspaceId, cp.id, { position: 'Кладовщик' });
    expect(num(u1.payRate)).toBe(100);
    expect(u1.position).toBe('Кладовщик');
    // null → зануление
    const u2 = await h.counterparties.update(seed.workspaceId, cp.id, { payRate: null });
    expect(u2.payRate).toBeNull();
    // money string → новое значение
    const u3 = await h.counterparties.update(seed.workspaceId, cp.id, { payRate: '200.25' });
    expect(num(u3.payRate)).toBe(200.25);
  });

  it('nullable-поля: null зануляет, undefined не трогает', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, {
      name: 'Y', contact: 'c', note: 'n', source: 's',
    });
    const u1 = await h.counterparties.update(seed.workspaceId, cp.id, { contact: null });
    expect(u1.contact).toBeNull();
    expect(u1.note).toBe('n'); // не тронуто
    expect(u1.source).toBe('s'); // не тронуто
  });

  it('NotFoundException при несуществующем id', async () => {
    await expect(
      h.counterparties.update(seed.workspaceId, 'no-id', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Counterparties — softDelete', () => {
  it('проставляет deletedAt, скрывает из list, оставляет строку', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, { name: 'Удаляемый' });
    const res = await h.counterparties.softDelete(seed.workspaceId, cp.id);
    expect(res).toBeUndefined();
    const row = await h.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    expect(row.deletedAt).not.toBeNull();
    const list = await h.counterparties.list(seed.workspaceId, { includeArchived: true });
    expect(list.find((c) => c.id === cp.id)).toBeUndefined();
  });

  it('NotFoundException при повторном удалении', async () => {
    const cp = await h.counterparties.create(seed.workspaceId, { name: 'X' });
    await h.counterparties.softDelete(seed.workspaceId, cp.id);
    await expect(
      h.counterparties.softDelete(seed.workspaceId, cp.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
