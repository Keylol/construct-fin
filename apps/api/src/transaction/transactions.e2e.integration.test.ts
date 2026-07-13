/**
 * E2E (DB-backed) сценарии домена «Транзакции + импорт выписки + детект переводов
 * + категоризация». Реальная БД construct_v6_test через buildHarness.
 *
 * Дополняет (augment, не дублирует) существующее покрытие:
 *  - transaction.service.test.ts (unit-моки): здесь — реальный CRUD по данным;
 *  - import-commit.integration.test.ts (дедуп fileHash): здесь — preview-цикл
 *    целиком (дубликаты/категоризация/детект перевода) + skipDuplicates в commit;
 *  - matcher.test.ts / transfer-detect.test.ts (чистое ядро): здесь — применение
 *    правил и детект перевода уже сквозь БД-данные;
 *  - transfer.service.test.ts (UoW-ноги): здесь — гварды create/list/softDelete.
 *
 * Уникальный диапазон telegramId этого файла: 1100000n (+1n в каждом beforeEach).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';
import type { CommitBody, CommitRow } from '../import/import.dto';

const num = (v: unknown): number => Number(String(v));

let h: Harness;
let seed: Seed;
let tg = 1100000n;

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

/** Заводит дополнительный счёт в текущем workspace. */
async function makeAccount(name: string, type: 'CASH' | 'BANK' = 'BANK'): Promise<string> {
  const acc = await h.prisma.account.create({
    data: { workspaceId: seed.workspaceId, name, type },
  });
  return acc.id;
}

/** Заводит категорию через CategoryService. */
async function makeCategory(name: string, kind: 'INCOME' | 'EXPENSE' = 'EXPENSE'): Promise<string> {
  const cat = await h.categories.create(seed.workspaceId, { name, kind, isFixedCost: false });
  return cat.id;
}

/** Заводит контрагента через CounterpartyService. */
async function makeCounterparty(name: string): Promise<string> {
  const cp = await h.counterparties.create(seed.workspaceId, { name });
  return cp.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Создание транзакции вручную
// ─────────────────────────────────────────────────────────────────────────────
describe('Транзакции: создание вручную (TransactionService.create)', () => {
  it('создаёт расход с привязкой к счёту/категории/контрагенту и пишет данные в БД', async () => {
    const catId = await makeCategory('Канцелярия', 'EXPENSE');
    const cpId = await makeCounterparty('ООО Бумага');

    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '1234.56',
      type: 'EXPENSE',
      kind: 'VARIABLE_COST',
      accountId: seed.accountId,
      categoryId: catId,
      counterpartyId: cpId,
      description: 'Бумага А4',
    });

    expect(num(created.amount)).toBe(1234.56);
    const row = await h.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(seed.workspaceId);
    expect(row.createdById).toBe(seed.userId);
    expect(row.kind).toBe('VARIABLE_COST');
    expect(row.categoryId).toBe(catId);
    expect(row.counterpartyId).toBe(cpId);
    expect(num(row.amount)).toBe(1234.56);
    expect(row.deletedAt).toBeNull();
  });

  it('без kind проставляется БД-дефолт OTHER', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '50.00',
      type: 'INCOME',
      accountId: seed.accountId,
    });
    const row = await h.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.kind).toBe('OTHER');
  });

  it('гвард: несуществующий accountId → BadRequest', async () => {
    await expect(
      h.transactions.create(seed.workspaceId, seed.userId, {
        date: '2026-05-10',
        amount: '10.00',
        type: 'EXPENSE',
        accountId: 'acc-not-exist',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: accountId из чужого workspace → BadRequest', async () => {
    const other = await seedBase(h.prisma, tg + 500000n);
    await expect(
      h.transactions.create(seed.workspaceId, seed.userId, {
        date: '2026-05-10',
        amount: '10.00',
        type: 'EXPENSE',
        accountId: other.accountId,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: несуществующая categoryId → BadRequest', async () => {
    await expect(
      h.transactions.create(seed.workspaceId, seed.userId, {
        date: '2026-05-10',
        amount: '10.00',
        type: 'EXPENSE',
        accountId: seed.accountId,
        categoryId: 'cat-not-exist',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: несуществующий counterpartyId → BadRequest', async () => {
    await expect(
      h.transactions.create(seed.workspaceId, seed.userId, {
        date: '2026-05-10',
        amount: '10.00',
        type: 'EXPENSE',
        accountId: seed.accountId,
        counterpartyId: 'cp-not-exist',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Редактирование транзакции
// ─────────────────────────────────────────────────────────────────────────────
describe('Транзакции: редактирование (TransactionService.update)', () => {
  it('частичное обновление суммы/описания + аудит-запись с before/after', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      kind: 'VARIABLE_COST',
      accountId: seed.accountId,
      description: 'старое',
    });

    const updated = await h.transactions.update(
      seed.workspaceId,
      created.id,
      { amount: '250.50', description: 'новое' },
      seed.userId,
    );
    expect(num(updated.amount)).toBe(250.5);
    expect(updated.description).toBe('новое');

    const row = await h.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(num(row.amount)).toBe(250.5);

    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, entityId: created.id, action: 'transaction.update' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(seed.userId);
    const diff = audit?.diff as { before: { amount: string }; changes: { amount?: string } };
    expect(diff.before.amount).toBe('100.00');
    expect(diff.changes.amount).toBe('250.50');
  });

  it('categoryId=null сбрасывает категорию; undefined оставляет текущую', async () => {
    const catId = await makeCategory('Канцелярия', 'EXPENSE');
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      accountId: seed.accountId,
      categoryId: catId,
    });

    // undefined → не трогаем
    await h.transactions.update(seed.workspaceId, created.id, { description: 'x' }, seed.userId);
    let row = await h.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.categoryId).toBe(catId);

    // null → сброс
    await h.transactions.update(seed.workspaceId, created.id, { categoryId: null }, seed.userId);
    row = await h.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.categoryId).toBeNull();
  });

  it('смена type на INCOME при kind, недопустимом для INCOME → BadRequest', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      kind: 'SALARY', // допустим только для EXPENSE
      accountId: seed.accountId,
    });
    await expect(
      h.transactions.update(seed.workspaceId, created.id, { type: 'INCOME' }, seed.userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: системную транзакцию (kind=COGS) редактировать нельзя → BadRequest', async () => {
    // Системную заводим напрямую в БД (через API её создать нельзя).
    const sys = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        createdById: seed.userId,
        date: new Date('2026-05-10'),
        amount: '300.00',
        type: 'EXPENSE',
        kind: 'COGS',
        accountId: seed.accountId,
      },
    });
    await expect(
      h.transactions.update(seed.workspaceId, sys.id, { amount: '1.00' }, seed.userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: несуществующая транзакция → NotFound', async () => {
    await expect(
      h.transactions.update(seed.workspaceId, 'tx-not-exist', { amount: '1.00' }, seed.userId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Список транзакций: фильтры, поиск, курсор-пагинация
// ─────────────────────────────────────────────────────────────────────────────
describe('Транзакции: список с фильтрацией и курсором (TransactionService.list)', () => {
  async function mk(over: {
    date: string;
    amount: string;
    type: 'INCOME' | 'EXPENSE';
    accountId?: string;
    categoryId?: string;
    description?: string;
  }) {
    return h.transactions.create(seed.workspaceId, seed.userId, {
      date: over.date,
      amount: over.amount,
      type: over.type,
      accountId: over.accountId ?? seed.accountId,
      categoryId: over.categoryId,
      description: over.description,
    });
  }

  it('сортирует по date DESC и не показывает удалённые', async () => {
    await mk({ date: '2026-05-01', amount: '10.00', type: 'EXPENSE' });
    const mid = await mk({ date: '2026-05-02', amount: '20.00', type: 'EXPENSE' });
    await mk({ date: '2026-05-03', amount: '30.00', type: 'EXPENSE' });

    await h.transactions.softDelete(seed.workspaceId, mid.id, seed.userId);

    const res = await h.transactions.list(seed.workspaceId, { limit: 50 });
    expect(res.items.map((i) => i.date.slice(0, 10))).toEqual(['2026-05-03', '2026-05-01']);
    expect(res.nextCursor).toBeNull();
  });

  it('фильтр по type + диапазону сумм (minAmount/maxAmount как >=/<=)', async () => {
    await mk({ date: '2026-05-01', amount: '50.00', type: 'EXPENSE' });
    await mk({ date: '2026-05-02', amount: '150.00', type: 'EXPENSE' });
    await mk({ date: '2026-05-03', amount: '500.00', type: 'INCOME' });

    const res = await h.transactions.list(seed.workspaceId, {
      type: 'EXPENSE',
      minAmount: '100.00',
      maxAmount: '200.00',
      limit: 50,
    });
    expect(res.items).toHaveLength(1);
    expect(num(res.items[0]!.amount)).toBe(150);
  });

  it('поиск по описанию case-insensitive', async () => {
    await mk({ date: '2026-05-01', amount: '10.00', type: 'EXPENSE', description: 'Аренда офиса' });
    await mk({ date: '2026-05-02', amount: '20.00', type: 'EXPENSE', description: 'Обед' });

    const res = await h.transactions.list(seed.workspaceId, { search: 'аренда', limit: 50 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.description).toBe('Аренда офиса');
  });

  it('фильтр по accountId изолирует счёт', async () => {
    const bank = await makeAccount('Банк');
    await mk({ date: '2026-05-01', amount: '10.00', type: 'EXPENSE' });
    await mk({ date: '2026-05-02', amount: '99.00', type: 'EXPENSE', accountId: bank });

    const res = await h.transactions.list(seed.workspaceId, { accountId: bank, limit: 50 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.accountId).toBe(bank);
  });

  it('курсор-пагинация: limit=2 над 5 строк отдаёт nextCursor и добирает остаток', async () => {
    for (let d = 1; d <= 5; d++) {
      await mk({ date: `2026-05-0${d}`, amount: `${d}.00`, type: 'EXPENSE' });
    }
    const page1 = await h.transactions.list(seed.workspaceId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items.map((i) => i.date.slice(0, 10))).toEqual(['2026-05-05', '2026-05-04']);

    const page2 = await h.transactions.list(seed.workspaceId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.date.slice(0, 10))).toEqual(['2026-05-03', '2026-05-02']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await h.transactions.list(seed.workspaceId, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((i) => i.date.slice(0, 10))).toEqual(['2026-05-01']);
    expect(page3.nextCursor).toBeNull();
  });
});

describe('Транзакции: bucket-фильтр (drill-down из ОПиУ «По группам»)', () => {
  it('бакет активной категории приоритетнее kind-фолбэка', async () => {
    const fixedCat = await h.categories.create(seed.workspaceId, {
      name: 'Аренда',
      kind: 'EXPENSE',
      isFixedCost: true,
      bucket: 'FIXED',
    });
    // kind=OTHER, но активная категория FIXED → операция строго в бакете FIXED
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01',
      amount: '100.00',
      type: 'EXPENSE',
      kind: 'OTHER',
      accountId: seed.accountId,
      categoryId: fixedCat.id,
      description: 'аренда',
    });

    const fixed = await h.transactions.list(seed.workspaceId, { bucket: 'FIXED', limit: 50 });
    expect(fixed.items.map((i) => i.description)).toEqual(['аренда']);

    const other = await h.transactions.list(seed.workspaceId, { bucket: 'OTHER', limit: 50 });
    expect(other.items).toHaveLength(0);
  });

  it('без категории — фолбэк по kind, как bucketForSystemKind в ОПиУ', async () => {
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01',
      amount: '50.00',
      type: 'EXPENSE',
      kind: 'TAX',
      accountId: seed.accountId,
      description: 'налог',
    });
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-02',
      amount: '70.00',
      type: 'EXPENSE',
      kind: 'SALARY',
      accountId: seed.accountId,
      description: 'зарплата',
    });

    const tax = await h.transactions.list(seed.workspaceId, { bucket: 'TAX', limit: 50 });
    expect(tax.items.map((i) => i.description)).toEqual(['налог']);

    // SALARY → FIXED (зарплата — постоянная операционная статья)
    const fixed = await h.transactions.list(seed.workspaceId, { bucket: 'FIXED', limit: 50 });
    expect(fixed.items.map((i) => i.description)).toEqual(['зарплата']);
  });

  it('soft-deleted категория не считается — операция уходит в kind-фолбэк', async () => {
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Времянка',
      kind: 'EXPENSE',
      isFixedCost: false,
      bucket: 'VARIABLE',
    });
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01',
      amount: '30.00',
      type: 'EXPENSE',
      kind: 'TAX',
      accountId: seed.accountId,
      categoryId: cat.id,
      description: 'налог-времянка',
    });
    await h.categories.softDelete(seed.workspaceId, cat.id);

    const variable = await h.transactions.list(seed.workspaceId, { bucket: 'VARIABLE', limit: 50 });
    expect(variable.items).toHaveLength(0);

    const tax = await h.transactions.list(seed.workspaceId, { bucket: 'TAX', limit: 50 });
    expect(tax.items.map((i) => i.description)).toEqual(['налог-времянка']);
  });

  it('несовместимая пара categoryId+bucket даёт честное пустое пересечение', async () => {
    const fixedCat = await h.categories.create(seed.workspaceId, {
      name: 'Аренда',
      kind: 'EXPENSE',
      isFixedCost: true,
      bucket: 'FIXED',
    });
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01',
      amount: '100.00',
      type: 'EXPENSE',
      accountId: seed.accountId,
      categoryId: fixedCat.id,
      description: 'аренда',
    });

    // Категория из FIXED + bucket=VARIABLE — пересечение пусто (фильтры AND).
    const res = await h.transactions.list(seed.workspaceId, {
      categoryId: fixedCat.id,
      bucket: 'VARIABLE',
      limit: 50,
    });
    expect(res.items).toHaveLength(0);

    // Совместимая пара — строка находится.
    const ok = await h.transactions.list(seed.workspaceId, {
      categoryId: fixedCat.id,
      bucket: 'FIXED',
      limit: 50,
    });
    expect(ok.items.map((i) => i.description)).toEqual(['аренда']);
  });

  it('переводы не попадают ни в один бакет (в т.ч. OTHER), но видны без фильтра', async () => {
    const bank = await makeAccount('Банк-перевод');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: bank,
      amount: '500.00',
      fee: '0',
      date: '2026-05-03',
    });

    const other = await h.transactions.list(seed.workspaceId, { bucket: 'OTHER', limit: 50 });
    expect(other.items).toHaveLength(0);

    // Исключение переводов относится только к drill-down: в общем списке обе ноги видны
    const all = await h.transactions.list(seed.workspaceId, { limit: 50 });
    expect(all.items).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Получение одной транзакции с вложениями
// ─────────────────────────────────────────────────────────────────────────────
describe('Транзакции: getById с вложениями (TransactionService.getById)', () => {
  it('возвращает транзакцию с массивом attachments', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      accountId: seed.accountId,
    });
    await h.prisma.attachment.create({
      data: {
        workspaceId: seed.workspaceId,
        transactionId: created.id,
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        storagePath: 'key/receipt.pdf',
        hash: 'attach-hash-1',
      },
    });

    const got = await h.transactions.getById(seed.workspaceId, created.id);
    expect(got.attachments).toHaveLength(1);
    expect(got.attachments[0]!.filename).toBe('receipt.pdf');
    expect(got.attachments[0]!.size).toBe(2048);
  });

  it('удалённая транзакция → NotFound', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      accountId: seed.accountId,
    });
    await h.transactions.softDelete(seed.workspaceId, created.id, seed.userId);
    await expect(h.transactions.getById(seed.workspaceId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Удаление транзакции (soft-delete)
// ─────────────────────────────────────────────────────────────────────────────
describe('Транзакции: soft-delete (TransactionService.softDelete)', () => {
  it('помечает deletedAt и пишет аудит transaction.delete', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      accountId: seed.accountId,
    });
    await h.transactions.softDelete(seed.workspaceId, created.id, seed.userId);

    const row = await h.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).not.toBeNull();

    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, entityId: created.id, action: 'transaction.delete' },
    });
    expect(audit).not.toBeNull();
  });

  it('повторное удаление уже удалённой → NotFound', async () => {
    const created = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-10',
      amount: '100.00',
      type: 'EXPENSE',
      accountId: seed.accountId,
    });
    await h.transactions.softDelete(seed.workspaceId, created.id, seed.userId);
    await expect(
      h.transactions.softDelete(seed.workspaceId, created.id, seed.userId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('гвард: системную транзакцию (kind=PURCHASE) удалять нельзя → BadRequest', async () => {
    const sys = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        createdById: seed.userId,
        date: new Date('2026-05-10'),
        amount: '300.00',
        type: 'EXPENSE',
        kind: 'PURCHASE',
        accountId: seed.accountId,
      },
    });
    await expect(
      h.transactions.softDelete(seed.workspaceId, sys.id, seed.userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Сводка доходов/расходов
// ─────────────────────────────────────────────────────────────────────────────
describe('Транзакции: summary за период (TransactionService.summary)', () => {
  it('считает income/expense/net, учитывает только активные и фильтрует период', async () => {
    // В периоде
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-05', amount: '1000.00', type: 'INCOME', accountId: seed.accountId,
    });
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-06', amount: '300.00', type: 'EXPENSE', accountId: seed.accountId,
    });
    const toDelete = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-07', amount: '500.00', type: 'EXPENSE', accountId: seed.accountId,
    });
    await h.transactions.softDelete(seed.workspaceId, toDelete.id, seed.userId);
    // Вне периода — не должно попасть
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-06-01', amount: '9999.00', type: 'INCOME', accountId: seed.accountId,
    });

    const s = await h.transactions.summary(seed.workspaceId, { from: '2026-05-01', to: '2026-05-31' });
    expect(s.income).toBe('1000.00');
    expect(s.expense).toBe('300.00');
    expect(s.net).toBe('700.00');
  });

  it('пустой период → нули с 2 знаками', async () => {
    const s = await h.transactions.summary(seed.workspaceId, { from: '2030-01-01', to: '2030-01-31' });
    expect(s.income).toBe('0.00');
    expect(s.expense).toBe('0.00');
    expect(s.net).toBe('0.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Превью импорта: дубликаты + категоризация + детект перевода
// ─────────────────────────────────────────────────────────────────────────────
describe('Импорт: preview полный цикл (ImportService.preview)', () => {
  const CSV =
    'Дата;Сумма;Контрагент;Назначение\n' +
    '01.05.2026;1 234,56;ООО Тест;Тестовый платеж\n' +
    '02.05.2026;-500,00;Магнит;Продукты в офис\n';

  it('парсит CSV, считает stats, вычисляет importHash и резолвит существующего контрагента', async () => {
    // Заранее заведём контрагента «ООО Тест» — должен зарезолвиться (case-insensitive).
    const cpId = await makeCounterparty('ооо тест');

    const res = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: Buffer.from(CSV, 'utf-8'),
      filename: 'statement.csv',
    });

    expect(res.source).toBe('GENERIC_CSV');
    expect(res.stats.total).toBe(2);
    expect(res.stats.valid).toBe(2);
    expect(res.stats.invalid).toBe(0);
    expect(res.rows).toHaveLength(2);

    const income = res.rows.find((r) => r.type === 'INCOME')!;
    expect(num(income.amount)).toBe(1234.56);
    expect(income.resolvedCounterpartyId).toBe(cpId);
    expect(income.importHash).toMatch(/^[0-9a-f]{64}$/);

    const expense = res.rows.find((r) => r.type === 'EXPENSE')!;
    expect(income.importHash).not.toBe(expense.importHash);
    expect(expense.resolvedCounterpartyId).toBeNull(); // Магнит не заведён
  });

  it('помечает дубликат: строка с importHash уже импортированной активной транзакции', async () => {
    // Сначала превью → берём importHash расходной строки и создаём такую транзакцию.
    const pre = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: Buffer.from(CSV, 'utf-8'),
      filename: 'statement.csv',
    });
    const expenseHash = pre.rows.find((r) => r.type === 'EXPENSE')!.importHash;
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        createdById: seed.userId,
        date: new Date('2026-05-02'),
        amount: '500.00',
        type: 'EXPENSE',
        accountId: seed.accountId,
        importHash: expenseHash,
      },
    });

    const res = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: Buffer.from(CSV, 'utf-8'),
      filename: 'statement.csv',
    });
    expect(res.stats.duplicates).toBe(1);
    expect(res.rows.find((r) => r.type === 'EXPENSE')!.isDuplicate).toBe(true);
    expect(res.rows.find((r) => r.type === 'INCOME')!.isDuplicate).toBe(false);
  });

  it('применяет активное правило категоризации (по подстроке description/counterparty)', async () => {
    const foodCat = await makeCategory('Продукты', 'EXPENSE');
    // Импорт теперь берёт подсказку из движка Rule (не CategoryRule): условие
    // DESCRIPTION_CONTAINS → действие SET_CATEGORY, appliesTo=IMPORT.
    await h.prisma.rule.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'продукты',
        priority: 10,
        isActive: true,
        appliesTo: 'IMPORT',
        conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'продукты' }],
        actions: [{ type: 'SET_CATEGORY', categoryId: foodCat }],
      },
    });

    const res = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: Buffer.from(CSV, 'utf-8'),
      filename: 'statement.csv',
    });
    const expense = res.rows.find((r) => r.type === 'EXPENSE')!; // «Продукты в офис»
    expect(expense.suggestedCategoryId).toBe(foodCat);
    const income = res.rows.find((r) => r.type === 'INCOME')!;
    expect(income.suggestedCategoryId).toBeNull();
  });

  it('детект перевода: контр-нога на другом счёте (противоположный type, та же сумма, дата в окне)', async () => {
    const bank = await makeAccount('Банк');
    // Существующая EXPENSE 1234.56 на банке 30.04 → контр-нога для импортируемого
    // INCOME 1234.56 от 01.05 (разница 1 день, в окне ±3).
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        createdById: seed.userId,
        date: new Date('2026-04-30'),
        amount: '1234.56',
        type: 'EXPENSE',
        accountId: bank,
      },
    });

    const res = await h.importSvc.preview({
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      buffer: Buffer.from(CSV, 'utf-8'),
      filename: 'statement.csv',
    });
    const income = res.rows.find((r) => r.type === 'INCOME')!;
    expect(income.transferSuggestion).not.toBeNull();
    expect(income.transferSuggestion!.otherAccountId).toBe(bank);
    expect(income.transferSuggestion!.matchedType).toBe('EXPENSE');
    expect(income.transferSuggestion!.daysDiff).toBe(1);
    // Расходная строка не имеет пары (нет INCOME 500 на другом счёте).
    expect(res.rows.find((r) => r.type === 'EXPENSE')!.transferSuggestion).toBeNull();
  });

  it('гвард: accountId из чужого/несуществующего счёта → NotFound', async () => {
    await expect(
      h.importSvc.preview({
        workspaceId: seed.workspaceId,
        accountId: 'acc-not-exist',
        buffer: Buffer.from(CSV, 'utf-8'),
        filename: 'statement.csv',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('TINKOFF_PDF парсер не реализован → BadRequest', async () => {
    await expect(
      h.importSvc.preview({
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        buffer: Buffer.from('whatever'),
        filename: 'tinkoff.pdf',
        source: 'TINKOFF_PDF',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Коммит импорта: создание транзакций/контрагентов + skipDuplicates
// ─────────────────────────────────────────────────────────────────────────────
describe('Импорт: commit с данными (ImportService.commit)', () => {
  function row(over: Partial<CommitRow>): CommitRow {
    return {
      date: '2026-05-01',
      amount: '100.00',
      type: 'EXPENSE',
      description: 'обед',
      counterpartyName: null,
      categoryId: null,
      importHash: `h-${Math.random()}`,
      isDuplicate: false,
      ...over,
    };
  }
  function body(over: Partial<CommitBody> = {}): CommitBody {
    return {
      filename: 'statement.csv',
      fileHash: `file-${Math.random()}`,
      source: 'GENERIC_CSV',
      accountId: seed.accountId,
      skipDuplicates: true,
      rows: [row({})],
      ...over,
    };
  }

  it('создаёт транзакции с importBatchId/importHash и новых контрагентов', async () => {
    const res = await h.importSvc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        rows: [
          row({ amount: '100.00', type: 'EXPENSE', counterpartyName: 'Новый Поставщик', importHash: 'c-1' }),
          row({ amount: '200.00', type: 'INCOME', counterpartyName: 'Новый Поставщик', importHash: 'c-2' }),
        ],
      }),
    });
    expect(res.imported).toBe(2);
    expect(res.skipped).toBe(0);

    // Контрагент создан один (дедуп по имени).
    const cps = await h.prisma.counterparty.findMany({
      where: { workspaceId: seed.workspaceId, name: 'Новый Поставщик' },
    });
    expect(cps).toHaveLength(1);

    const txs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, importBatchId: res.batchId },
    });
    expect(txs).toHaveLength(2);
    for (const t of txs) {
      expect(t.counterpartyId).toBe(cps[0]!.id);
      expect(t.importBatchId).toBe(res.batchId);
      expect(t.createdById).toBe(seed.userId);
      expect(t.importHash).toMatch(/^c-/);
    }

    // Батч хранит счётчики.
    const batch = await h.prisma.importBatch.findUniqueOrThrow({ where: { id: res.batchId } });
    expect(batch.rowsTotal).toBe(2);
    expect(batch.rowsImported).toBe(2);
    expect(batch.rowsSkipped).toBe(0);
  });

  it('переиспользует существующего контрагента (case-insensitive), не плодит дублей', async () => {
    await makeCounterparty('ООО Ромашка');
    const res = await h.importSvc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({ rows: [row({ counterpartyName: 'ооо ромашка', importHash: 'ci-1' })] }),
    });
    expect(res.imported).toBe(1);
    const cps = await h.prisma.counterparty.findMany({
      where: { workspaceId: seed.workspaceId, name: { contains: 'омашка', mode: 'insensitive' } },
    });
    expect(cps).toHaveLength(1);
    const tx = await h.prisma.transaction.findFirstOrThrow({ where: { importBatchId: res.batchId } });
    expect(tx.counterpartyId).toBe(cps[0]!.id);
  });

  it('skipDuplicates=true отфильтровывает isDuplicate строки', async () => {
    const res = await h.importSvc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        rows: [
          row({ importHash: 'k-1', isDuplicate: false }),
          row({ importHash: 'k-2', isDuplicate: true }),
        ],
      }),
    });
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
    const txs = await h.prisma.transaction.findMany({ where: { importBatchId: res.batchId } });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.importHash).toBe('k-1');
  });

  it('skipDuplicates=true и все строки — дубликаты → BadRequest (Nothing to import)', async () => {
    await expect(
      h.importSvc.commit({
        workspaceId: seed.workspaceId,
        userId: seed.userId,
        body: body({ rows: [row({ importHash: 'd-1', isDuplicate: true })] }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('повторный fileHash → Conflict (атомарно, ничего не вставлено)', async () => {
    const fh = 'dup-file-hash';
    await h.importSvc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({ fileHash: fh, rows: [row({ importHash: 'first' })] }),
    });
    await expect(
      h.importSvc.commit({
        workspaceId: seed.workspaceId,
        userId: seed.userId,
        body: body({ fileHash: fh, rows: [row({ importHash: 'second' })] }),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const batches = await h.prisma.importBatch.findMany({ where: { workspaceId: seed.workspaceId, fileHash: fh } });
    expect(batches).toHaveLength(1);
  });

  it('гвард: accountId несуществующий → NotFound', async () => {
    await expect(
      h.importSvc.commit({
        workspaceId: seed.workspaceId,
        userId: seed.userId,
        body: body({ accountId: 'acc-not-exist' }),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Список импортированных батчей
// ─────────────────────────────────────────────────────────────────────────────
describe('Импорт: listBatches (ImportService.listBatches)', () => {
  it('отдаёт батчи по createdAt DESC с данными пользователя; показывает deletedAt', async () => {
    const first = await h.importSvc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: {
        filename: 'a.csv', fileHash: 'fh-a', source: 'GENERIC_CSV', accountId: seed.accountId,
        skipDuplicates: true,
        rows: [{ date: '2026-05-01', amount: '10.00', type: 'EXPENSE', description: 'a', counterpartyName: null, categoryId: null, importHash: 'a-1', isDuplicate: false }],
      },
    });
    await h.importSvc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: {
        filename: 'b.csv', fileHash: 'fh-b', source: 'GENERIC_CSV', accountId: seed.accountId,
        skipDuplicates: true,
        rows: [{ date: '2026-05-02', amount: '20.00', type: 'EXPENSE', description: 'b', counterpartyName: null, categoryId: null, importHash: 'b-1', isDuplicate: false }],
      },
    });
    // soft-delete первого — должен остаться в списке с deletedAt.
    await h.prisma.importBatch.update({ where: { id: first.batchId }, data: { deletedAt: new Date() } });

    const list = await h.importSvc.listBatches(seed.workspaceId);
    expect(list).toHaveLength(2);
    // createdAt DESC → b раньше в массиве (создан позже).
    expect(list[0]!.filename).toBe('b.csv');
    expect(list[1]!.filename).toBe('a.csv');
    expect(list[1]!.deletedAt).not.toBeNull();
    expect(list[0]!.user.firstName).toBe('Test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Переводы между счётами: create/list/softDelete
// ─────────────────────────────────────────────────────────────────────────────
describe('Переводы (TransferService)', () => {
  it('create: Transfer + 2 ноги TRANSFER_OUT/IN с общим transferGroupId, без комиссии', async () => {
    const bank = await makeAccount('Банк');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: bank,
      amount: '1000.00',
      fee: '0',
      date: '2026-05-10',
      note: 'касса→банк',
    });
    expect(num(t.amount)).toBe(1000);
    expect(num(t.fee)).toBe(0);

    const legs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, transferGroupId: t.id },
      orderBy: { kind: 'asc' },
    });
    expect(legs).toHaveLength(2);
    const out = legs.find((l) => l.kind === 'TRANSFER_OUT')!;
    const inc = legs.find((l) => l.kind === 'TRANSFER_IN')!;
    expect(out.accountId).toBe(seed.accountId);
    expect(out.type).toBe('EXPENSE');
    expect(inc.accountId).toBe(bank);
    expect(inc.type).toBe('INCOME');
    expect(num(out.amount)).toBe(1000);
    expect(num(inc.amount)).toBe(1000);
  });

  it('create с комиссией: третья транзакция VARIABLE_COST на счёте-источнике', async () => {
    const bank = await makeAccount('Банк');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: bank,
      amount: '1000.00',
      fee: '15.50',
      date: '2026-05-10',
    });
    expect(num(t.fee)).toBe(15.5);

    const legs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, transferGroupId: t.id },
    });
    expect(legs).toHaveLength(3);
    const feeTx = legs.find((l) => l.kind === 'VARIABLE_COST')!;
    expect(feeTx.accountId).toBe(seed.accountId);
    expect(feeTx.type).toBe('EXPENSE');
    expect(num(feeTx.amount)).toBe(15.5);
  });

  it('гвард: amount<=0 → BadRequest', async () => {
    const bank = await makeAccount('Банк');
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId, toAccountId: bank, amount: '0', fee: '0', date: '2026-05-10',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: отрицательная комиссия → BadRequest', async () => {
    const bank = await makeAccount('Банк');
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId, toAccountId: bank, amount: '100.00', fee: '-1.00', date: '2026-05-10',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('гвард: счёт из чужого workspace → BadRequest', async () => {
    const other = await seedBase(h.prisma, tg + 700000n);
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId, toAccountId: other.accountId, amount: '100.00', fee: '0', date: '2026-05-10',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list: только активные, сортировка date DESC', async () => {
    const bank = await makeAccount('Банк');
    const t1 = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId, toAccountId: bank, amount: '100.00', fee: '0', date: '2026-05-01',
    });
    const t2 = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId, toAccountId: bank, amount: '200.00', fee: '0', date: '2026-05-05',
    });
    const list = await h.transfer.list(seed.workspaceId);
    expect(list.map((x) => x.id)).toEqual([t2.id, t1.id]);
  });

  it('softDelete: гасит Transfer и все его транзакции (ноги + комиссия) каскадом', async () => {
    const bank = await makeAccount('Банк');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId, toAccountId: bank, amount: '1000.00', fee: '10.00', date: '2026-05-10',
    });
    await h.transfer.softDelete(seed.workspaceId, t.id);

    const transfer = await h.prisma.transfer.findUniqueOrThrow({ where: { id: t.id } });
    expect(transfer.deletedAt).not.toBeNull();

    const active = await h.prisma.transaction.findMany({
      where: { transferGroupId: t.id, deletedAt: null },
    });
    expect(active).toHaveLength(0);
    const all = await h.prisma.transaction.findMany({ where: { transferGroupId: t.id } });
    expect(all).toHaveLength(3);
    expect(all.every((x) => x.deletedAt !== null)).toBe(true);

    // list больше не показывает.
    expect((await h.transfer.list(seed.workspaceId)).map((x) => x.id)).not.toContain(t.id);
  });

  it('softDelete несуществующего → NotFound', async () => {
    await expect(h.transfer.softDelete(seed.workspaceId, 'transfer-not-exist')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
