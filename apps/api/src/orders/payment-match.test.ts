import { describe, it, expect } from 'vitest';
import { rankPaymentCandidates } from '@construct/shared';

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
