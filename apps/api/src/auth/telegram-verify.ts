import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { TelegramLoginPayload } from '@construct/shared';

/**
 * Проверка hash из Telegram Login Widget.
 *
 * Алгоритм (https://core.telegram.org/widgets/login#checking-authorization):
 *   1. secret_key = SHA-256(bot_token)
 *   2. data_check_string = "key=value\n..." (отсортированные ключи без `hash`)
 *   3. hmac_hex = HMAC-SHA-256(secret_key, data_check_string)
 *   4. compare with payload.hash (timing-safe)
 */
export function verifyTelegramLogin(
  payload: TelegramLoginPayload,
  botToken: string,
  // D1: окно replay'а Login Widget — 1ч (было 24ч). Виджет постит auth почти
  // мгновенно после клика; перехваченный payload теперь годен ≤1ч, не сутки.
  maxAgeSeconds = 60 * 60,
): { ok: true } | { ok: false; reason: string } {
  // 1. Свежесть запроса
  const ageSeconds = Math.floor(Date.now() / 1000) - payload.auth_date;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: `auth_date out of range (age=${ageSeconds}s)` };
  }

  // 2. data_check_string
  const { hash, ...rest } = payload;
  const dataCheckString = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // 3. HMAC
  const secretKey = createHash('sha256').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // 4. timing-safe compare
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(computed, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'hash mismatch' };
  }

  return { ok: true };
}

/**
 * Проверка initData из Telegram WebApp (Mini App).
 * Отличие от Login Widget: secret_key = HMAC-SHA-256("WebAppData", bot_token).
 */
export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  // D1: окно replay'а Mini App initData — 15мин (было 24ч), по рекомендации
  // Telegram (initData короткоживущий, отдаётся при открытии приложения).
  maxAgeSeconds = 15 * 60,
): { ok: true; data: URLSearchParams } | { ok: false; reason: string } {
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'no auth_date' };
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: `auth_date out of range (age=${ageSeconds}s)` };
  }

  // Сортируем ПО КЛЮЧУ (как делает Python parse_qsl + sorted by lambda pair[0]).
  // В обычных случаях совпадает с сортировкой полной строки, но для надёжности
  // делаем именно так.
  const entries: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    entries.push([k, v]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(computed, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'hash mismatch' };
  }

  params.delete('hash');
  return { ok: true, data: params };
}
