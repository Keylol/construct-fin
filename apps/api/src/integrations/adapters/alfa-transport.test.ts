import { describe, expect, it } from 'vitest';
import { agentCacheKey } from './alfa-transport';

/**
 * Ключ кэша TLS-агентов. Свойство, ради которого он вынесен в чистую функцию:
 * два пространства с разными сертификатами обязаны получить РАЗНЫЕ агенты,
 * иначе второй ИП ушёл бы в банк под чужим клиентским сертификатом.
 */
describe('agentCacheKey', () => {
  const A = { cert: 'CERT-A', key: 'KEY-A' };
  const B = { cert: 'CERT-B', key: 'KEY-B' };

  it('разные сертификаты → разные агенты', () => {
    expect(agentCacheKey(A)).not.toBe(agentCacheKey(B));
  });

  it('одинаковая пара → один агент (соединения переиспользуются)', () => {
    expect(agentCacheKey(A)).toBe(agentCacheKey({ cert: 'CERT-A', key: 'KEY-A' }));
  });

  it('тот же сертификат с другим ключом — это другой агент', () => {
    expect(agentCacheKey(A)).not.toBe(agentCacheKey({ cert: 'CERT-A', key: 'KEY-B' }));
  });

  it('склейка полей не даёт коллизий на границе', () => {
    // Без разделителя 'AB'+'C' и 'A'+'BC' дали бы один хеш — и два разных
    // подключения делили бы агент.
    expect(agentCacheKey({ cert: 'AB', key: 'C' })).not.toBe(
      agentCacheKey({ cert: 'A', key: 'BC' }),
    );
  });

  it('смена пароля ключа меняет агент', () => {
    expect(agentCacheKey(A)).not.toBe(agentCacheKey({ ...A, passphrase: 'p' }));
  });
});
