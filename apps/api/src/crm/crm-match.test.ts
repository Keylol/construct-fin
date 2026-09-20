import { describe, it, expect } from 'vitest';
import {
  matchDealsToOrders,
  matchLinesToDeals,
  type MatchDeal,
  type MatchOrder,
} from './crm-match';

/**
 * Правила подбора «сделка ↔ заказ» на образцах с прода: телефон и сумма —
 * железно; один телефон — под вопросом (повторный заказ); сумма и имя —
 * когда телефона нет ни у кого.
 */

const day = (d: number) => new Date(2026, 8, d);

const deal = (over: Partial<MatchDeal> & Pick<MatchDeal, 'id'>): MatchDeal => ({
  price: '148156.00',
  phone: '+79243634029',
  contactName: 'Габалова Елена Геннадиевна',
  name: 'Габалова Елена Геннадиевна (Р)',
  remoteCreatedAt: day(10),
  ...over,
});

const order = (over: Partial<MatchOrder> & Pick<MatchOrder, 'id'>): MatchOrder => ({
  phone: '+79243634029',
  totalAmount: '148156.00',
  clientName: 'Габалова Елена Геннадиевна',
  createdAt: day(12),
  ...over,
});

describe('matchDealsToOrders', () => {
  it('телефон и сумма — пара отмечена по умолчанию', () => {
    const pairs = matchDealsToOrders([deal({ id: 'd1' })], [order({ id: 'o1' })]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      dealId: 'd1',
      orderId: 'o1',
      reason: 'phone_and_sum',
      confident: true,
    });
  });

  it('тот же телефон, другая сумма — пара предложена, но не отмечена', () => {
    const pairs = matchDealsToOrders(
      [deal({ id: 'd1', price: '99000.00' })],
      [order({ id: 'o1' })],
    );
    expect(pairs[0]).toMatchObject({ reason: 'phone', confident: false });
  });

  it('телефона нет ни у кого: сумма и имя (с «ё» и двойными пробелами) — пара с галочкой', () => {
    // Владелец 20.09.2026 привязал все такие пары вручную и подтвердил: это те же
    // продажи, просто в сделке не заполнен телефон. Поэтому отмечаются сразу.
    const pairs = matchDealsToOrders(
      [deal({ id: 'd1', phone: null, contactName: 'Алёна  Петрова', name: 'Алёна Петрова (С)' })],
      [order({ id: 'o1', phone: null, clientName: 'Алена Петрова' })],
    );
    expect(pairs[0]).toMatchObject({ reason: 'name_and_sum', confident: true });
  });

  it('только сумма и близкая дата — самое слабое правило; далёкая дата пары не даёт', () => {
    const near = matchDealsToOrders(
      [deal({ id: 'd1', phone: null, contactName: null, name: 'Заявка с квиза' })],
      [order({ id: 'o1', phone: null, clientName: 'Совсем другой человек' })],
    );
    expect(near[0]).toMatchObject({ reason: 'sum_and_date', confident: false, daysApart: 2 });

    const far = matchDealsToOrders(
      [
        deal({
          id: 'd1',
          phone: null,
          contactName: null,
          name: 'Заявка с квиза',
          remoteCreatedAt: day(1),
        }),
      ],
      [order({ id: 'o1', phone: null, clientName: 'Другой', createdAt: new Date(2026, 9, 20) })],
    );
    expect(far).toEqual([]);
  });

  it('повторный заказ клиента: сильная пара забирает сделку, слабая не дублируется', () => {
    // Два заказа одного телефона: на 148 156 (сумма сделки) и на 99 000.
    const pairs = matchDealsToOrders(
      [deal({ id: 'd1' })],
      [order({ id: 'o-other', totalAmount: '99000.00' }), order({ id: 'o-exact' })],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ orderId: 'o-exact', reason: 'phone_and_sum' });
  });

  it('одна сделка — один заказ: две сделки не садятся на один заказ', () => {
    const pairs = matchDealsToOrders(
      [deal({ id: 'd1', remoteCreatedAt: day(12) }), deal({ id: 'd2', remoteCreatedAt: day(1) })],
      [order({ id: 'o1' })],
    );
    expect(pairs).toHaveLength(1);
    // Побеждает сделка с датой ближе к дате заказа.
    expect(pairs[0]!.dealId).toBe('d1');
  });

  it('ФИО с пометкой «(Р)» вплотную и копейки в заказе — та же продажа', () => {
    // Случай с прода 20.09.2026: «Копылов Владимир Алексеевич(Р)» и заказ с копейками.
    const pairs = matchDealsToOrders(
      [
        deal({
          id: 'd1',
          phone: null,
          contactName: 'Virus',
          name: 'Копылов Владимир Алексеевич(Р)',
          price: '273666.00',
        }),
      ],
      [
        order({
          id: 'o1',
          phone: null,
          clientName: 'Копылов Владимир Алексеевич',
          totalAmount: '273666.84',
        }),
      ],
    );
    expect(pairs[0]).toMatchObject({ reason: 'name_and_sum', confident: true });
  });

  it('имя в середине названия сделки («В чате Константин/ Семёнова…»)', () => {
    const pairs = matchDealsToOrders(
      [
        deal({
          id: 'd1',
          phone: null,
          contactName: 'Mr.Legendus',
          name: 'В чате Константин/ Семёнова Татьяна Викторовна(Р)',
          price: '123884.00',
        }),
      ],
      [
        order({
          id: 'o1',
          phone: null,
          clientName: 'Семёнова Татьяна Викторовна',
          totalAmount: '123884.40',
        }),
      ],
    );
    expect(pairs[0]).toMatchObject({ reason: 'name_and_sum', confident: true });
  });

  it('имя сошлось, а сумма разошлась на тысячи — пара показывается без галочки', () => {
    const pairs = matchDealsToOrders(
      [
        deal({
          id: 'd1',
          phone: null,
          contactName: null,
          name: 'Рябов Владимир Андреевич(Р)',
          price: '357128.00',
        }),
      ],
      [
        order({
          id: 'o1',
          phone: null,
          clientName: 'Рябов Владимир Андреевич',
          totalAmount: '350128.65',
        }),
      ],
    );
    expect(pairs[0]).toMatchObject({ reason: 'name', confident: false });
  });

  it('одного имени без фамилии мало: «Александр» не склеивает чужие продажи', () => {
    const pairs = matchDealsToOrders(
      [
        deal({
          id: 'd1',
          phone: null,
          contactName: 'Александр',
          name: 'Александр',
          price: '99000.00',
        }),
      ],
      [
        order({
          id: 'o1',
          phone: null,
          clientName: 'Александр',
          totalAmount: '99000.00',
          createdAt: new Date(2026, 8, 12),
        }),
      ],
    );
    // Совпали только сумма и близкая дата — самое слабое правило, без галочки.
    expect(pairs[0]).toMatchObject({ reason: 'sum_and_date', confident: false });
  });

  it('ничего общего — пар нет', () => {
    const pairs = matchDealsToOrders(
      [
        deal({
          id: 'd1',
          phone: '+79990000000',
          price: '1.00',
          contactName: 'Кто-то',
          name: 'Кто-то',
        }),
      ],
      [order({ id: 'o1' })],
    );
    expect(pairs).toEqual([]);
  });
});

describe('matchLinesToDeals — приход из банка и сделка', () => {
  it('копейки банка против целых рублей amo — пара с разницей', () => {
    // Донгак на проде: платёж 150 198,25 и сделка на 150 198.
    const pairs = matchLinesToDeals(
      [{ id: 'l1', amount: '150198.25', date: day(19) }],
      [deal({ id: 'd1', price: '150198.00' })],
    );
    expect(pairs).toEqual([{ lineId: 'l1', dealId: 'd1', diff: 0.25 }]);
  });

  it('расхождение больше рубля парой не считается', () => {
    const pairs = matchLinesToDeals(
      [{ id: 'l1', amount: '150200.00', date: day(19) }],
      [deal({ id: 'd1', price: '150198.00' })],
    );
    expect(pairs).toEqual([]);
  });

  it('две сделки на одну сумму: берётся ближайшая по дате к платежу', () => {
    const pairs = matchLinesToDeals(
      [{ id: 'l1', amount: '150198.25', date: day(19) }],
      [
        deal({ id: 'far', price: '150198.00', remoteCreatedAt: day(1) }),
        deal({ id: 'near', price: '150198.00', remoteCreatedAt: day(18) }),
      ],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.dealId).toBe('near');
  });

  it('одна сделка — одна строка: доплата второй строкой не подхватывается', () => {
    const pairs = matchLinesToDeals(
      [
        { id: 'l1', amount: '150198.25', date: day(19) },
        { id: 'l2', amount: '150198.00', date: day(20) },
      ],
      [deal({ id: 'd1', price: '150198.00' })],
    );
    expect(pairs).toHaveLength(1);
    // Точное совпадение выигрывает у копеечного.
    expect(pairs[0]!.lineId).toBe('l2');
  });
});
