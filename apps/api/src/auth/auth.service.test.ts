import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

// Лёгкие моки Nest-зависимостей: проверяем только allowlist-гейт пароля (Фаза 2 п.11).
function makeService(opts: { allowedIds: bigint[]; passwordHash?: string }) {
  const config = {
    get: (key: string) => {
      if (key === 'TELEGRAM_ALLOWED_IDS') return opts.allowedIds;
      if (key === 'AUTH_PASSWORD_HASH') return opts.passwordHash;
      return undefined;
    },
  };
  const jwt = { signAsync: vi.fn(async () => 'signed.jwt.token') };
  const prisma = {
    user: {
      upsert: vi.fn(async () => ({
        id: 'user-1',
        telegramId: 1n,
        username: null,
        firstName: 'Admin',
        lastName: null,
        photoUrl: null,
      })),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new AuthService(prisma as any, jwt as any, config as any), jwt, prisma };
}

describe('AuthService.loginViaPassword — allowlist gate (Фаза 2 п.11)', () => {
  const PASSWORD = 'correct-horse';
  let hash: string;

  beforeEach(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  it('пускает по паролю, когда allowlist пуст (открытый режим)', async () => {
    const { service, jwt } = makeService({ allowedIds: [], passwordHash: hash });
    const res = await service.loginViaPassword(PASSWORD);
    expect(res.token).toBe('signed.jwt.token');
    expect(jwt.signAsync).toHaveBeenCalledOnce();
  });

  it('пускает по паролю, когда синтетический id=1 в allowlist', async () => {
    const { service } = makeService({ allowedIds: [1n, 777n], passwordHash: hash });
    const res = await service.loginViaPassword(PASSWORD);
    expect(res.user.telegramId).toBe('1');
  });

  it('блокирует пароль (403), когда allowlist непустой и id=1 в нём нет', async () => {
    const { service, prisma } = makeService({ allowedIds: [777n], passwordHash: hash });
    await expect(service.loginViaPassword(PASSWORD)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('сначала проверяет пароль (401 на неверном) до allowlist', async () => {
    const { service } = makeService({ allowedIds: [777n], passwordHash: hash });
    await expect(service.loginViaPassword('wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401, если пароль-вход не сконфигурирован (нет хэша)', async () => {
    const { service } = makeService({ allowedIds: [], passwordHash: undefined });
    await expect(service.loginViaPassword(PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
