import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { money, toMoneyString, add, sub, mul, qty, cost } from './money';

/**
 * Блок E: деньги округляются ПОЛОВИНКА-ВВЕРХ (ROUND_HALF_UP) единообразно.
 * money.ts при импорте закрепляет режим Decimal — этот guard ловит регресс
 * (смена дефолта Prisma/decimal.js сломала бы бесхелперные .toFixed(2) по коду).
 */
describe('money: режим округления закреплён (half-up)', () => {
  it('Prisma.Decimal.rounding === ROUND_HALF_UP после импорта money.ts', () => {
    expect(Prisma.Decimal.rounding).toBe(Prisma.Decimal.ROUND_HALF_UP);
  });

  it('голый .toFixed(2) округляет half-up (как money())', () => {
    for (const v of ['0.125', '0.135', '2.005', '0.005', '1.005']) {
      expect(new Prisma.Decimal(v).toFixed(2)).toBe(toMoneyString(v));
    }
  });

  it('отрицательные половинки — half-up по модулю', () => {
    expect(toMoneyString('-0.125')).toBe('-0.13');
    expect(new Prisma.Decimal('-0.125').toFixed(2)).toBe('-0.13');
  });
});

describe('money: хелперы', () => {
  it('money/toMoneyString — 2 знака', () => {
    expect(money('10').toFixed(2)).toBe('10.00');
    expect(toMoneyString('10.1')).toBe('10.10');
  });

  it('add/sub/mul держат полную точность (округление — на выходе)', () => {
    // 0.1 + 0.2 без float-погрешности
    expect(add('0.1', '0.2').toFixed(2)).toBe('0.30');
    expect(sub('0.30', '0.1').toFixed(2)).toBe('0.20');
    expect(mul('0.1', '3').toFixed(2)).toBe('0.30');
  });

  it('qty — 3 знака, cost — 4 знака (half-up)', () => {
    expect(qty('1.2345').toFixed(3)).toBe('1.235');
    expect(cost('1.23455').toFixed(4)).toBe('1.2346');
  });
});
