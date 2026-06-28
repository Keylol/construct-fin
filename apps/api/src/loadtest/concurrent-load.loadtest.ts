/**
 * Нагрузочный тест ядра под многопользовательской конкуренцией.
 *
 * Имитирует 3-5 пользователей, одновременно выполняющих большое число операций
 * над ОБЩИМИ ресурсами (один склад, одни счета, одни заказы) — именно общий
 * ресурс провоцирует гонки. После каждого сценария проверяются инварианты
 * финансового/складского учёта по факту БД (invariants.ts). Нарушение = дефект.
 *
 * Прод не затрагивается: только локальная construct_v6_test.
 *
 * Запуск: TZ=UTC pnpm --filter @construct/api run test:loadtest
 * Объём:  LOADTEST_OPS (операций на воркера, дефолт 1000) × 5 воркеров.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildLoadApp, call, type LoadApp } from './load-harness';
import { resetDb } from '../test/money-harness';
import { checkAllInvariants, computeAccountBalances, type Violation } from './invariants';

const OPS_PER_WORKER = Number(process.env.LOADTEST_OPS ?? 1000);
const WORKERS = Number(process.env.LOADTEST_WORKERS ?? 5);

// ── Детерминированный PRNG (LCG) — воспроизводимость без Math.random ──
let _seed = 0x2f6e2b1;
const rnd = (): number => {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
};
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

let H: LoadApp;

beforeAll(async () => {
  H = await buildLoadApp();
}, 120_000);

afterAll(async () => {
  if (H) await H.close();
});

interface Pool {
  ws: string;
  tokens: string[]; // по токену на воркера
  accounts: string[];
  items: string[];
  clients: string[];
  incomeCatId: string;
}

/** Сидит общий workspace: WORKERS юзеров-членов, счета, склад, клиентов, категорию. */
async function seedPool(): Promise<Pool> {
  const prisma = H.prisma;
  const owner = await prisma.user.create({ data: { telegramId: 5_000_000n, username: 'owner', firstName: 'Owner' } });
  const ws = await prisma.workspace.create({ data: { name: 'LoadTest WS', ownerId: owner.id } });

  const tokens: string[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const tg = 5_000_001n + BigInt(i);
    const u = i === 0 ? owner : await prisma.user.create({ data: { telegramId: tg, username: `w${i}`, firstName: `W${i}` } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: i === 0 ? 'OWNER' : 'MEMBER' } });
    tokens.push(await H.jwtFor(u.id, i === 0 ? 5_000_000n : tg));
  }

  // 3 счёта (с запасом денег, чтобы переводы/платежи проходили).
  const accounts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${ws.id}/accounts`, {
      token: tokens[0], body: { name: `Счёт ${i}`, type: i === 0 ? 'CASH' : 'BANK', openingBalance: '1000000' },
    });
    accounts.push(r.body.id);
  }

  const incomeCat = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${ws.id}/categories`, {
    token: tokens[0], body: { name: 'Продажи', kind: 'INCOME', bucket: 'REVENUE' },
  });

  const clients: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${ws.id}/counterparties`, {
      token: tokens[0], body: { name: `Клиент ${i}`, role: 'CLIENT' },
    });
    clients.push(r.body.id);
  }

  // 5 складских позиций + стартовая закупка большого объёма (чтобы было что продавать).
  const items: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${ws.id}/warehouse`, {
      token: tokens[0], body: { name: `Товар ${i}`, unit: 'шт' },
    });
    items.push(r.body.id);
    await call(H.baseUrl, 'POST', `/workspaces/${ws.id}/purchases`, {
      token: tokens[0], body: { accountId: accounts[0], supplierId: null, lines: [{ warehouseItemId: r.body.id, qty: '100000', unitPrice: '100' }] },
    });
  }

  return { ws: ws.id, tokens, accounts, items, clients, incomeCatId: incomeCat.body.id };
}

interface Metrics { total: number; ok: number; rejected4xx: number; errors5xx: number; }

function fmt(v: Violation[]): string {
  return v.map((x) => `  ✗ [${x.invariant}] ${x.entity}: ${x.detail}`).join('\n');
}

describe('Нагрузка ядра под конкуренцией', () => {
  beforeEach(async () => {
    await resetDb(H.prisma);
  });

  it(`Сценарий 1: ${WORKERS} воркеров × ${OPS_PER_WORKER} смешанных операций над общими ресурсами`, async () => {
    const pool = await seedPool();
    const m: Metrics = { total: 0, ok: 0, rejected4xx: 0, errors5xx: 0 };
    // Общий реестр заказов (один процесс — доступ к массиву безопасен).
    const orders: { id: string; itemId: string }[] = [];
    // Диагностика 5xx: считаем по сигнатуре (op+message) + храним примеры.
    const err5xx = new Map<string, number>();
    const samples: string[] = [];

    const rec = (status: number, opName?: string, body?: unknown) => {
      m.total++;
      if (status < 300) m.ok++;
      else if (status < 500) m.rejected4xx++;
      else {
        m.errors5xx++;
        const msg = (body as { message?: string })?.message ?? JSON.stringify(body)?.slice(0, 120) ?? '';
        const sig = `${opName} → ${status}: ${msg}`;
        err5xx.set(sig, (err5xx.get(sig) ?? 0) + 1);
        if (samples.length < 8) samples.push(sig);
      }
    };

    const worker = async (wi: number) => {
      const token = pool.tokens[wi]!;
      for (let op = 0; op < OPS_PER_WORKER; op++) {
        const roll = rnd();
        try {
          if (roll < 0.3 || orders.length === 0) {
            // создать заказ на общий товар
            const itemId = pick(pool.items);
            const r = await call<{ id: string; items: { id: string }[] }>(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders`, {
              token, body: { clientId: pick(pool.clients), title: `Заказ w${wi}-${op}`, items: [{ warehouseItemId: itemId, name: 'Товар', qty: String(1 + Math.floor(rnd() * 5)), unitPrice: '500' }] },
            });
            rec(r.status, 'createOrder', r.body);
            if (r.ok && r.body?.items?.[0]) orders.push({ id: r.body.id, itemId: r.body.items[0].id });
          } else if (roll < 0.5) {
            // оплата случайного заказа (частичная)
            const o = pick(orders);
            const r = await call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${o.id}/payments`, {
              token, body: { amount: '200', accountId: pick(pool.accounts) },
            });
            rec(r.status, 'payment', r.body);
          } else if (roll < 0.65) {
            // отгрузка 1 шт случайного заказа
            const o = pick(orders);
            const r = await call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${o.id}/ship`, {
              token, body: { itemId: o.itemId, qty: '1' },
            });
            rec(r.status, 'ship', r.body);
          } else if (roll < 0.78) {
            // финализация случайного заказа
            const o = pick(orders);
            const r = await call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${o.id}/finalize`, { token });
            rec(r.status, 'finalize', r.body);
          } else if (roll < 0.88) {
            // возврат 1 шт случайного заказа
            const o = pick(orders);
            const r = await call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${o.id}/returns`, {
              token, body: { itemId: o.itemId, returnQty: '1', refundAmount: '0', accountId: pick(pool.accounts) },
            });
            rec(r.status, 'return', r.body);
          } else {
            // перевод между двумя разными общими счетами
            const from = pick(pool.accounts);
            let to = pick(pool.accounts);
            if (to === from) to = pool.accounts.find((a) => a !== from)!;
            const r = await call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/transfers`, {
              token, body: { fromAccountId: from, toAccountId: to, amount: '100', fee: '0', date: new Date('2026-06-20').toISOString(), note: 't' },
            });
            rec(r.status, 'transfer', r.body);
          }
        } catch {
          m.errors5xx++;
          m.total++;
        }
      }
    };

    await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));

    const violations = await checkAllInvariants(H.prisma, pool.ws);
    // eslint-disable-next-line no-console
    console.log(`[Сценарий 1] ops=${m.total} ok=${m.ok} 4xx=${m.rejected4xx} 5xx=${m.errors5xx} | заказов=${orders.length} | нарушений=${violations.length}`);
    if (violations.length) console.log('НАРУШЕНИЯ ИНВАРИАНТОВ:\n' + fmt(violations));
    if (m.errors5xx > 0) {
      console.log('5xx по сигнатурам:');
      for (const [sig, cnt] of [...err5xx.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${cnt}× ${sig}`);
    }

    expect(m.errors5xx, 'не должно быть необработанных 5xx под конкуренцией').toBe(0);
    expect(violations, 'инварианты учёта должны держаться под конкуренцией').toEqual([]);
  });

  it('Сценарий 2: конкурентная оплата ОДНОГО заказа (рассинхрон paidAmount)', async () => {
    const pool = await seedPool();
    const ord = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders`, {
      token: pool.tokens[0], body: { clientId: pool.clients[0], title: 'Burst pay', items: [{ warehouseItemId: pool.items[0], name: 'Товар', qty: '100', unitPrice: '1000' }] },
    });
    const orderId = ord.body.id;
    const N = 30;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${orderId}/payments`, {
        token: pool.tokens[i % WORKERS], body: { amount: '500', accountId: pool.accounts[i % 3] },
      }),
    ));
    const violations = await checkAllInvariants(H.prisma, pool.ws);
    // eslint-disable-next-line no-console
    console.log(`[Сценарий 2] ${N} одновременных оплат | нарушений=${violations.length}`);
    if (violations.length) console.log(fmt(violations));
    expect(violations, 'paidAmount должен совпадать с суммой проводок после конкурентной оплаты').toEqual([]);
  });

  it('Сценарий 3: конкурентная отгрузка при лимите склада (oversell)', async () => {
    const pool = await seedPool();
    // отдельный товар с ограниченным стоком
    const it = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${pool.ws}/warehouse`, { token: pool.tokens[0], body: { name: 'Лимит', unit: 'шт' } });
    await call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/purchases`, {
      token: pool.tokens[0], body: { accountId: pool.accounts[0], supplierId: null, lines: [{ warehouseItemId: it.body.id, qty: '10', unitPrice: '100' }] },
    });
    const ord = await call<{ id: string; items: { id: string }[] }>(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders`, {
      token: pool.tokens[0], body: { clientId: pool.clients[0], title: 'Burst ship', items: [{ warehouseItemId: it.body.id, name: 'Лимит', qty: '100', unitPrice: '500' }] },
    });
    const orderId = ord.body.id;
    const itemId = ord.body.items[0]!.id;
    const N = 40; // пытаемся отгрузить 40 шт при стоке 10
    await Promise.all(Array.from({ length: N }, (_, i) =>
      call(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${orderId}/ship`, {
        token: pool.tokens[i % WORKERS], body: { itemId, qty: '1' },
      }),
    ));
    const violations = await checkAllInvariants(H.prisma, pool.ws);
    const itemAfter = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: it.body.id } });
    // eslint-disable-next-line no-console
    console.log(`[Сценарий 3] сток=10, попыток отгрузки=${N} | qty после=${Number(itemAfter.qty.toString())} | нарушений=${violations.length}`);
    if (violations.length) console.log(fmt(violations));
    expect(Number(itemAfter.qty.toString()), 'склад не должен уйти в минус (oversell)').toBeGreaterThanOrEqual(0);
    expect(violations).toEqual([]);
  });

  it('Сценарий 4: идемпотентность — один ключ, много одновременных POST', async () => {
    const pool = await seedPool();
    const ord = await call<{ id: string }>(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders`, {
      token: pool.tokens[0], body: { clientId: pool.clients[0], title: 'Idem', items: [{ warehouseItemId: pool.items[0], name: 'Товар', qty: '10', unitPrice: '1000' }] },
    });
    const orderId = ord.body.id;
    const key = 'loadtest-idem-key-0001';
    const N = 12;
    const responses = await Promise.all(Array.from({ length: N }, (_, i) =>
      call<{ message?: string }>(H.baseUrl, 'POST', `/workspaces/${pool.ws}/orders/${orderId}/payments`, {
        token: pool.tokens[i % WORKERS], idempotencyKey: key, body: { amount: '750', accountId: pool.accounts[0] },
      }),
    ));
    const byStatus = new Map<string, number>();
    for (const r of responses) {
      const k = `${r.status}${r.body?.message ? ' ' + r.body.message : ''}`;
      byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
    }
    const payTxs = await H.prisma.transaction.count({ where: { workspaceId: pool.ws, orderId, kind: 'ORDER_PAYMENT', deletedAt: null } });
    // eslint-disable-next-line no-console
    console.log(`[Сценарий 4] ${N} одновременных POST один ключ → проводок=${payTxs}; статусы: ${[...byStatus.entries()].map(([k, c]) => `${c}×[${k}]`).join(', ')}`);
    expect(payTxs, 'идемпотентный ключ должен дать ровно одну проводку оплаты').toBe(1);
  });
});
