import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { deriveOpening } from './balance-anchor.service';

/**
 * Формула якоря: начальный остаток = остаток по источнику − движения до него.
 * Всё в Decimal — копейки не теряются.
 */
const D = (v: string) => new Prisma.Decimal(v);

describe('deriveOpening', () => {
  it('остаток банка минус чистое движение строк', () => {
    // FakeBank: +15000 −250 −8000 −1200.50 = 5549.50; банк говорит 20000.
    expect(deriveOpening(D('20000.00'), D('5549.50')).toFixed(2)).toBe('14450.50');
  });

  it('движение может быть отрицательным (расходов больше приходов)', () => {
    expect(deriveOpening(D('-1301331.94'), D('-4000000.00')).toFixed(2)).toBe('2698668.06');
  });

  it('без движений начальный остаток равен якорю', () => {
    expect(deriveOpening(D('170000.00'), D('0')).toFixed(2)).toBe('170000.00');
  });

  it('округляет до копеек half-up', () => {
    expect(deriveOpening(D('100.005'), D('0')).toFixed(2)).toBe('100.01');
  });
});
