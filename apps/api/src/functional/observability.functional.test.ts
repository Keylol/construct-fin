/**
 * Функциональные тесты наблюдаемости (Волна 4, L5).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp) с тем же HTTP-пайплайном, что и прод
 * (applyHttpPipeline): проверяем корреляцию запросов по заголовку x-request-id —
 * его возвращает КАЖДЫЙ ответ, входящий id уважается, сгенерированные id уникальны.
 * /health не требует авторизации — берём его как нейтральную точку.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';

let H: HttpApp;

beforeAll(async () => {
  H = await buildHttpApp();
});

afterAll(async () => {
  await H.app.close();
});

const reqId = (res: { headers: Record<string, unknown> }): string | undefined =>
  res.headers['x-request-id'] as string | undefined;

describe('Наблюдаемость: x-request-id (L5)', () => {
  it('ответ несёт сгенерированный x-request-id, если клиент его не прислал', async () => {
    const res = await H.inject({ method: 'GET', url: '/health' });
    const id = reqId(res);
    expect(id).toBeTruthy();
    // UUID v4 из randomUUID()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('входящий x-request-id уважается и возвращается тем же значением', async () => {
    const res = await H.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    expect(reqId(res)).toBe('trace-abc-123');
  });

  it('сгенерированные id уникальны между запросами (корреляция не путается)', async () => {
    const a = await H.inject({ method: 'GET', url: '/health' });
    const b = await H.inject({ method: 'GET', url: '/health' });
    expect(reqId(a)).toBeTruthy();
    expect(reqId(b)).toBeTruthy();
    expect(reqId(a)).not.toBe(reqId(b));
  });

  it('заголовок присутствует и на 4xx (напр. защищённый маршрут без токена)', async () => {
    const res = await H.inject({ method: 'GET', url: '/workspaces/x/transactions' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(reqId(res)).toBeTruthy();
  });
});
