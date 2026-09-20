import { describe, it, expect } from 'vitest';
import { cashCompositionText } from './cash-composition';

/**
 * Состав кассы: итог складывается из счёта с синком, нала, личных карт и
 * счетов-корзин без выписки. Последние сидят в минусе — без разбивки итог
 * выглядит меньше банковского остатка, и цифре перестают верить.
 */
describe('cashCompositionText', () => {
  it('перечисляет все части, минус — в скобках', () => {
    const out = cashCompositionText({
      bank: '767561.32',
      cash: '35000.00',
      cards: '1914.20',
      negative: '-645294.00',
      negativeCount: 2,
    });
    expect(out).toContain('банк');
    expect(out).toContain('нал');
    expect(out).toContain('карты');
    expect(out).toContain('счета без выписки');
    expect(out).toContain('(');
  });

  it('пустые части не печатает', () => {
    const out = cashCompositionText({
      bank: '100000.00',
      cash: '0.00',
      cards: '0.00',
      negative: '-5000.00',
      negativeCount: 1,
    });
    expect(out).not.toContain('нал');
    expect(out).not.toContain('карты');
    expect(out).toContain('банк');
    expect(out).toContain('счета без выписки');
  });

  it('на одной части строка бессмысленна — null', () => {
    expect(
      cashCompositionText({
        bank: '100000.00',
        cash: '0.00',
        cards: '0.00',
        negative: '0.00',
        negativeCount: 0,
      }),
    ).toBeNull();
  });

  it('без данных — null', () => {
    expect(cashCompositionText(null)).toBeNull();
  });
});
