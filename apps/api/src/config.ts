import { z } from 'zod';

/**
 * Опциональная строковая переменная окружения, устойчивая к ПУСТОМУ значению.
 *
 * docker-compose с `VAR: ${VAR:-}` подставляет пустую строку, когда переменной
 * нет в .env — и это не то же самое, что «не задана». Без этой обёртки пустая
 * строка доходила до .refine() и валила старт всего приложения (прод-инцидент
 * 2026-07-26: api не поднялся, откат образов не помог, потому что откатываются
 * образы, а compose уже новый). Пустое значение = «не задано».
 */
const optionalEnv = () =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional());

const RawConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'), // Фаза 2 п.12: было 30d, сокращаем TTL токена
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  TELEGRAM_ALLOWED_IDS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => BigInt(s)),
    ),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(10),
  AUTH_PASSWORD_HASH: optionalEnv(),
  // L5-хвост: chat_id для Telegram-алертов о 5xx (обычно telegramId владельца).
  // Не задан (или пуст) → алертинг выключен (локалка/CI/тесты).
  ALERT_TELEGRAM_CHAT_ID: optionalEnv(),
  // Ф1 «Полный автомат»: мастер-ключ шифрования токенов интеграций (банки/WB).
  // base64 от РОВНО 32 байт (AES-256). Не задан → модуль интеграций выключен
  // (локалка/CI/тесты без секретов). Генерация: `openssl rand -base64 32`.
  INTEGRATION_MASTER_KEY: optionalEnv().refine(
    (v) => v === undefined || Buffer.from(v, 'base64').length === 32,
    'INTEGRATION_MASTER_KEY должен быть base64 от 32 байт (openssl rand -base64 32)',
  ),
  // Ф2 «Альфа». База API: пром `https://baas.alfabank.ru/api/jp`, песочница
  // `https://sandbox.alfabank.ru/api/jp`. Не задана → пром.
  ALFA_API_BASE_URL: optionalEnv().refine(
    (v) => v === undefined || /^https:\/\//.test(v),
    'ALFA_API_BASE_URL должен быть https-адресом',
  ),
  // mTLS: банк пускает только по клиентскому сертификату. Пути к файлам на
  // сервере (сам сертификат в репозиторий и в БД не попадает). Не заданы →
  // адаптер Альфы не регистрируется, подключение отвечает 503.
  ALFA_TLS_CERT_PATH: optionalEnv(),
  ALFA_TLS_KEY_PATH: optionalEnv(),
  ALFA_TLS_CA_PATH: optionalEnv(),
  ALFA_TLS_KEY_PASSPHRASE: optionalEnv(),
  // Ф3 «Т-Банк». Пром `https://business.tbank.ru/openapi/api`, песочница
  // `https://business.tbank.ru/openapi/sandbox/api` (токен там фиксированный —
  // TBankSandboxToken, сертификат не нужен). Не задана → пром.
  TBANK_API_BASE_URL: optionalEnv().refine(
    (v) => v === undefined || /^https:\/\//.test(v),
    'TBANK_API_BASE_URL должен быть https-адресом',
  ),
});

export type ConfigSchema = z.infer<typeof RawConfigSchema>;

export function validateConfig(raw: Record<string, unknown>): ConfigSchema {
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('❌ Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error('Invalid environment configuration');
  }
  return parsed.data;
}
