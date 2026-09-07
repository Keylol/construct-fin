import { describe, expect, it } from 'vitest';
import { deniedForRole } from './role-policy';

describe('deniedForRole — политика ролей пространства', () => {
  it('владелец и админ могут всё', () => {
    expect(deniedForRole('OWNER', 'DELETE', true)).toBeNull();
    expect(deniedForRole('ADMIN', 'DELETE', true)).toBeNull();
  });

  it('оператор (MEMBER) вносит и правит, но не удаляет и не отменяет', () => {
    expect(deniedForRole('MEMBER', 'POST', false)).toBeNull();
    expect(deniedForRole('MEMBER', 'PATCH', false)).toBeNull();
    expect(deniedForRole('MEMBER', 'GET', false)).toBeNull();
    expect(deniedForRole('MEMBER', 'DELETE', false)).toMatch(/только владельцу/);
    expect(deniedForRole('MEMBER', 'post', true)).toMatch(/только владельцу/);
  });

  it('наблюдатель (VIEWER) — только чтение', () => {
    expect(deniedForRole('VIEWER', 'GET', false)).toBeNull();
    expect(deniedForRole('VIEWER', 'POST', false)).toMatch(/только просмотр/);
    expect(deniedForRole('VIEWER', 'DELETE', false)).toMatch(/только просмотр/);
  });
});
