import { describe, expect, it } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { OwnerGuard } from './owner.guard';

function ctx(workspace: { role: Role } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ workspace }) }),
  } as unknown as ExecutionContext;
}

describe('OwnerGuard', () => {
  const guard = new OwnerGuard();

  it('OWNER — пропускает', () => {
    expect(guard.canActivate(ctx({ role: 'OWNER' }))).toBe(true);
  });

  it.each(['ADMIN', 'MEMBER', 'VIEWER'] as const)('%s — 403', (role) => {
    expect(() => guard.canActivate(ctx({ role }))).toThrow(ForbiddenException);
  });

  it('нет контекста workspace — 403 (гвард без WorkspaceGuard перед ним)', () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
