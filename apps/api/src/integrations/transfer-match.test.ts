import { describe, it, expect } from 'vitest';
import { matchTransferPairs, type MatchLine } from './transfer-match';

const A = 'acc-alfa';
const B = 'acc-tbank';

function line(over: Partial<MatchLine> & Pick<MatchLine, 'id' | 'direction'>): MatchLine {
  return {
    accountId: over.direction === 'EXPENSE' ? A : B,
    date: new Date('2026-07-10T00:00:00.000Z'),
    amount: '100000.00',
    ...over,
  };
}

describe('подбор пар «расход ↔ приход» для перевода между своими счетами', () => {
  it('точное совпадение сумм на разных счетах в пределах окна', () => {
    const pairs = matchTransferPairs([
      line({ id: 'out', direction: 'EXPENSE' }),
      line({ id: 'in', direction: 'INCOME', date: new Date('2026-07-11T00:00:00.000Z') }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.out.id).toBe('out');
    expect(pairs[0]!.in.id).toBe('in');
    expect(pairs[0]!.fee).toBe('0');
    expect(pairs[0]!.confidence).toBe('exact');
  });

  it('расход больше прихода на комиссию — разница уходит в fee', () => {
    const pairs = matchTransferPairs([
      line({ id: 'out', direction: 'EXPENSE', amount: '100300.00' }),
      line({ id: 'in', direction: 'INCOME', amount: '100000.00' }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.fee).toBe('300.00');
    expect(pairs[0]!.confidence).toBe('with_fee');
  });

  it('слишком большая разница — это не комиссия, а две разные операции', () => {
    // 8% от суммы: столько банк за перевод между своими счетами не берёт.
    expect(
      matchTransferPairs([
        line({ id: 'out', direction: 'EXPENSE', amount: '108000.00' }),
        line({ id: 'in', direction: 'INCOME', amount: '100000.00' }),
      ]),
    ).toEqual([]);
    // Доля укладывается в 1%, но абсолютная величина запредельна для комиссии.
    expect(
      matchTransferPairs([
        line({ id: 'out', direction: 'EXPENSE', amount: '1000000.00' }),
        line({ id: 'in', direction: 'INCOME', amount: '994000.00' }),
      ]),
    ).toEqual([]);
  });

  it('пришло больше, чем ушло — не перевод', () => {
    expect(
      matchTransferPairs([
        line({ id: 'out', direction: 'EXPENSE', amount: '100000.00' }),
        line({ id: 'in', direction: 'INCOME', amount: '100500.00' }),
      ]),
    ).toEqual([]);
  });

  it('движение внутри одного счёта переводом не считается', () => {
    expect(
      matchTransferPairs([
        line({ id: 'out', direction: 'EXPENSE', accountId: A }),
        line({ id: 'in', direction: 'INCOME', accountId: A }),
      ]),
    ).toEqual([]);
  });

  it('за пределами окна пара не собирается', () => {
    expect(
      matchTransferPairs([
        line({ id: 'out', direction: 'EXPENSE' }),
        line({ id: 'in', direction: 'INCOME', date: new Date('2026-07-20T00:00:00.000Z') }),
      ]),
    ).toEqual([]);
  });

  it('одна строка входит максимум в одну пару', () => {
    // Два одинаковых прихода на один расход: пара должна быть ровно одна.
    const pairs = matchTransferPairs([
      line({ id: 'out', direction: 'EXPENSE' }),
      line({ id: 'in-1', direction: 'INCOME', date: new Date('2026-07-10T00:00:00.000Z') }),
      line({ id: 'in-2', direction: 'INCOME', date: new Date('2026-07-11T00:00:00.000Z') }),
    ]);
    expect(pairs).toHaveLength(1);
    // Выбран ближайший по дате.
    expect(pairs[0]!.in.id).toBe('in-1');
  });

  it('точное совпадение забирает строку раньше, чем совпадение с комиссией', () => {
    const pairs = matchTransferPairs([
      // Этот расход подходит обоим приходам: точно к in-exact, с комиссией к in-fee.
      line({ id: 'out', direction: 'EXPENSE', amount: '100000.00' }),
      line({ id: 'in-fee', direction: 'INCOME', amount: '99800.00' }),
      line({ id: 'in-exact', direction: 'INCOME', amount: '100000.00' }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.in.id).toBe('in-exact');
    expect(pairs[0]!.fee).toBe('0');
  });

  it('две независимые пары разбираются по пересечению сумм, а не «все со всеми»', () => {
    const pairs = matchTransferPairs([
      line({ id: 'out-1', direction: 'EXPENSE', amount: '50000.00' }),
      line({ id: 'out-2', direction: 'EXPENSE', amount: '70000.00' }),
      line({ id: 'in-1', direction: 'INCOME', amount: '50000.00' }),
      line({ id: 'in-2', direction: 'INCOME', amount: '70000.00' }),
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => `${p.out.id}→${p.in.id}`).sort()).toEqual([
      'out-1→in-1',
      'out-2→in-2',
    ]);
  });

  it('нечего сопоставлять — пустой результат', () => {
    expect(matchTransferPairs([])).toEqual([]);
    expect(matchTransferPairs([line({ id: 'out', direction: 'EXPENSE' })])).toEqual([]);
  });
});
