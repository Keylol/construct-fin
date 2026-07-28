import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RUSSIAN_TRUSTED_ROOT_CA } from './russian-trusted-root-ca';

/**
 * Корень Минцифры вшит в код, поэтому его подлинность держится не на «файл
 * скачали из правильного места», а на этом тесте: отпечаток зафиксирован и
 * сверен с цепочкой, которую банк присылает в рукопожатии. Подменить или
 * повредить содержимое молча не выйдет.
 */
const EXPECTED_FINGERPRINT =
  'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31';

describe('Russian Trusted Root CA', () => {
  const cert = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA);

  it('отпечаток совпадает с корнем, которым подписан сервер Альфы', () => {
    expect(cert.fingerprint256).toBe(EXPECTED_FINGERPRINT);
  });

  it('это именно корень Минцифры и он самоподписанный', () => {
    expect(cert.subject).toContain('Russian Trusted Root CA');
    expect(cert.subject).toBe(cert.issuer);
    expect(cert.ca).toBe(true);
  });

  it('срок действия ещё не истёк', () => {
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
