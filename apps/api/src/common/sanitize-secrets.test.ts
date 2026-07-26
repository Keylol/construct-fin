/**
 * Тесты вычистки секретов. Кейсы взяты из реальных форм, в которых секрет
 * приезжает в текст: URL банковского OAuth, заголовок Authorization, тело
 * ответа провайдера, telegram bot token (он же HMAC-ключ логина).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSecrets, sanitizeSecretsDeep } from './sanitize-secrets';

describe('sanitizeSecrets', () => {
  it('вычищает токен из query-строки URL (OAuth-callback банка)', () => {
    const out = sanitizeSecrets(
      'GET https://api.alfabank.ru/oauth/token?code=SplxlOBeZQQYbYS6WxSbIA&client_id=abc → 401',
    );
    expect(out).not.toContain('SplxlOBeZQQYbYS6WxSbIA');
    expect(out).not.toContain('abc');
    expect(out).toContain('[REDACTED]');
    // Путь остаётся — по нему и разбирают инцидент.
    expect(out).toContain('api.alfabank.ru/oauth/token');
  });

  it('вычищает Bearer и Basic из заголовков в тексте', () => {
    const out = sanitizeSecrets(
      'headers: { Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig }',
    );
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED]');
  });

  it('вычищает client_secret и access_token из JSON-тела', () => {
    const out = sanitizeSecrets(
      '{"access_token":"ya29.A0ARrdaM-verylongtokenvalue","client_secret":"s3cr3t-value","expires_in":3600}',
    );
    expect(out).not.toContain('ya29.A0ARrdaM-verylongtokenvalue');
    expect(out).not.toContain('s3cr3t-value');
    // Несекретное остаётся — иначе сообщение теряет смысл.
    expect(out).toContain('expires_in');
  });

  it('вычищает telegram bot token (HMAC-ключ проверки логина)', () => {
    const out = sanitizeSecrets(
      'setWebhook failed for 8294880190:AAGzVE8RtNFmN7vvkYRZAfloQfrUudLboNQ',
    );
    expect(out).not.toContain('AAGzVE8RtNFmN7vvkYRZAfloQfrUudLboNQ');
    expect(out).toContain('[REDACTED]');
  });

  it('не портит обычные сообщения и короткие идентификаторы', () => {
    const msg = 'Счёт не найден в этом пространстве (id=cmptgzym2000211t46ddz82zo)';
    expect(sanitizeSecrets(msg)).toBe(msg);
  });

  // Регресс: слово `code` в тексте — это код ошибки, по которому и разбирают
  // инцидент. Маскировать его нельзя; секрет — только `code` в query-строке.
  it('НЕ маскирует коды ошибок в тексте (Prisma/HTTP)', () => {
    expect(sanitizeSecrets('Prisma error code: P2002 on Transaction')).toBe(
      'Prisma error code: P2002 on Transaction',
    );
    expect(sanitizeSecrets('HTTP 403, error code=42, retry later')).toBe(
      'HTTP 403, error code=42, retry later',
    );
  });

  it('маскирует OAuth-код именно в query-строке', () => {
    const out = sanitizeSecrets('callback https://app/cb?code=OAUTH-SECRET-XYZ&state=1');
    expect(out).not.toContain('OAUTH-SECRET-XYZ');
    expect(out).toContain('code=[REDACTED]');
    // Остальные параметры не задеты — они нужны для разбора.
    expect(out).toContain('state=1');
  });

  it('пустой ввод не ломает', () => {
    expect(sanitizeSecrets(undefined)).toBe('');
    expect(sanitizeSecrets(null)).toBe('');
    expect(sanitizeSecrets('')).toBe('');
  });
});

describe('sanitizeSecretsDeep', () => {
  it('вырезает секретные ключи на любой глубине (raw выписки)', () => {
    const raw = {
      operation: { id: 'op-1', amount: '1500.00', purpose: 'Оплата по счёту 42' },
      _request: {
        headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
        params: { access_token: 'tok-very-secret-value' },
      },
    };
    const out = sanitizeSecretsDeep(raw) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.stringify(out)).not.toContain('tok-very-secret-value');
    // Деловые поля выписки сохраняются — они и нужны для форензики.
    expect(out.operation!.purpose).toBe('Оплата по счёту 42');
    expect(out.operation!.amount).toBe('1500.00');
  });

  it('ограничивает глубину и длину массива (защита от огромных ответов)', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(sanitizeSecretsDeep(deep))).toContain('TRUNCATED');

    const long = Array.from({ length: 500 }, (_, i) => i);
    expect((sanitizeSecretsDeep(long) as unknown[]).length).toBe(200);
  });

  it('примитивы и null проходят как есть', () => {
    expect(sanitizeSecretsDeep(42)).toBe(42);
    expect(sanitizeSecretsDeep(null)).toBeNull();
    expect(sanitizeSecretsDeep(true)).toBe(true);
  });
});
