import { describe, expect, it } from 'vitest';
import { D } from '../common/money';
import { resolvePaymentState } from './order.service';

/**
 * Unit-тесты чистого правила статуса оплаты (#10). syncPaymentState делегирует
 * сюда; динамика total>0 (UNPAID→PARTIAL→PAID→OVERPAID) дополнительно покрыта
 * money-flows.integration.test.ts.
 */
describe('resolvePaymentState (#10)', () => {
  it('total=0, paid=0 → PAID (платить нечего; раньше ошибочно был UNPAID)', () => {
    expect(resolvePaymentState(D(0), D(0))).toBe('PAID');
  });

  it('total=0, paid>0 → OVERPAID (переплата по нулевому заказу → причитается возврат)', () => {
    expect(resolvePaymentState(D('10.00'), D(0))).toBe('OVERPAID');
  });

  it('total=0, paid<0 → REFUNDED', () => {
    expect(resolvePaymentState(D('-5.00'), D(0))).toBe('REFUNDED');
  });

  it('total>0, paid=0 → UNPAID', () => {
    expect(resolvePaymentState(D(0), D('100.00'))).toBe('UNPAID');
  });

  it('total>0, 0<paid<total → PARTIAL', () => {
    expect(resolvePaymentState(D('40.00'), D('100.00'))).toBe('PARTIAL');
  });

  it('total>0, paid=total → PAID', () => {
    expect(resolvePaymentState(D('100.00'), D('100.00'))).toBe('PAID');
  });

  it('total>0, paid>total → OVERPAID', () => {
    expect(resolvePaymentState(D('150.00'), D('100.00'))).toBe('OVERPAID');
  });

  it('total>0, paid<0 → REFUNDED', () => {
    expect(resolvePaymentState(D('-1.00'), D('100.00'))).toBe('REFUNDED');
  });
});
