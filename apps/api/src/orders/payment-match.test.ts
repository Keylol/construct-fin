import { describe, it, expect } from 'vitest';
import { attachEffect, rankOrderCandidates, rankPaymentCandidates } from '@construct/shared';

const order = {
  remaining: '152506.00',
  clientName: 'Касьянов Илья Сергеевич',
  title: 'ПК CONSTRUCTPC (AMD Ryzen 7 9800X3D; RTX 5080)',
};

describe('подбор оплаты к заказу', () => {
  it('точная сумма — первый кандидат', () => {
    const ranked = rankPaymentCandidates(
      [
        { id: 'a', amount: '90000.00', description: 'Возм. по согл. в СБП' },
        { id: 'b', amount: '152506.00', description: 'Перевод' },
      ],
      order,
    );
    expect(ranked[0]?.line.id).toBe('b');
    expect(ranked[0]?.reasons).toContain('сумма равна остатку по заказу');
  });

  it('торговое возмещение: нетто + удержанная комиссия дают остаток', () => {
    // Строка на 147 668,50 — суммы клиента в выписке нет вовсе, поиск по
    // «152 506» пуст: банк удержал 4 837,50 внутри возмещения.
    const ranked = rankPaymentCandidates(
      [
        {
          id: 'acq',
          amount: '147668.50',
          description:
            'Возм 667302152487 17.10.2025 ИП КАМЕНСКИЙ ИЛЬЯ ЮРЬЕ Р.09072026 К.4837.50 в т.ч. НДС 872.34',
        },
      ],
      order,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.reasons[0]).toContain('4837.50');
  });

  it('клиент в назначении поднимает строку, даже когда сумма другая', () => {
    const ranked = rankPaymentCandidates(
      [
        { id: 'x', amount: '5000.00', description: 'Оплата за услуги' },
        {
          id: 'credit',
          amount: '138394.60',
          counterpartyName: 'ООО «Кредитные Системы»',
          description: 'Согласно договору 56650/26 (КАСЬЯНОВ ИЛЬЯ СЕРГЕЕВИЧ, КБ «Ренессанс Кредит»)',
        },
      ],
      order,
    );
    expect(ranked.map((r) => r.line.id)).toEqual(['credit']);
    expect(ranked[0]?.reasons).toContain('клиент упомянут в строке');
  });

  it('конфиг сборки из названия заказа ловится в назначении', () => {
    const ranked = rankPaymentCandidates(
      [{ id: 'sbp', amount: '70000.00', description: 'от RB ПК CONSTRUCTPC (Ryzen 7 9800X3D; RTX 5080)' }],
      order,
    );
    expect(ranked[0]?.reasons.some((r) => r.includes('constructpc'))).toBe(true);
  });

  it('строки без единого признака не показываются', () => {
    const ranked = rankPaymentCandidates(
      [
        { id: 'noise1', amount: '1200.00', description: 'Комиссия за обслуживание счёта' },
        { id: 'noise2', amount: '43729.00', description: 'ДНС Ритейл, закупка' },
      ],
      order,
    );
    expect(ranked).toEqual([]);
  });

  it('совпадение и по сумме, и по клиенту вперёд одного признака', () => {
    const ranked = rankPaymentCandidates(
      [
        { id: 'sum-only', amount: '152506.00', description: 'Перевод по счёту' },
        { id: 'both', amount: '152506.00', description: 'Оплата, Касьянов Илья' },
      ],
      order,
    );
    expect(ranked.map((r) => r.line.id)).toEqual(['both', 'sum-only']);
  });

  it('короткое слово названия не тянет за собой всю выписку', () => {
    // «ПК» и «7» встречаются в любой строке — по ним подсказывать нельзя.
    const ranked = rankPaymentCandidates(
      [{ id: 'junk', amount: '999.00', description: 'ПК 7 оплата за интернет' }],
      order,
    );
    expect(ranked).toEqual([]);
  });

  it('Ё в фамилии не мешает совпадению', () => {
    const ranked = rankPaymentCandidates(
      [{ id: 'e', amount: '1000.00', counterpartyName: 'ЕРЁМИН ПАВЕЛ' }],
      { remaining: '5000.00', clientName: 'Еремин Павел Игоревич' },
    );
    expect(ranked).toHaveLength(1);
  });

  it('знак суммы не важен — сравнивается модуль', () => {
    const ranked = rankPaymentCandidates([{ id: 'neg', amount: '-152506.00' }], order);
    expect(ranked[0]?.reasons).toContain('сумма равна остатку по заказу');
  });
});

describe('совпадение по имени — только целые слова', () => {
  it('«Александровна» не считается совпадением с клиентом «Александр»', () => {
    // Живой случай: платёж Чуркиной Светланы Александровны предлагался к заказу
    // Макарова Александра Сергеевича только из-за общей подстроки.
    const ranked = rankPaymentCandidates(
      [
        {
          id: 'chur',
          amount: '132653.92',
          counterpartyName: 'Чуркина Светлана Александровна',
          description: 'Оплата счёт 8 от 11.08.26. БЕЗ НДС',
        },
      ],
      { remaining: '119737.63', clientName: 'Макаров Александр Сергеевич' },
    );
    expect(ranked).toEqual([]);
  });

  it('точное совпадение фамилии по-прежнему ловится', () => {
    const ranked = rankPaymentCandidates(
      [{ id: 'mak', amount: '85000.00', counterpartyName: 'МАКАРОВ АЛЕКСАНДР СЕРГЕЕВИЧ' }],
      { remaining: '119737.63', clientName: 'Макаров Александр Сергеевич' },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.reasons).toContain('клиент упомянут в строке');
  });
})

describe('эффект привязки строки к заказу', () => {
  it('строка меньше остатка: недобор, можно предложить рассрочку', () => {
    const e = attachEffect({ lineAmount: '80000.00', remaining: '226585.00' });
    expect(e.credited).toBe('80000.00');
    expect(e.shortfall).toBe('146585.00');
    expect(e.overpay).toBe('0.00');
    expect(e.canInstallment).toBe(true);
  });

  it('строка ровно на остаток: заказ закрывается без остатков', () => {
    const e = attachEffect({ lineAmount: '152506.00', remaining: '152506.00' });
    expect(e.credited).toBe('152506.00');
    expect(e.shortfall).toBe('0.00');
    expect(e.overpay).toBe('0.00');
    expect(e.canInstallment).toBe(false);
  });

  it('строка больше остатка: переплата (случай Савтикова)', () => {
    const e = attachEffect({ lineAmount: '59737.63', remaining: '30000.00' });
    expect(e.overpay).toBe('29737.63');
    expect(e.shortfall).toBe('0.00');
    expect(e.canInstallment).toBe(false);
  });

  it('торговое возмещение: зачитывается брутто, комиссия видна отдельно', () => {
    const e = attachEffect({
      lineAmount: '147668.50',
      remaining: '152506.00',
      description:
        'Возм 667302152487 17.10.2025 ИП КАМЕНСКИЙ ИЛЬЯ ЮРЬЕ Р.09072026 К.4837.50 в т.ч. НДС 872.34',
    });
    expect(e.fee).toBe('4837.50');
    expect(e.credited).toBe('152506.00');
    expect(e.shortfall).toBe('0.00');
    // Комиссия уже объясняет разрыв — рассрочку к такой строке сервер не примет.
    expect(e.canInstallment).toBe(false);
  });

  it('эквайринг с переплатой: брутто больше остатка', () => {
    const e = attachEffect({
      lineAmount: '147668.50',
      remaining: '100000.00',
      description: 'Возм 667302152487 Р.09072026 К.4837.50',
    });
    expect(e.credited).toBe('152506.00');
    expect(e.overpay).toBe('52506.00');
  });

  it('рассрочка: в заказ идёт весь остаток, недобора не остаётся', () => {
    const e = attachEffect({
      lineAmount: '413398.18',
      remaining: '438394.60',
      installment: true,
    });
    expect(e.credited).toBe('438394.60');
    expect(e.shortfall).toBe('0.00');
    expect(e.overpay).toBe('0.00');
  });

  it('знак строки не важен: сравнивается модуль суммы', () => {
    const e = attachEffect({ lineAmount: '-50000.00', remaining: '50000.00' });
    expect(e.credited).toBe('50000.00');
    expect(e.overpay).toBe('0.00');
  });
});

describe('rankOrderCandidates (подбор заказа под строку выписки)', () => {
  const line = {
    id: 'l1',
    amount: '152506.00',
    description: 'Перевод по СБП от МАКАРОВ ИВАН ПЕТРОВИЧ',
    counterpartyName: null,
  };

  it('заказ с точным остатком идёт первым, чужой не предлагается вовсе', () => {
    const ranked = rankOrderCandidates(
      [
        { id: 'o1', number: 'ORD-1', remaining: '152506.00', clientName: 'Макаров Иван' },
        { id: 'o2', number: 'ORD-2', remaining: '99000.00', clientName: 'Петров Пётр' },
      ],
      line,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.order.number).toBe('ORD-1');
    expect(ranked[0]?.reasons).toContain('сумма равна остатку по заказу');
    expect(ranked[0]?.reasons).toContain('клиент упомянут в строке');
  });

  it('совпадение только по имени тоже попадает в подсказку, но ниже точной суммы', () => {
    const ranked = rankOrderCandidates(
      [
        { id: 'o1', number: 'ORD-1', remaining: '10000.00', clientName: 'Макаров Иван' },
        { id: 'o2', number: 'ORD-2', remaining: '152506.00', clientName: 'Сидоров Пётр' },
      ],
      line,
    );
    expect(ranked.map((r) => r.order.number)).toEqual(['ORD-2', 'ORD-1']);
  });

  it('оба направления подбора считают одну и ту же пару одинаково', () => {
    const order = { id: 'o1', number: 'ORD-1', remaining: '152506.00', clientName: 'Макаров Иван' };
    const forward = rankPaymentCandidates([line], order);
    const backward = rankOrderCandidates([order], line);
    expect(backward[0]?.score).toBe(forward[0]?.score);
    expect(backward[0]?.reasons).toEqual(forward[0]?.reasons);
  });
});
