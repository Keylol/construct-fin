import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { verifyTelegramLogin, verifyTelegramInitData } from './telegram-verify';

// Мокаем HMAC-проверку, чтобы управлять её результатом в тестах путей входа.
vi.mock('./telegram-verify', () => ({
  verifyTelegramLogin: vi.fn(),
  verifyTelegramInitData: vi.fn(),
}));

// Лёгкие моки Nest-зависимостей: проверяем только allowlist-гейт пароля (Фаза 2 п.11).
function makeService(opts: { allowedIds: bigint[]; passwordHash?: string; operatorHash?: string }) {
  const config = {
    get: (key: string) => {
      if (key === 'TELEGRAM_ALLOWED_IDS') return opts.allowedIds;
      if (key === 'AUTH_PASSWORD_HASH') return opts.passwordHash;
      if (key === 'OPERATOR_PASSWORD_HASH') return opts.operatorHash;
      if (key === 'TELEGRAM_BOT_TOKEN') return 'test-bot-token';
      return undefined;
    },
  };
  const jwt = { signAsync: vi.fn(async () => 'signed.jwt.token') };
  const prisma = {
    user: {
      // Эхо telegramId из where: владелец → user-1/1n, оператор → user-2/2n.
      upsert: vi.fn(async ({ where }: { where: { telegramId: bigint } }) => ({
        id: where.telegramId === 2n ? 'user-2' : 'user-1',
        telegramId: where.telegramId,
        username: null,
        firstName: where.telegramId === 2n ? 'Оператор' : 'Admin',
        lastName: null,
        photoUrl: null,
      })),
    },
    workspace: {
      findMany: vi.fn(async () => [{ id: 'ws-a' }, { id: 'ws-b' }]),
    },
    workspaceMember: {
      upsert: vi.fn(async () => ({})),
    },
  };
   
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

  // #16: пустой allowlist = открытый вход (поведение не меняем), но логируем warn.
  it('логирует предупреждение об открытом allowlist при пустом списке', async () => {
    const { service } = makeService({ allowedIds: [], passwordHash: hash });
     
    const warn = vi.spyOn((service as any).logger, 'warn');
    await service.loginViaPassword(PASSWORD);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OPEN'));
  });
});

describe('AuthService.loginViaPassword — второй пароль оператора', () => {
  const OWNER = 'owner-pass';
  const OPERATOR = 'operator-pass';
  let ownerHash: string;
  let operatorHash: string;

  beforeEach(async () => {
    ownerHash = await bcrypt.hash(OWNER, 4);
    operatorHash = await bcrypt.hash(OPERATOR, 4);
  });

  it('пароль оператора → пользователь tg=2 и членство MEMBER во всех живых пространствах', async () => {
    const { service, prisma } = makeService({ allowedIds: [], passwordHash: ownerHash, operatorHash });
    const res = await service.loginViaPassword(OPERATOR);
    expect(res.user.telegramId).toBe('2');
    expect(prisma.workspaceMember.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { workspaceId: 'ws-a', userId: 'user-2', role: 'MEMBER' },
        update: {},
      }),
    );
  });

  it('пароль владельца при заданном операторском — владелец (tg=1), членства не трогает', async () => {
    const { service, prisma } = makeService({ allowedIds: [], passwordHash: ownerHash, operatorHash });
    const res = await service.loginViaPassword(OWNER);
    expect(res.user.telegramId).toBe('1');
    expect(prisma.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it('работает и без пароля владельца: только операторский хэш', async () => {
    const { service } = makeService({ allowedIds: [], operatorHash });
    const res = await service.loginViaPassword(OPERATOR);
    expect(res.user.telegramId).toBe('2');
  });

  it('чужой пароль → 401', async () => {
    const { service } = makeService({ allowedIds: [], passwordHash: ownerHash, operatorHash });
    await expect(service.loginViaPassword('nope')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('оператор проходит allowlist по синтетическому id=2', async () => {
    const closed = makeService({ allowedIds: [1n], passwordHash: ownerHash, operatorHash });
    await expect(closed.service.loginViaPassword(OPERATOR)).rejects.toBeInstanceOf(ForbiddenException);
    const open = makeService({ allowedIds: [1n, 2n], passwordHash: ownerHash, operatorHash });
    await expect(open.service.loginViaPassword(OPERATOR)).resolves.toMatchObject({ token: 'signed.jwt.token' });
  });
});

describe('AuthService — не утекает деталь verify (#14) и валидирует initData (#15)', () => {
  beforeEach(() => {
    vi.mocked(verifyTelegramLogin).mockReset();
    vi.mocked(verifyTelegramInitData).mockReset();
  });

  it('loginViaWidget: при неуспехе verify — обобщённое сообщение, причина в логах', async () => {
    vi.mocked(verifyTelegramLogin).mockReturnValue({ ok: false, reason: 'hash mismatch' });
    const { service } = makeService({ allowedIds: [] });
     
    const warn = vi.spyOn((service as any).logger, 'warn');
     
    await expect(service.loginViaWidget({ id: 1 } as any)).rejects.toMatchObject({
      message: 'Telegram verification failed', // без 'hash mismatch'
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hash mismatch'));
  });

  it('loginViaMiniApp: при неуспехе verify — обобщённое сообщение, причина в логах', async () => {
    vi.mocked(verifyTelegramInitData).mockReturnValue({ ok: false, reason: 'no hash' });
    const { service } = makeService({ allowedIds: [] });
     
    const warn = vi.spyOn((service as any).logger, 'warn');
    await expect(service.loginViaMiniApp('raw')).rejects.toMatchObject({
      message: 'Telegram verification failed',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no hash'));
  });

  it('loginViaMiniApp: невалидный JSON в user → Unauthorized, без падения процесса', async () => {
    const data = new URLSearchParams();
    data.set('user', '{ not valid json');
    vi.mocked(verifyTelegramInitData).mockReturnValue({ ok: true, data });
    const { service } = makeService({ allowedIds: [] });
    await expect(service.loginViaMiniApp('raw')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('loginViaMiniApp: отсутствует числовой id → Unauthorized', async () => {
    const data = new URLSearchParams();
    data.set('user', JSON.stringify({ username: 'bob' }));
    vi.mocked(verifyTelegramInitData).mockReturnValue({ ok: true, data });
    const { service } = makeService({ allowedIds: [] });
    await expect(service.loginViaMiniApp('raw')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('loginViaMiniApp: валидный user → выдаёт токен', async () => {
    const data = new URLSearchParams();
    data.set('user', JSON.stringify({ id: 42, username: 'bob' }));
    vi.mocked(verifyTelegramInitData).mockReturnValue({ ok: true, data });
    const { service } = makeService({ allowedIds: [] });
    const res = await service.loginViaMiniApp('raw');
    expect(res.token).toBe('signed.jwt.token');
  });
});
