import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { verifyTelegramLogin, verifyTelegramInitData } from './telegram-verify';
import type { TelegramLoginPayload } from '@construct/shared';

const BOT_TOKEN = '123456:TEST_BOT_TOKEN_FOR_UNIT_TESTS';

function signLoginPayload(fields: Omit<TelegramLoginPayload, 'hash'>): TelegramLoginPayload {
  const dataCheckString = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

describe('verifyTelegramLogin', () => {
  it('accepts a freshly signed valid payload', () => {
    const payload = signLoginPayload({
      id: 12345,
      first_name: 'Alex',
      username: 'alex',
      auth_date: Math.floor(Date.now() / 1000),
    });
    const result = verifyTelegramLogin(payload, BOT_TOKEN);
    expect(result.ok).toBe(true);
  });

  it('rejects tampered hash', () => {
    const payload = signLoginPayload({ id: 1, auth_date: Math.floor(Date.now() / 1000) });
    const tampered = { ...payload, hash: 'a'.repeat(64) };
    const result = verifyTelegramLogin(tampered, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it('rejects expired auth_date', () => {
    const payload = signLoginPayload({ id: 1, auth_date: Math.floor(Date.now() / 1000) - 999_999 });
    const result = verifyTelegramLogin(payload, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it('rejects wrong bot token', () => {
    const payload = signLoginPayload({ id: 1, auth_date: Math.floor(Date.now() / 1000) });
    const result = verifyTelegramLogin(payload, 'WRONG_TOKEN');
    expect(result.ok).toBe(false);
  });
});

describe('verifyTelegramInitData', () => {
  function signInitData(fields: Record<string, string>): string {
    const dataCheckString = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const params = new URLSearchParams({ ...fields, hash });
    return params.toString();
  }

  it('accepts a valid initData', () => {
    const raw = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 12345, first_name: 'Alex' }),
    });
    const result = verifyTelegramInitData(raw, BOT_TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.get('user')).toContain('Alex');
    }
  });

  it('rejects missing hash', () => {
    const raw = 'auth_date=1&user=x';
    const result = verifyTelegramInitData(raw, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });
});
