import { describe, expect, it } from 'vitest';
import { RUSSIAN_TRUSTED_ROOT_CA } from './russian-trusted-root-ca';
import { TbankTransport } from './tbank-transport';

/**
 * `business.tbank.ru` подписан Russian Trusted Root CA. С глобальным fetch, который
 * этого корня не знает, синк Т-Банка падал «fetch failed» с 22.09.2026, поэтому
 * доверенный набор агента закреплён тестом.
 */
describe('TbankTransport', () => {
  const options = new TbankTransport().agent.options;

  it('доверяет корню Минцифры', () => {
    expect(options.ca).toContain(RUSSIAN_TRUSTED_ROOT_CA);
  });

  it('системные корни не вытеснены', () => {
    expect((options.ca as string[]).length).toBeGreaterThan(100);
  });

  it('клиентского сертификата нет: Т-Банку хватает Bearer-токена', () => {
    expect(options.cert).toBeUndefined();
    expect(options.key).toBeUndefined();
  });
});
