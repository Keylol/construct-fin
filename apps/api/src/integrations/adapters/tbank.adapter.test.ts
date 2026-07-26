import { describe, expect, it, vi } from 'vitest';
import { LOOKBACK_DAYS, TbankAdapter, mapOperation } from './tbank.adapter';
import type { BankHttp, BankHttpResponse } from './bank-http';
import type { AdapterRegistry } from '../adapter-registry';

/**
 * Юнит-тесты адаптера Т-Банка (Ф3). Транспорт подменён — сети нет. Основное,
 * что легко сломать незаметно: отсев холдов (Authorization), окно перекрытия
 * курсора (операция доезжает до финального статуса 3–4 дня), курсорная
 * пагинация и знак операции (Credit — приход, Debit — расход).
 */

const BASE = 'https://business.tbank.ru/openapi/sandbox/api';
const ACCOUNT = '40702810510000710417';

function stub(pages: BankHttpResponse[] | ((url: string) => BankHttpResponse)) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  let i = 0;
  const http: BankHttp = {
    configured: true,
    getJson: (url, h) => {
      calls.push(url);
      headers.push(h);
      if (typeof pages === 'function') return Promise.resolve(pages(url));
      return Promise.resolve(pages[i++] ?? { status: 200, body: '{"operations":[]}', headers: {} });
    },
  };
  const registry = { register: vi.fn() } as unknown as AdapterRegistry;
  const adapter = new TbankAdapter(http, { get: vi.fn(() => BASE) } as never, registry);
  return { adapter, calls, headers, registry };
}

const ok = (body: unknown): BankHttpResponse => ({
  status: 200,
  body: JSON.stringify(body),
  headers: {},
});

/** Операция Т-Банка (подтверждённая, приход). */
function op(over: Record<string, unknown> = {}) {
  return {
    operationId: 'op-1',
    operationStatus: 'Transaction',
    operationDate: '2026-07-20T09:15:00Z',
    typeOfOperation: 'Credit',
    payPurpose: 'Оплата по счёту 42. НДС не облагается',
    description: 'Входящий перевод',
    operationAmount: 25000.4,
    accountAmount: 25000.4,
    accountCurrencyDigitalCode: '643',
    rubleAmount: 25000.4,
    counterParty: { name: 'ООО «Клиент»', inn: '7701234567' },
    payer: { name: 'Плательщик из payer', inn: '111' },
    receiver: { name: 'Получатель из receiver', inn: '222' },
    ...over,
  };
}

const base = {
  token: 'tbank-token',
  accountNumber: ACCOUNT,
  connectedAt: new Date('2026-07-01T00:00:00Z'),
};

describe('TbankAdapter — запрос и курсор', () => {
  it('первый синк идёт с даты подключения, просит только подтверждённые операции', async () => {
    const { adapter, calls, headers } = stub([ok({ operations: [op()] })]);
    const res = await adapter.fetchStatement({ ...base, cursor: null });

    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/openapi/sandbox/api/v1/statement');
    expect(url.searchParams.get('accountNumber')).toBe(ACCOUNT);
    expect(url.searchParams.get('from')).toBe('2026-07-01T00:00:00.000Z');
    expect(url.searchParams.get('operationStatus')).toBe('Transaction');
    expect(headers[0]!.Authorization).toBe('Bearer tbank-token');
    expect(headers[0]!['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    // Курсор — дата последней операции.
    expect(res.nextCursor).toBe('2026-07-20T09:15:00.000Z');
  });

  it('повторный синк перезапрашивает окно перекрытия назад от курсора', async () => {
    const { adapter, calls } = stub([ok({ operations: [] })]);
    await adapter.fetchStatement({ ...base, cursor: '2026-07-20T09:15:00.000Z' });

    const from = new Date(new URL(calls[0]!).searchParams.get('from')!);
    const expected = new Date('2026-07-20T09:15:00.000Z').getTime() - LOOKBACK_DAYS * 86400_000;
    expect(from.getTime()).toBe(expected);
  });

  it('пустой ответ не сдвигает курсор (операции ещё могут доехать задним числом)', async () => {
    const { adapter } = stub([ok({ operations: [] })]);
    const res = await adapter.fetchStatement({ ...base, cursor: '2026-07-20T09:15:00.000Z' });
    expect(res.nextCursor).toBe('2026-07-20T09:15:00.000Z');
  });

  it('курсор не откатывается назад, если в окне только старые операции', async () => {
    const { adapter } = stub([ok({ operations: [op({ operationDate: '2026-07-14T10:00:00Z' })] })]);
    const res = await adapter.fetchStatement({ ...base, cursor: '2026-07-20T09:15:00.000Z' });
    expect(res.nextCursor).toBe('2026-07-20T09:15:00.000Z');
  });

  it('битый курсор в БД не роняет синк — начинаем с даты подключения', async () => {
    const { adapter, calls } = stub([ok({ operations: [] })]);
    await adapter.fetchStatement({ ...base, cursor: 'мусор' });
    expect(new URL(calls[0]!).searchParams.get('from')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('без номера счёта — понятная ошибка, в сеть не ходит', async () => {
    const { adapter, calls } = stub([]);
    await expect(
      adapter.fetchStatement({ ...base, accountNumber: null, cursor: null }),
    ).rejects.toThrow(/номера расчётного счёта/);
    expect(calls).toHaveLength(0);
  });
});

describe('TbankAdapter — пагинация и ошибки', () => {
  it('идёт по nextCursor, пока банк его отдаёт', async () => {
    const { adapter, calls } = stub([
      ok({ operations: [op({ operationId: 'a' })], nextCursor: 'CURSOR-2' }),
      ok({ operations: [op({ operationId: 'b' })], nextCursor: null }),
    ]);
    const res = await adapter.fetchStatement({ ...base, cursor: null });

    expect(res.lines.map((l) => l.externalId)).toEqual(['a', 'b']);
    expect(new URL(calls[0]!).searchParams.get('cursor')).toBeNull();
    expect(new URL(calls[1]!).searchParams.get('cursor')).toBe('CURSOR-2');
  });

  it('банк отдаёт тот же nextCursor → цикл останавливается, а не крутится до потолка', async () => {
    // Так ведёт себя песочница: фиксированный ответ с неизменным курсором.
    // Без этой проверки синк делал MAX_PAGES запросов и падал.
    const { adapter, calls } = stub(() => ok({ operations: [op()], nextCursor: 'SAME' }));
    const res = await adapter.fetchStatement({ ...base, cursor: null });
    expect(calls).toHaveLength(2); // первый запрос + один с курсором SAME
    // Та же операция пришла дважды — наружу уходит одна строка.
    expect(res.lines).toHaveLength(1);
  });

  it('пустая страница с курсором → стоп (добирать нечего)', async () => {
    const { adapter, calls } = stub(() => ok({ operations: [], nextCursor: 'NEXT' }));
    await adapter.fetchStatement({ ...base, cursor: null });
    expect(calls).toHaveLength(1);
  });

  it('токен с кириллицей → человеческая ошибка вместо технической, в сеть не идём', async () => {
    const { adapter, calls } = stub([]);
    await expect(
      adapter.fetchStatement({ ...base, token: 'токен-с-кириллицей', cursor: null }),
    ).rejects.toThrow(/недопустимые символы/);
    expect(calls).toHaveLength(0);
  });

  it('ошибка банка → человеческий текст с кодом обращения, без тела ответа', async () => {
    const { adapter } = stub(() => ({
      status: 403,
      body: JSON.stringify({
        errorCode: 'FORBIDDEN',
        errorId: '9d1d8855fa',
        errorDetails: { value: 'внутренние детали банка' },
      }),
      headers: {},
    }));
    await expect(adapter.fetchStatement({ ...base, cursor: null })).rejects.toThrow(
      /права «Счета и выписки».*9d1d8855fa/s,
    );
  });

  it('не-JSON в ответе → внятная ошибка', async () => {
    const { adapter } = stub(() => ({ status: 200, body: '<html>502</html>', headers: {} }));
    await expect(adapter.fetchStatement({ ...base, cursor: null })).rejects.toThrow(
      /не является JSON/,
    );
  });

  it('регистрируется в реестре под TBANK (сертификат не нужен)', () => {
    const { adapter, registry } = stub([]);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('TBANK', adapter);
  });
});

describe('TbankAdapter — маппинг операции', () => {
  it('Credit → приход, контрагент из counterParty, назначение из payPurpose', () => {
    expect(mapOperation(op())).toMatchObject({
      externalId: 'op-1',
      direction: 'INCOME',
      amount: '25000.40',
      counterpartyName: 'ООО «Клиент»',
      counterpartyInn: '7701234567',
      description: 'Оплата по счёту 42. НДС не облагается',
      ausnMark: null,
    });
  });

  it('Debit → расход', () => {
    expect(mapOperation(op({ typeOfOperation: 'Debit' }))?.direction).toBe('EXPENSE');
  });

  it('ХОЛД (Authorization) в учёт не идёт', () => {
    expect(mapOperation(op({ operationStatus: 'Authorization' }))).toBeNull();
  });

  it('без counterParty контрагент берётся по знаку: приход — payer, расход — receiver', () => {
    expect(mapOperation(op({ counterParty: undefined }))?.counterpartyName).toBe(
      'Плательщик из payer',
    );
    expect(
      mapOperation(op({ counterParty: undefined, typeOfOperation: 'Debit' }))?.counterpartyName,
    ).toBe('Получатель из receiver');
  });

  it('валютный счёт учитывается рублёвым эквивалентом', () => {
    const line = mapOperation(
      op({ accountCurrencyDigitalCode: '840', accountAmount: 70, rubleAmount: 6543.21 }),
    );
    expect(line?.amount).toBe('6543.21');
  });

  it('сумма приходит модулем и с двумя знаками', () => {
    expect(mapOperation(op({ accountAmount: -0.1 - 0.2 }))?.amount).toBe('0.30');
  });

  it('нет payPurpose → берём description', () => {
    expect(mapOperation(op({ payPurpose: undefined }))?.description).toBe('Входящий перевод');
  });

  it('операции без id, направления, суммы или с битой датой пропускаются', () => {
    expect(mapOperation(op({ operationId: undefined }))).toBeNull();
    expect(mapOperation(op({ typeOfOperation: 'Unknown' }))).toBeNull();
    expect(
      mapOperation(op({ accountAmount: undefined, operationAmount: undefined })),
    ).toBeNull();
    expect(mapOperation(op({ operationDate: 'не дата' }))).toBeNull();
  });
});
