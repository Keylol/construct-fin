import { describe, it, expect } from 'vitest';
import { buildPlanningDigest, type DigestItem } from './planning-reminder';

function item(over: Partial<DigestItem>): DigestItem {
  return {
    title: 'Платёж',
    amount: '1000.00',
    dueDate: '2026-08-01T07:00:00.000Z',
    dueInDays: 5,
    overdue: false,
    soon: true,
    counterpartyName: null,
    ...over,
  };
}

describe('buildPlanningDigest', () => {
  it('пусто → null (крон молчит)', () => {
    expect(buildPlanningDigest('WS', [])).toBeNull();
    // Позиция вне окна (не overdue и не soon) не рождает дайджест.
    expect(buildPlanningDigest('WS', [item({ overdue: false, soon: false })])).toBeNull();
  });

  it('просрочка и «скоро» — обе секции, счётчики, формат суммы/даты', () => {
    const text = buildPlanningDigest('ИП Тест', [
      item({ title: 'Аренда', amount: '30000.00', overdue: true, soon: false, dueInDays: -3 }),
      item({ title: 'Зарплата', amount: '55000.50', soon: true, dueInDays: 2, counterpartyName: 'Иванов' }),
    ])!;
    expect(text).toContain('🗓 Платежи — ИП Тест');
    expect(text).toContain('⚠️ Просрочено (1):');
    expect(text).toContain('• Аренда — 30 000.00 ₽ (3 дн. назад)');
    expect(text).toContain('🔔 Скоро (1):');
    expect(text).toContain('• Зарплата — 55 000.50 ₽ (через 2 дн., 01.08.2026, Иванов)');
  });

  it('срок сегодня → «сегодня», без секции просрочки', () => {
    const text = buildPlanningDigest('WS', [item({ title: 'Инет', dueInDays: 0, soon: true })])!;
    expect(text).toContain('сегодня');
    expect(text).not.toContain('Просрочено');
  });
});
