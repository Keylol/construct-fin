import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseSearchQuery } from '@construct/shared';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { findSearchIds } from './text-search';
import { counterpartySearchSpec } from '../counterparty/counterparty.search';

/**
 * Общий поиск на живой базе — то, что без Postgres не проверить: «ё» против «е»
 * в обе стороны, регистр кириллицы, `%` и `_` из запроса как буквы, телефон по
 * цифрам в любой записи и несколько слов из разных полей.
 */
let h: Harness;
let seed: Seed;
let tg = 3910000n;

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

function party(name: string, extra: { contact?: string; inn?: string; note?: string } = {}) {
  return h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role: 'CLIENT', ...extra },
  });
}

async function find(q: string): Promise<string[]> {
  const parsed = parseSearchQuery(q);
  if (!parsed) return [];
  return findSearchIds(h.prisma, counterpartySearchSpec(seed.workspaceId), parsed);
}

describe('поиск на базе: текст', () => {
  it('«ё» и «е», верхний и нижний регистр находят друг друга в обе стороны', async () => {
    const semenov = await party('Семёнов Пётр');
    const elka = await party('ЁЛКА ООО');

    expect(await find('семенов')).toEqual([semenov.id]);
    expect(await find('СЕМЁНОВ петр')).toEqual([semenov.id]);
    expect(await find('елка')).toEqual([elka.id]);
    expect(await find('ёлка')).toEqual([elka.id]);
  });

  it('% и _ из запроса — буквы, а не маски', async () => {
    const percent = await party('Скидка', { note: 'скидка 50% постоянному' });
    await party('Другой', { note: 'скидка 500 рублей' });
    const underscore = await party('a_b');
    await party('axb');

    expect(await find('50%')).toEqual([percent.id]);
    expect(await find('a_b')).toEqual([underscore.id]);
  });

  it('несколько слов: совпасть должно каждое — хоть в разных полях', async () => {
    const ivanov = await party('Иванов', { note: 'аренда склада' });
    await party('Иванова', { note: 'доставка' });

    expect(await find('иванов аренда')).toEqual([ivanov.id]);
    expect(await find('иванов ремонт')).toEqual([]);
  });
});

describe('поиск на базе: цифры', () => {
  it('телефон из контакта находится в любой записи — с 8 и с +7', async () => {
    const client = await party('Клиент', { contact: '8 (912) 345-67-89' });
    await party('Сосед', { contact: '+7 900 000-00-00' });

    for (const q of ['+7 912 345', '89123456789', '912-345', '8 912 345 67 89']) {
      expect(await find(q), q).toEqual([client.id]);
    }
  });

  it('ИНН — по части цифр', async () => {
    const supplier = await party('ООО Поставщик', { inn: '7701234567' });
    await party('ООО Другое', { inn: '5501234567' });

    expect(await find('770123')).toEqual([supplier.id]);
  });
});
