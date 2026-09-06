import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlfaAdapter, MAX_DAYS_PER_SYNC, dayKey, nextDay, prevDay, pickBalance } from './alfa.adapter';
import type { AlfaHttp, AlfaHttpResponse } from './alfa-transport';
import type { AdapterRegistry } from '../adapter-registry';

/**
 * Юнит-тесты адаптера Альфы (Ф2). Сеть и mTLS не поднимаются: транспорт
 * подменён объектом, который отвечает по карте «день → тело ответа» и пишет
 * запрошенные URL. Проверяем то, что легко сломать незаметно: цикл по
 * календарным дням (банк отдаёт ровно один день за запрос), поведение курсора,
 * маппинг знака/контрагента и деньги без float.
 */

const BASE = 'https://sandbox.alfabank.ru/api/jp';
const ACCOUNT = '40802810401300015422';

/** Транспорт-заглушка: возвращает заранее заданные тела, копит вызовы. */
function stubHttp(bodies: Record<string, unknown> | ((url: string) => AlfaHttpResponse)) {
  const calls: string[] = [];
  const http: AlfaHttp = {
    configured: true,
    getJson: (url) => {
      calls.push(url);
      if (typeof bodies === 'function') return Promise.resolve(bodies(url));
      const day = new URL(url).searchParams.get('statementDate') ?? '';
      const body = bodies[day] ?? { transactions: [] };
      return Promise.resolve({ status: 200, body: JSON.stringify(body), headers: {} });
    },
  };
  return { http, calls };
}

function build(bodies: Parameters<typeof stubHttp>[0]) {
  const { http, calls } = stubHttp(bodies);
  const config = {
    get: vi.fn((k: string) => (k === 'ALFA_API_BASE_URL' ? BASE : undefined)),
  };
  const registry = { register: vi.fn() } as unknown as AdapterRegistry;
  return { adapter: new AlfaAdapter(http, config as never, registry), calls, registry };
}

/** Операция в формате Альфы (рублёвый перевод). */
function tx(over: Record<string, unknown> = {}) {
  return {
    transactionId: 'tx-1',
    direction: 'CREDIT',
    operationDate: '2026-07-20T00:00:00Z',
    paymentPurpose: 'Оплата по счёту 14',
    amount: { amount: 15000.5, currencyName: 'RUR' },
    rurTransfer: {
      payerName: 'ООО «Ромашка»',
      payerInn: '7701234567',
      payeeName: 'ИП Антропов',
      payeeInn: '667100000000',
    },
    ...over,
  };
}

describe('AlfaAdapter — цикл по дням и курсор', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-07-22 09:00 UTC = тот же день в поясе бизнеса (UTC+5).
    vi.setSystemTime(new Date('2026-07-22T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('первый синк идёт с даты подключения по сегодня, по одному дню на запрос', async () => {
    const { adapter, calls } = build({});
    const res = await adapter.fetchStatement({
      token: 'key',
      cursor: null,
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-20T10:00:00Z'),
    });

    const days = calls.map((u) => new URL(u).searchParams.get('statementDate'));
    expect(days).toEqual(['2026-07-20', '2026-07-21', '2026-07-22']);
    // Сегодняшний день ещё пополняется — курсор встаёт на последний закрытый.
    expect(res.nextCursor).toBe('2026-07-21');
  });

  it('backfillFrom перекрывает дату подключения — тянем историю глубже', async () => {
    const { adapter, calls } = build({});
    const res = await adapter.fetchStatement({
      token: 'key',
      cursor: null,
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-20T10:00:00Z'),
      // Перезалив: просим с 1 июля, хотя подключение создано 20-го.
      backfillFrom: new Date('2026-07-01T00:00:00Z'),
    });

    const days = calls.map((u) => new URL(u).searchParams.get('statementDate'));
    expect(days[0]).toBe('2026-07-01');
    expect(days).toHaveLength(22); // 01…22 июля
    expect(res.nextCursor).toBe('2026-07-21');
  });

  it('повторный синк начинается со дня ПОСЛЕ курсора', async () => {
    const { adapter, calls } = build({});
    await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(calls.map((u) => new URL(u).searchParams.get('statementDate'))).toEqual(['2026-07-22']);
  });

  it('за синк берёт не больше MAX_DAYS_PER_SYNC дней, курсор двигается', async () => {
    const { adapter, calls } = build({});
    const res = await adapter.fetchStatement({
      token: 'key',
      cursor: null,
      accountNumber: ACCOUNT,
      connectedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(calls).toHaveLength(MAX_DAYS_PER_SYNC);
    expect(res.nextCursor).toBe('2025-01-31');
  });

  it('глубина истории клампится: не ранее 1 января (текущий год − 5)', async () => {
    const { adapter, calls } = build({});
    await adapter.fetchStatement({
      token: 'key',
      cursor: null,
      accountNumber: ACCOUNT,
      connectedAt: new Date('2015-06-01T00:00:00Z'),
    });
    expect(new URL(calls[0]!).searchParams.get('statementDate')).toBe('2021-01-01');
  });

  it('без номера счёта — понятная ошибка, в сеть не ходит', async () => {
    const { adapter, calls } = build({});
    await expect(
      adapter.fetchStatement({
        token: 'key',
        cursor: null,
        accountNumber: null,
        connectedAt: new Date(),
      }),
    ).rejects.toThrow(/номера расчётного счёта/);
    expect(calls).toHaveLength(0);
  });

  it('ПУСТАЯ ALFA_API_BASE_URL из compose → берётся пром, а не пустая база', async () => {
    // docker-compose с `VAR: ${VAR:-}` подставляет пустую строку, и
    // ConfigService отдаёт именно её. С `??` дефолт не подхватывался, база
    // становилась пустой и запрос уходил по относительному пути в никуда.
    const calls: string[] = [];
    const http: AlfaHttp = {
      configured: true,
      getJson: (url) => {
        calls.push(url);
        return Promise.resolve({ status: 200, body: '{"transactions":[]}', headers: {} });
      },
    };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    const adapter = new AlfaAdapter(http, { get: vi.fn(() => '') } as never, registry);
    await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(calls[0]!.startsWith('https://baas.alfabank.ru/api/jp/v1/statement/transactions?')).toBe(true);
  });

  it('ключ с пробелом/кириллицей → человеческая ошибка, в сеть не идём', async () => {
    // Заголовок Authorization — latin1: иначе HTTP-клиент падает технической
    // ошибкой «Cannot convert argument to a ByteString», непонятной владельцу.
    const { adapter, calls } = build({});
    await expect(
      adapter.fetchStatement({
        token: 'ключ с пробелом',
        cursor: null,
        accountNumber: ACCOUNT,
        connectedAt: new Date('2026-07-20T10:00:00Z'),
      }),
    ).rejects.toThrow(/недопустимые символы/);
    expect(calls).toHaveLength(0);
  });

  it('запрос несёт ApiKey, номер счёта и корреляционный id', async () => {
    const seen: Record<string, string>[] = [];
    const http: AlfaHttp = {
      configured: true,
      getJson: (_url, headers) => {
        seen.push(headers);
        return Promise.resolve({ status: 200, body: '{"transactions":[]}', headers: {} });
      },
    };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    const adapter = new AlfaAdapter(
      http,
      { get: vi.fn(() => BASE) } as never,
      registry,
    );
    await adapter.fetchStatement({
      token: 'secret-key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(seen[0]!.Authorization).toBe('ApiKey secret-key');
    expect(seen[0]!['x-fapi-interaction-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AlfaAdapter — пагинация и ошибки', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('идёт по страницам, пока в _links есть next', async () => {
    const { adapter, calls } = build((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const body =
        page < 3
          ? { transactions: [tx({ transactionId: `p${page}` })], _links: [{ rel: 'next', href: '?' }] }
          : { transactions: [tx({ transactionId: `p${page}` })] };
      return { status: 200, body: JSON.stringify(body), headers: {} };
    });

    const res = await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(calls.map((u) => new URL(u).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(res.lines.map((l) => l.externalId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('HTTP-ошибка банка → сообщение без тела ответа', async () => {
    const { adapter } = build(() => ({ status: 401, body: '{"secret":"эхо запроса"}', headers: {} }));
    await expect(
      adapter.fetchStatement({
        token: 'key',
        cursor: '2026-07-21',
        accountNumber: ACCOUNT,
        connectedAt: new Date('2026-07-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/API-ключ не принят банком/);
  });

  it('не-JSON в ответе → внятная ошибка, а не падение парсера', async () => {
    const { adapter } = build(() => ({ status: 200, body: '<html>502</html>', headers: {} }));
    await expect(
      adapter.fetchStatement({
        token: 'key',
        cursor: '2026-07-21',
        accountNumber: ACCOUNT,
        connectedAt: new Date('2026-07-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/не является JSON/);
  });
});

describe('AlfaAdapter — маппинг операции', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  async function mapOne(over: Record<string, unknown>) {
    const { adapter } = build({ '2026-07-22': { transactions: [tx(over)] } });
    const res = await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    return res.lines[0];
  }

  it('CREDIT → приход, контрагент = плательщик', async () => {
    const line = await mapOne({});
    expect(line).toMatchObject({
      externalId: 'tx-1',
      direction: 'INCOME',
      amount: '15000.50',
      counterpartyName: 'ООО «Ромашка»',
      counterpartyInn: '7701234567',
      description: 'Оплата по счёту 14',
      // Признака АУСН этот метод банка не отдаёт — сверка Ф4 идёт другим путём.
      ausnMark: null,
    });
  });

  it('DEBIT → расход, контрагент = получатель', async () => {
    const line = await mapOne({ direction: 'DEBIT' });
    expect(line).toMatchObject({
      direction: 'EXPENSE',
      counterpartyName: 'ИП Антропов',
      counterpartyInn: '667100000000',
    });
  });

  it('сумма приходит модулем и с двумя знаками (без float-хвостов)', async () => {
    const line = await mapOne({ amount: { amount: -0.1 - 0.2, currencyName: 'RUR' } });
    expect(line?.amount).toBe('0.30');
  });

  it('валютная операция учитывается рублёвым эквивалентом', async () => {
    const line = await mapOne({
      amount: { amount: 70, currencyName: 'USD' },
      amountRub: { amount: 6543.21, currencyName: 'RUR' },
    });
    expect(line?.amount).toBe('6543.21');
  });

  it('строки без идентификатора, суммы или направления пропускаются, синк не падает', async () => {
    const { adapter } = build({
      '2026-07-22': {
        transactions: [
          tx({ transactionId: undefined, uuid: undefined }),
          tx({ transactionId: 'no-dir', direction: 'UNKNOWN' }),
          tx({ transactionId: 'no-amount', amount: undefined, amountRub: undefined }),
          tx({ transactionId: 'ok' }),
        ],
      },
    });
    const res = await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(res.lines.map((l) => l.externalId)).toEqual(['ok']);
  });

  it('нет transactionId → идентификатором служит uuid', async () => {
    const line = await mapOne({ transactionId: undefined, uuid: 'uuid-42' });
    expect(line?.externalId).toBe('uuid-42');
  });

  it('битая дата операции → полдень бизнес-дня выписки', async () => {
    const line = await mapOne({ operationDate: 'не дата', documentDate: undefined });
    expect(line?.date.toISOString()).toBe('2026-07-22T07:00:00.000Z');
  });
});

describe('AlfaAdapter — регистрация и сертификат подключения', () => {
  const cfg = (values: Record<string, string | undefined>) =>
    ({ get: vi.fn((k: string) => values[k]) }) as never;

  it('на проде включается всегда — сертификат придёт от подключения', () => {
    const http: AlfaHttp = { configured: true, getJson: () => Promise.reject(new Error('нет')) };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    const adapter = new AlfaAdapter(http, cfg({ NODE_ENV: 'production' }), registry);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('ALFA', adapter);
  });

  it('вне прода без ALFA_TLS_* не включается — демо остаётся на FakeBank', () => {
    const http: AlfaHttp = { configured: true, getJson: () => Promise.reject(new Error('нет')) };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    new AlfaAdapter(http, cfg({ NODE_ENV: 'test' }), registry).onModuleInit();
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('вне прода с сертификатом в env включается (осознанная локальная настройка)', () => {
    const http: AlfaHttp = { configured: true, getJson: () => Promise.reject(new Error('нет')) };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    const adapter = new AlfaAdapter(
      http,
      cfg({ NODE_ENV: 'development', ALFA_TLS_CERT_PATH: '/c.pem', ALFA_TLS_KEY_PATH: '/k.pem' }),
      registry,
    );
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('ALFA', adapter);
  });

  it('сертификат подключения доезжает до транспорта', async () => {
    const seen: unknown[] = [];
    const http: AlfaHttp = {
      configured: true,
      getJson: (_url, _headers, tls) => {
        seen.push(tls);
        return Promise.resolve({ status: 200, body: '{"transactions":[]}', headers: {} });
      },
    };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    const adapter = new AlfaAdapter(http, { get: vi.fn(() => BASE) } as never, registry);
    await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
      tls: { cert: 'CERT-PEM', key: 'KEY-PEM', passphrase: 'p' },
    });
    expect(seen[0]).toEqual({ cert: 'CERT-PEM', key: 'KEY-PEM', passphrase: 'p' });
  });

  it('без сертификата подключения транспорт получает undefined (сработает запасной из env)', async () => {
    const seen: unknown[] = [];
    const http: AlfaHttp = {
      configured: true,
      getJson: (_url, _headers, tls) => {
        seen.push(tls);
        return Promise.resolve({ status: 200, body: '{"transactions":[]}', headers: {} });
      },
    };
    const registry = { register: vi.fn() } as unknown as AdapterRegistry;
    const adapter = new AlfaAdapter(http, { get: vi.fn(() => BASE) } as never, registry);
    await adapter.fetchStatement({
      token: 'key',
      cursor: '2026-07-21',
      accountNumber: ACCOUNT,
      connectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(seen[0]).toBeUndefined();
  });
});

describe('AlfaAdapter — календарные помощники', () => {
  it('dayKey берёт день в поясе бизнеса (UTC+5), а не в UTC', () => {
    // 21:00 UTC = уже следующий день в UTC+5.
    expect(dayKey(new Date('2026-07-21T21:00:00Z'))).toBe('2026-07-22');
  });

  it('переходы через границу месяца и года', () => {
    expect(nextDay('2026-02-28')).toBe('2026-03-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(prevDay('2026-01-01')).toBe('2025-12-31');
    // 2028 — високосный.
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});

// ─────────────────────── остаток по счёту (fetchBalance) ───────────────────────

describe('AlfaAdapter.fetchBalance', () => {
  const startFrom = new Date('2026-06-01T00:00:00.000Z');

  it('ходит в /v1/accounts/{номер} с ApiKey и читает balance.amount', async () => {
    const { adapter, calls } = build(() => ({
      status: 200,
      body: JSON.stringify({ accountNumber: ACCOUNT, balance: { amount: 1301331.94, currency: 'RUR' } }),
      headers: {},
    }));
    const res = await adapter.fetchBalance({ token: 'key', accountNumber: ACCOUNT, startFrom });
    expect(res.current?.amount).toBe('1301331.94');
    expect(res.openingAt).toBeNull();
    expect(calls[0]).toBe(`${BASE}/v1/accounts/${ACCOUNT}`);
  });

  it('403 — понятная ошибка про scope, синк строк её переживёт', async () => {
    const { adapter } = build(() => ({ status: 403, body: '{}', headers: {} }));
    await expect(
      adapter.fetchBalance({ token: 'key', accountNumber: ACCOUNT, startFrom }),
    ).rejects.toThrow(/scope «Счета»/);
  });

  it('незнакомая форма ответа — current null без исключения', async () => {
    const { adapter } = build(() => ({ status: 200, body: '{"foo":1}', headers: {} }));
    const res = await adapter.fetchBalance({ token: 'key', accountNumber: ACCOUNT, startFrom });
    expect(res).toEqual({ current: null, openingAt: null });
  });
});

describe('pickBalance: терпимость к форме ответа', () => {
  it('вложенный объект, плоское число, массив счетов', () => {
    expect(pickBalance({ balance: { amount: 10.5 } })).toBe('10.50');
    expect(pickBalance({ balance: 7 })).toBe('7.00');
    expect(pickBalance({ amount: '3.333' })).toBe('3.33');
    expect(pickBalance([{ balance: { amount: -2 } }])).toBe('-2.00');
    expect(pickBalance({ availableBalance: { amount: 1 } })).toBe('1.00');
  });

  it('мусор — null', () => {
    expect(pickBalance(null)).toBeNull();
    expect(pickBalance({ balance: 'abc' })).toBeNull();
    expect(pickBalance({})).toBeNull();
  });
});
