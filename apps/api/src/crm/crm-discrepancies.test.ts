import { describe, it, expect } from 'vitest';
import {
  buildDiscrepancies,
  SYNC_STALE_MINUTES,
  type DiscrepancyKey,
  type SnapshotDeal,
  type SnapshotOrder,
} from './crm-discrepancies';

/**
 * Проверки «что потерялось между CRM и учётом» на случаях с прода 20.09.2026.
 */

const NOW = new Date('2026-09-20T12:00:00.000Z');
const SINCE = new Date('2026-07-01T00:00:00.000Z');
const opts = { since: SINCE, now: NOW };

const order = (over: Partial<SnapshotOrder> = {}): SnapshotOrder => ({
  id: 'o1',
  number: 'ORD-2026-0001',
  status: 'OPEN',
  totalAmount: '150198.84',
  paidAmount: '150198.84',
  clientName: 'Донгак Алдын-Херел',
  createdAt: new Date('2026-09-15T00:00:00.000Z'),
  hasDeal: true,
  ...over,
});

const deal = (over: Partial<SnapshotDeal> = {}): SnapshotDeal => ({
  id: 'd1',
  externalId: 52085551,
  name: 'Донгак Алдын-Херел (Р)',
  statusName: 'Успешно реализовано',
  price: '150198.00',
  isWon: true,
  isClosed: true,
  dismissedAt: null,
  remoteClosedAt: new Date('2026-09-18T00:00:00.000Z'),
  remoteUpdatedAt: new Date('2026-09-18T00:00:00.000Z'),
  order: null,
  ...over,
});

const live = {
  status: 'ACTIVE',
  lastSyncAt: new Date(NOW.getTime() - 5 * 60_000),
  lastSyncError: null,
};
const find = (checks: ReturnType<typeof buildDiscrepancies>, key: DiscrepancyKey) =>
  checks.find((c) => c.key === key)!;

describe('buildDiscrepancies', () => {
  it('выигранная сделка без заказа — красная проверка с суммой', () => {
    const checks = buildDiscrepancies([deal()], [], live, opts);
    const check = find(checks, 'won_without_order');
    expect(check).toMatchObject({ count: 1, sum: '150198.00', tone: 'destructive' });
    expect(check.items[0]).toMatchObject({ externalId: 52085551, amount: '150198.00' });
  });

  it('старые продажи до начала учёта в расхождения не попадают', () => {
    const old = deal({ remoteClosedAt: new Date('2026-02-10T00:00:00.000Z') });
    expect(find(buildDiscrepancies([old], [], live, opts), 'won_without_order').count).toBe(0);
  });

  it('сделка «не учитывать» молчит во всех проверках', () => {
    const dismissed = deal({ dismissedAt: NOW });
    expect(find(buildDiscrepancies([dismissed], [], live, opts), 'won_without_order').count).toBe(
      0,
    );
  });

  it('выиграна, а заказ недоплачен — в проверке сумма долга, а не заказа', () => {
    const d = deal({ order: order({ paidAmount: '100000.00', totalAmount: '150198.84' }) });
    const check = find(buildDiscrepancies([d], [], live, opts), 'won_unpaid');
    expect(check).toMatchObject({ count: 1, sum: '50198.84', tone: 'destructive' });
    expect(check.items[0]).toMatchObject({ orderNumber: 'ORD-2026-0001' });
  });

  it('недоплата в пределах рубля долгом не считается', () => {
    const d = deal({ order: order({ paidAmount: '150198.00', totalAmount: '150198.84' }) });
    expect(find(buildDiscrepancies([d], [], live, opts), 'won_unpaid').count).toBe(0);
  });

  it('заказ закрыт, а сделка в работе — жёлтая проверка', () => {
    const d = deal({
      isWon: false,
      isClosed: false,
      statusName: 'Отправлен',
      order: order({ status: 'DONE' }),
    });
    const check = find(buildDiscrepancies([d], [], live, opts), 'order_done_deal_open');
    expect(check).toMatchObject({ count: 1, tone: 'warning' });
    expect(check.items[0]).toMatchObject({ dealStatus: 'Отправлен', orderNumber: 'ORD-2026-0001' });
  });

  it('расхождение сумм: копейки не считаются, тысячи считаются', () => {
    const cents = deal({ order: order({ totalAmount: '150198.84' }), price: '150198.00' });
    expect(find(buildDiscrepancies([cents], [], live, opts), 'sum_mismatch').count).toBe(0);

    const thousands = deal({ order: order({ totalAmount: '350128.65' }), price: '357128.00' });
    const check = find(buildDiscrepancies([thousands], [], live, opts), 'sum_mismatch');
    expect(check).toMatchObject({ count: 1, sum: '6999.35' });
  });

  it('заказ без сделки — кроме отменённых и старых', () => {
    const orders = [
      order({ id: 'o-new', number: 'ORD-2026-0100', hasDeal: false }),
      order({ id: 'o-cancelled', number: 'ORD-2026-0101', hasDeal: false, status: 'CANCELLED' }),
      order({
        id: 'o-old',
        number: 'ORD-2026-0001',
        hasDeal: false,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ];
    const check = find(buildDiscrepancies([], orders, live, opts), 'order_without_deal');
    expect(check.count).toBe(1);
    expect(check.items[0]!.orderNumber).toBe('ORD-2026-0100');
  });

  it('молчащий синк: нет подключения, ошибка или давняя синхронизация', () => {
    expect(find(buildDiscrepancies([], [], null, opts), 'sync_stale').tone).toBe('destructive');
    expect(
      find(buildDiscrepancies([], [], { ...live, status: 'ERROR' }, opts), 'sync_stale').count,
    ).toBe(1);
    const stale = {
      ...live,
      lastSyncAt: new Date(NOW.getTime() - (SYNC_STALE_MINUTES + 1) * 60_000),
    };
    expect(find(buildDiscrepancies([], [], stale, opts), 'sync_stale').count).toBe(1);
    expect(find(buildDiscrepancies([], [], live, opts), 'sync_stale')).toMatchObject({
      count: 0,
      tone: 'ok',
    });
  });

  it('всё сошлось — проверки зелёные и пустые', () => {
    const d = deal({ order: order({ status: 'DONE' }), isWon: true, isClosed: true });
    const checks = buildDiscrepancies([d], [order({ status: 'DONE' })], live, opts);
    expect(checks.every((c) => c.tone === 'ok' && c.count === 0)).toBe(true);
  });
});
