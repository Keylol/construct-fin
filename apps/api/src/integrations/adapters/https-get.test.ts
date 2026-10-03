import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Agent, createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BANK_TRUSTED_CA, httpsGetJson } from './https-get';
import { RUSSIAN_TRUSTED_ROOT_CA } from './russian-trusted-root-ca';

/**
 * Общий HTTPS-GET банковских транспортов против локального сервера.
 *
 * Главное свойство — доверие решает агент: сервер с сертификатом не из набора
 * агента отвергается (так Т-Банк и падал с «fetch failed», пока корня Минцифры
 * не было), а с нужным корнем ответ банка, включая 4xx, доезжает до адаптера
 * как есть. Сертификат сервера генерируется на лету, как в tls-credential.test.ts:
 * PEM закрытого ключа в репозитории ловил бы секрет-сканер.
 */
let dir: string;
let cert = '';
let server: Server | undefined;
let base = '';
let openssl = true;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'construct-https-get-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', join(dir, 'k.pem'),
        '-out', join(dir, 'c.pem'),
        '-days', '1', '-nodes',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    openssl = false;
    return;
  }
  cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  const key = readFileSync(join(dir, 'k.pem'), 'utf8');
  server = createServer({ cert, key }, (req, res) => {
    if (req.url === '/denied') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid token"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
  });
  // Без адреса — на всех интерфейсах: localhost может резолвиться и в ::1, и в 127.0.0.1.
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  base = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const agentTrusting = (ca: string[]) => new Agent({ ca });

describe('BANK_TRUSTED_CA', () => {
  it('системные корни на месте, корень Минцифры добавлен поверх', () => {
    expect(BANK_TRUSTED_CA).toContain(RUSSIAN_TRUSTED_ROOT_CA);
    // Системных корней больше сотни: проверяем, что набор не вытеснен.
    expect(BANK_TRUSTED_CA.length).toBeGreaterThan(100);
  });
});

describe('httpsGetJson', () => {
  it.runIf(openssl)('сервер с корнем не из набора агента — отказ TLS, а не ответ', async () => {
    await expect(
      httpsGetJson(`${base}/ok`, {}, agentTrusting([...BANK_TRUSTED_CA]), 'Test API'),
    ).rejects.toThrow(/self-signed|certificate/i);
  });

  it.runIf(openssl)('с нужным корнем запрос проходит, заголовки уходят', async () => {
    const res = await httpsGetJson(
      `${base}/ok`,
      { Authorization: 'Bearer t' },
      agentTrusting([...BANK_TRUSTED_CA, cert]),
      'Test API',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ auth: 'Bearer t' });
  });

  it.runIf(openssl)('4xx банка возвращается как есть: текст ошибки строит адаптер', async () => {
    const res = await httpsGetJson(`${base}/denied`, {}, agentTrusting([cert]), 'Test API');
    expect(res.status).toBe(401);
    expect(res.body).toBe('{"error":"invalid token"}');
  });
});
