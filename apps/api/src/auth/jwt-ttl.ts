/**
 * Перевод JWT_EXPIRES_IN (формат jsonwebtoken/ms: '7d', '24h', '60m', '30s' или
 * число секунд) в секунды — чтобы maxAge cookie совпадал с TTL токена и кука не
 * переживала сам токен (Фаза 2 п.12). Поддерживаем s/m/h/d — этого хватает для
 * нашего контракта; неизвестный формат → ошибка на старте, а не молчаливый дефолт.
 */
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

export function ttlToSeconds(value: string): number {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return Number(raw); // голое число = секунды (как в jsonwebtoken)
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(raw);
  const amount = match?.[1];
  const unit = match?.[2]?.toLowerCase();
  if (!amount || !unit) {
    throw new Error(`Cannot parse JWT_EXPIRES_IN="${value}" into seconds (ожидается Nd/Nh/Nm/Ns или число секунд)`);
  }
  return Number(amount) * UNIT_SECONDS[unit]!;
}
