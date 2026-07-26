/**
 * Вычистка секретов из текста перед логом/БД/выдачей наружу.
 *
 * Зачем: адаптеры внешних API бросают ошибки, куда попадает всё подряд — URL
 * с `?access_token=…`, заголовок `Authorization: Bearer …`, тело ответа банка с
 * `client_secret`. Такой текст уезжает в три места: форензик-лог 5xx,
 * `IntegrationConnection.lastSyncError` (а оттуда в UI и в каждый дамп БД) и в
 * сообщение пользователю. Прогоняем его через эту функцию на всех трёх путях.
 *
 * Подход — по ключам и по форме значения, а не по конкретному провайдеру:
 * новый банк не потребует правок. Ложные срабатывания (замаскируем лишнее)
 * дешевле пропуска секрета.
 */

/** Имена параметров/полей, значение которых — всегда секрет. */
const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'client_id',
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'authorization',
  'code',
  'credentialenc',
  'private_key',
  'passphrase',
];

const MASK = '[REDACTED]';

/**
 * `key=value`, `key: value`, `"key":"value"` — в query-строках, заголовках и
 * JSON-телах. Значение съедаем до разделителя (&, кавычка, запятая, пробел,
 * перевод строки, закрывающая скобка).
 */
const KEY_VALUE_RE = new RegExp(
  String.raw`("?)(${SECRET_KEYS.join('|')})\1\s*[:=]\s*("?)([^"&,\s}\]]+)\3`,
  'gi',
);

/** `Bearer <token>` / `Basic <base64>` в заголовках и сообщениях. */
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * JWT: три base64url-сегмента через точку, первый всегда начинается с `eyJ`
 * (base64 от `{"`). Отдельный паттерн нужен потому, что каждый сегмент по
 * отдельности короче порога LONG_OPAQUE_RE, а точка в него не входит.
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

/** Telegram bot token: `<bot_id>:AA<...>` — он же HMAC-ключ проверки логина. */
const TELEGRAM_TOKEN_RE = /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g;

/**
 * Длинные «похожие на секрет» строки: base64url/hex ≥ 40 символов без пробелов.
 * Ловит токены, попавшие в текст без имени параметра (например, в теле ответа).
 * Порог высокий, чтобы не задевать id (cuid ~25) и хеши файлов в описаниях.
 */
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

/** Заменить секреты в строке на [REDACTED]. Пустой/не-строка → как есть. */
export function sanitizeSecrets(input: string | undefined | null): string {
  if (!input) return input ?? '';
  // Порядок значим: схемы (`Bearer …`) и JWT — ДО разбора `key: value`, иначе
  // `Authorization: Bearer <jwt>` съедается как пара ключ-значение, где
  // значением оказывается слово «Bearer», а сам токен остаётся в тексте.
  return input
    .replace(TELEGRAM_TOKEN_RE, MASK)
    .replace(JWT_RE, MASK)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${MASK}`)
    .replace(KEY_VALUE_RE, (_m, q1: string, key: string, _q2: string) => `${q1}${key}${q1}=${MASK}`)
    .replace(LONG_OPAQUE_RE, MASK);
}

/**
 * Рекурсивная вычистка объекта (для `BankStatementLine.raw`): ключи из
 * SECRET_KEYS вырезаются целиком, строковые значения прогоняются через
 * sanitizeSecrets. Глубина ограничена — защита от циклов и гигантских ответов.
 */
export function sanitizeSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return sanitizeSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // Ограничиваем длину: сырой ответ провайдера может быть огромным.
    return value.slice(0, 200).map((v) => sanitizeSecretsDeep(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.includes(k.toLowerCase())) {
      out[k] = MASK;
      continue;
    }
    out[k] = sanitizeSecretsDeep(v, depth + 1);
  }
  return out;
}
