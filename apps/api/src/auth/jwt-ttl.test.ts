import { describe, it, expect } from 'vitest';
import { ttlToSeconds } from './jwt-ttl';

describe('ttlToSeconds (Фаза 2 п.12)', () => {
  it('парсит дни', () => {
    expect(ttlToSeconds('7d')).toBe(7 * 24 * 60 * 60);
    expect(ttlToSeconds('1d')).toBe(86400);
  });

  it('парсит часы/минуты/секунды', () => {
    expect(ttlToSeconds('24h')).toBe(86400);
    expect(ttlToSeconds('60m')).toBe(3600);
    expect(ttlToSeconds('30s')).toBe(30);
  });

  it('голое число трактует как секунды (семантика jsonwebtoken)', () => {
    expect(ttlToSeconds('3600')).toBe(3600);
  });

  it('терпит пробелы и регистр', () => {
    expect(ttlToSeconds(' 7D ')).toBe(7 * 24 * 60 * 60);
  });

  it('кидает на неизвестном формате (не молчаливый дефолт)', () => {
    expect(() => ttlToSeconds('7days')).toThrow();
    expect(() => ttlToSeconds('')).toThrow();
    expect(() => ttlToSeconds('abc')).toThrow();
  });
});
