/**
 * Регресс прод-инцидента 2026-07-26.
 *
 * docker-compose с `VAR: ${VAR:-}` подставляет ПУСТУЮ строку, когда переменной
 * нет в .env.production. Раньше пустая строка доходила до .refine() ключа
 * шифрования, валидация конфига падала — и api не стартовал вообще. Откат
 * деплоя не помогал: откатываются образы, а compose-файл на VPS уже новый.
 *
 * Контракт: пустое значение опциональной переменной = «не задана».
 */
import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

/** Минимально валидное окружение (обязательные поля). */
const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db?schema=public',
  JWT_SECRET: 'x'.repeat(32),
  TELEGRAM_BOT_TOKEN: 'token-value',
  TELEGRAM_BOT_USERNAME: 'bot',
};

describe('validateConfig: опциональные переменные из docker-compose', () => {
  it('пустой INTEGRATION_MASTER_KEY трактуется как «не задан», а не как ошибка', () => {
    const cfg = validateConfig({ ...base, INTEGRATION_MASTER_KEY: '' });
    expect(cfg.INTEGRATION_MASTER_KEY).toBeUndefined();
  });

  it('пустые ALERT_TELEGRAM_CHAT_ID и AUTH_PASSWORD_HASH не валят старт', () => {
    const cfg = validateConfig({
      ...base,
      ALERT_TELEGRAM_CHAT_ID: '',
      AUTH_PASSWORD_HASH: '   ',
    });
    expect(cfg.ALERT_TELEGRAM_CHAT_ID).toBeUndefined();
    expect(cfg.AUTH_PASSWORD_HASH).toBeUndefined();
  });

  it('корректный ключ (base64 от 32 байт) принимается', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(validateConfig({ ...base, INTEGRATION_MASTER_KEY: key }).INTEGRATION_MASTER_KEY).toBe(key);
  });

  it('НЕПРАВИЛЬНЫЙ непустой ключ по-прежнему валит старт (проверка не ослаблена)', () => {
    expect(() =>
      validateConfig({ ...base, INTEGRATION_MASTER_KEY: 'слишком-короткий' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('отсутствие обязательной переменной по-прежнему ошибка', () => {
    expect(() => validateConfig({ ...base, JWT_SECRET: undefined })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
