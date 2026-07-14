import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/**
 * Юнит-тесты шифрования секретов интеграций (Ф1). ConfigService мокается.
 * Ключ — base64 от 32 нулевых байт (валиден по длине для AES-256).
 */
const KEY32 = Buffer.alloc(32, 7).toString('base64');

function build(key: string | undefined) {
  const config = {
    get: vi.fn((k: string) => (k === 'INTEGRATION_MASTER_KEY' ? key : undefined)),
  };
  return new CryptoService(config as never);
}

describe('CryptoService', () => {
  it('configured=false и encrypt/decrypt бросают 503 без ключа', () => {
    const svc = build(undefined);
    expect(svc.configured).toBe(false);
    expect(() => svc.encrypt('secret')).toThrow(ServiceUnavailableException);
    expect(() => svc.decrypt('v1.a.b.c')).toThrow(ServiceUnavailableException);
  });

  it('round-trip: decrypt(encrypt(x)) === x', () => {
    const svc = build(KEY32);
    expect(svc.configured).toBe(true);
    const secret = 'alfa-token-Ω-🔑-1234';
    expect(svc.decrypt(svc.encrypt(secret))).toBe(secret);
  });

  it('каждый шифр уникален (случайный nonce), но оба расшифровываются', () => {
    const svc = build(KEY32);
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same');
    expect(svc.decrypt(b)).toBe('same');
  });

  it('формат — v1.<nonce>.<tag>.<ct>, 4 base64-сегмента', () => {
    const enc = build(KEY32).encrypt('x');
    const parts = enc.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('подделка tag → decrypt бросает (аутентификация GCM)', () => {
    const svc = build(KEY32);
    const enc = svc.encrypt('secret');
    const [v, nonce, tag, ct] = enc.split('.') as [string, string, string, string];
    const badTag = Buffer.from(tag, 'base64');
    badTag[0]! ^= 0xff; // портим один байт tag
    const tampered = [v, nonce, badTag.toString('base64'), ct].join('.');
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('чужой ключ не расшифровывает (GCM tag не сходится)', () => {
    const enc = build(KEY32).encrypt('secret');
    const other = build(Buffer.alloc(32, 9).toString('base64'));
    expect(() => other.decrypt(enc)).toThrow();
  });

  it('неверный формат → decrypt бросает понятную ошибку', () => {
    const svc = build(KEY32);
    expect(() => svc.decrypt('garbage')).toThrow(/формат/);
    expect(() => svc.decrypt('v2.a.b.c')).toThrow(/формат/);
  });

  it('mask отдаёт последние 4 символа, короткое — звёзды', () => {
    expect(CryptoService.mask('abcdef1234')).toBe('1234');
    expect(CryptoService.mask('abc')).toBe('****');
  });
});
