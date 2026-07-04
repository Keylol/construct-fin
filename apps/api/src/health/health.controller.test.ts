import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * L2 (наблюдаемость): /health обязан отдавать 503 при недоступной БД, иначе
 * docker healthcheck / service_healthy-gate / авто-откат слепы к отказу БД.
 */
function makeController(queryRaw: () => Promise<unknown>): HealthController {
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  return new HealthController(prisma);
}

describe('HealthController', () => {
  it('БД жива → 200-эквивалент: {status:ok, db:ok}', async () => {
    const ctrl = makeController(() => Promise.resolve([{ '?column?': 1 }]));
    await expect(ctrl.health()).resolves.toEqual({ status: 'ok', db: 'ok' });
  });

  it('БД недоступна → ServiceUnavailableException (503) с телом {degraded, down}', async () => {
    const ctrl = makeController(() => Promise.reject(new Error('connection refused')));
    await expect(ctrl.health()).rejects.toBeInstanceOf(ServiceUnavailableException);

    try {
      await ctrl.health();
      throw new Error('должно было бросить');
    } catch (e) {
      const ex = e as ServiceUnavailableException;
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE); // 503
      expect(ex.getResponse()).toEqual({ status: 'degraded', db: 'down' });
    }
  });

  it('проба реально дёргает БД (SELECT 1)', async () => {
    const spy = vi.fn(() => Promise.resolve([{ '?column?': 1 }]));
    await makeController(spy).health();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
