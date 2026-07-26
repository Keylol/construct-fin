import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  deserializeTlsCredential,
  parseTlsCredential,
  serializeTlsCredential,
} from './tls-credential';

/**
 * Разбор клиентского сертификата mTLS (Ф2, мультитенантность).
 *
 * Сертификат генерируется на лету в temp-каталоге, а не лежит фикстурой в
 * репозитории: PEM закрытого ключа в git — именно то, что справедливо ловит
 * секрет-сканер в CI.
 */
let dir: string;
let cert: string;
let key: string;
let openssl = true;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'construct-tls-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'k.pem'),
      '-out', join(dir, 'c.pem'),
      '-days', '365', '-nodes',
      '-subj', '/CN=construct-test',
    ], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    key = readFileSync(join(dir, 'k.pem'), 'utf8');
  } catch {
    openssl = false;
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseTlsCredential', () => {
  it.runIf(openssl)('достаёт отпечаток и срок действия настоящего сертификата', () => {
    const meta = parseTlsCredential({ cert, key });
    expect(meta.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Сгенерирован на год вперёд — срок должен быть в будущем.
    expect(meta.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it.runIf(openssl)('перепутанные местами файлы → понятная ошибка, а не отказ TLS', () => {
    expect(() => parseTlsCredential({ cert: key, key: cert })).toThrow(BadRequestException);
    expect(() => parseTlsCredential({ cert: key, key: cert })).toThrow(/перепутаны местами/);
  });

  it('не-PEM в сертификате → просим экспортировать пару из p12', () => {
    expect(() => parseTlsCredential({ cert: 'PKдвоичный p12', key: 'x' })).toThrow(
      /BEGIN CERTIFICATE/,
    );
  });

  it('не-PEM в ключе → говорим про блок BEGIN PRIVATE KEY', () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----';
    expect(() => parseTlsCredential({ cert: fakeCert, key: 'просто текст' })).toThrow(
      /BEGIN PRIVATE KEY/,
    );
  });

  it('PEM-заголовок есть, но содержимое битое → сертификат отклоняется', () => {
    const brokenCert = '-----BEGIN CERTIFICATE-----\nне-base64!!!\n-----END CERTIFICATE-----';
    const anyKey = '-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----';
    expect(() => parseTlsCredential({ cert: brokenCert, key: anyKey })).toThrow(/не удалось разобрать/);
  });
});

describe('сериализация', () => {
  it('round-trip сохраняет пару и пароль', () => {
    const raw = serializeTlsCredential({ cert: ' c ', key: ' k ', passphrase: 'pass' });
    expect(deserializeTlsCredential(raw)).toEqual({ cert: 'c', key: 'k', passphrase: 'pass' });
  });

  it('без пароля поле не появляется', () => {
    const raw = serializeTlsCredential({ cert: 'c', key: 'k' });
    expect(JSON.parse(raw)).toEqual({ cert: 'c', key: 'k' });
  });

  it('повреждённое значение из БД → внятная ошибка', () => {
    expect(() => deserializeTlsCredential('{"cert":"c"}')).toThrow(/повреждён/);
  });
});
