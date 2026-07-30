import { describe, it, expect } from 'vitest';
import { matchPlannedPayments, type PlannedMatchLine, type PlannedMatchPlan } from './planned-match';

function line(over: Partial<PlannedMatchLine> & Pick<PlannedMatchLine, 'id'>): PlannedMatchLine {
  return {
    date: new Date('2026-08-05T00:00:00.000Z'),
    amount: '45000.00',
    counterpartyInn: null,
    ...over,
  };
}

function plan(over: Partial<PlannedMatchPlan> & Pick<PlannedMatchPlan, 'id'>): PlannedMatchPlan {
  return {
    dueDate: new Date('2026-08-05T00:00:00.000Z'),
    amount: '45000.00',
    counterpartyInn: null,
    ...over,
  };
}

describe('сопоставление строк выписки с плановыми платежами', () => {
  it('точная сумма в окне вокруг срока — пара найдена', () => {
    const out = matchPlannedPayments(
      [line({ id: 'l1', date: new Date('2026-08-08T00:00:00.000Z') })],
      [plan({ id: 'p1' })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.plan.id).toBe('p1');
  });

  it('другая сумма или выход за окно — пары нет', () => {
    expect(
      matchPlannedPayments([line({ id: 'l1', amount: '44999.99' })], [plan({ id: 'p1' })]),
    ).toEqual([]);
    expect(
      matchPlannedPayments(
        [line({ id: 'l1', date: new Date('2026-08-20T00:00:00.000Z') })],
        [plan({ id: 'p1' })],
      ),
    ).toEqual([]);
  });

  it('несовпадение ИНН (оба известны) исключает пару', () => {
    expect(
      matchPlannedPayments(
        [line({ id: 'l1', counterpartyInn: '7701234567' })],
        [plan({ id: 'p1', counterpartyInn: '7736050003' })],
      ),
    ).toEqual([]);
    // Одна из сторон без ИНН — сумма и дата решают.
    expect(
      matchPlannedPayments(
        [line({ id: 'l1', counterpartyInn: '7701234567' })],
        [plan({ id: 'p1' })],
      ),
    ).toHaveLength(1);
  });

  it('совпадение ИНН перевешивает близость даты', () => {
    const out = matchPlannedPayments(
      [line({ id: 'l1', counterpartyInn: '7701234567' })],
      [
        // Ближе к сроку, но контрагент неизвестен.
        plan({ id: 'p-near' }),
        // Дальше по сроку, зато ИНН совпал.
        plan({
          id: 'p-inn',
          dueDate: new Date('2026-08-12T00:00:00.000Z'),
          counterpartyInn: '7701 234 567',
        }),
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.plan.id).toBe('p-inn');
  });

  it('один план не достаётся двум строкам: выигрывает ближняя к сроку', () => {
    const out = matchPlannedPayments(
      [
        line({ id: 'l-far', date: new Date('2026-08-10T00:00:00.000Z') }),
        line({ id: 'l-near', date: new Date('2026-08-05T12:00:00.000Z') }),
      ],
      [plan({ id: 'p1' })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.line.id).toBe('l-near');
  });

  it('две независимые пары расходятся по суммам, а не «все со всеми»', () => {
    const out = matchPlannedPayments(
      [
        line({ id: 'l-rent', amount: '45000.00' }),
        line({ id: 'l-net', amount: '1200.00' }),
      ],
      [
        plan({ id: 'p-rent', amount: '45000.00' }),
        plan({ id: 'p-net', amount: '1200.00' }),
      ],
    );
    expect(out.map((s) => `${s.line.id}→${s.plan.id}`).sort()).toEqual([
      'l-net→p-net',
      'l-rent→p-rent',
    ]);
  });

  it('пустые входы — пустой результат', () => {
    expect(matchPlannedPayments([], [plan({ id: 'p1' })])).toEqual([]);
    expect(matchPlannedPayments([line({ id: 'l1' })], [])).toEqual([]);
  });
});
