import { describe, expect, it } from 'vitest';
import { CreatePurchaseSchema } from './purchase.dto';

/**
 * Unit-тесты валидации закупки (#11): qty и unitPrice обязаны быть строго > 0 —
 * нулевая закупка бессмысленна и портит WAVG/себестоимость.
 */
describe('CreatePurchaseSchema (#11)', () => {
  const base = {
    accountId: 'cln1aaaaaaaaaaaaaaaaaaaaa',
    lines: [
      {
        warehouseItemId: 'cln2bbbbbbbbbbbbbbbbbbbbb',
        qty: '5',
        unitPrice: '100.00',
      },
    ],
  };

  it('принимает валидную позицию с qty>0 и unitPrice>0', () => {
    const parsed = CreatePurchaseSchema.parse(base);
    expect(parsed.lines[0]!.qty).toBe('5');
    expect(parsed.lines[0]!.unitPrice).toBe('100.00');
  });

  it('отклоняет qty=0', () => {
    expect(() =>
      CreatePurchaseSchema.parse({
        ...base,
        lines: [{ ...base.lines[0]!, qty: '0' }],
      }),
    ).toThrow();
  });

  it('отклоняет qty=0.000', () => {
    expect(() =>
      CreatePurchaseSchema.parse({
        ...base,
        lines: [{ ...base.lines[0]!, qty: '0.000' }],
      }),
    ).toThrow();
  });

  it('отклоняет unitPrice=0', () => {
    expect(() =>
      CreatePurchaseSchema.parse({
        ...base,
        lines: [{ ...base.lines[0]!, unitPrice: '0' }],
      }),
    ).toThrow();
  });

  it('отклоняет unitPrice=0.0000', () => {
    expect(() =>
      CreatePurchaseSchema.parse({
        ...base,
        lines: [{ ...base.lines[0]!, unitPrice: '0.0000' }],
      }),
    ).toThrow();
  });
});
