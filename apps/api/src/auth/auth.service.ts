import { Injectable, Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { verifyTelegramLogin, verifyTelegramInitData } from './telegram-verify';
import type { ConfigSchema } from '../config';
import type { TelegramLoginPayload, UserProfile } from '@construct/shared';

// Парольные входы — синтетические telegramId, не совпадающие с реальными
// аккаунтами: 1 — владелец/разработчик (OWNER), 2 — оператор (MEMBER).
const PASSWORD_USER_TELEGRAM_ID = 1n;
const OPERATOR_TELEGRAM_ID = 2n;

// Структура поля `user` в Telegram initData (после JSON.parse). Минимально
// требуем числовой id; остальные поля опциональны.
const InitDataUserSchema = z.object({
  id: z.number(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  photo_url: z.string().optional(),
});

export interface JwtPayload {
  sub: string; // user.id
  tg: string;  // telegramId (string, т.к. BigInt не сериализуем в JWT)
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<ConfigSchema, true>,
  ) {}

  /** Вход через Telegram Login Widget (desktop). */
  async loginViaWidget(payload: TelegramLoginPayload): Promise<{ token: string; user: UserProfile }> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    const result = verifyTelegramLogin(payload, token);
    if (!result.ok) {
      // Причину логируем для диагностики, клиенту — обобщённое сообщение (не утекаем детали).
      this.logger.warn(`Telegram Login Widget verify failed: ${result.reason}`);
      throw new UnauthorizedException('Telegram verification failed');
    }
    return this.upsertAndIssue({
      id: BigInt(payload.id),
      username: payload.username,
      firstName: payload.first_name,
      lastName: payload.last_name,
      photoUrl: payload.photo_url,
    });
  }

  /** Вход через Telegram Mini App initData. */
  async loginViaMiniApp(initDataRaw: string): Promise<{ token: string; user: UserProfile }> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    const result = verifyTelegramInitData(initDataRaw, token);
    if (!result.ok) {
      // Причину логируем, клиенту — обобщённое сообщение (не утекаем детали).
      this.logger.warn(`Telegram initData verify failed: ${result.reason}`);
      throw new UnauthorizedException('Telegram verification failed');
    }
    const userJson = result.data.get('user');
    if (!userJson) throw new UnauthorizedException('initData has no user');
    let parsed: z.infer<typeof InitDataUserSchema>;
    try {
      parsed = InitDataUserSchema.parse(JSON.parse(userJson));
    } catch (err) {
      this.logger.warn(`Telegram initData user payload invalid: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid Telegram user data');
    }
    return this.upsertAndIssue({
      id: BigInt(parsed.id),
      username: parsed.username,
      firstName: parsed.first_name,
      lastName: parsed.last_name,
      photoUrl: parsed.photo_url,
    });
  }

  /**
   * Парольный вход. Паролей два: владельца (AUTH_PASSWORD_HASH → telegramId=1,
   * OWNER) и оператора (OPERATOR_PASSWORD_HASH → telegramId=2, MEMBER во всех
   * пространствах: вносит и правит, но не удаляет и не отменяет — см.
   * common/role-policy.ts). Кто вошёл, решает совпавший хэш; экран входа один.
   * Оба синтетических id проходят тот же allowlist, что и Telegram (Фаза 2
   * п.11): чтобы пароль работал, добавь `1` (владелец) и `2` (оператор) в
   * TELEGRAM_ALLOWED_IDS.
   */
  async loginViaPassword(password: string): Promise<{ token: string; user: UserProfile }> {
    const ownerHash = this.config.get('AUTH_PASSWORD_HASH', { infer: true });
    const operatorHash = this.config.get('OPERATOR_PASSWORD_HASH', { infer: true });
    if (!ownerHash && !operatorHash) throw new UnauthorizedException('Password auth not configured');
    const isOwner = !!ownerHash && (await bcrypt.compare(password, ownerHash));
    const isOperator = !isOwner && !!operatorHash && (await bcrypt.compare(password, operatorHash));
    if (!isOwner && !isOperator) throw new UnauthorizedException('Неверный пароль');

    const telegramId = isOwner ? PASSWORD_USER_TELEGRAM_ID : OPERATOR_TELEGRAM_ID;
    this.assertAllowed(telegramId);
    const user = await this.prisma.user.upsert({
      where: { telegramId },
      update: {},
      create: { telegramId, firstName: isOwner ? 'Admin' : 'Оператор' },
    });
    if (isOperator) await this.syncOperatorMemberships(user.id);
    const payload: JwtPayload = { sub: user.id, tg: user.telegramId.toString() };
    const token = await this.jwt.signAsync(payload);
    return { token, user: this.toProfile(user) };
  }

  /**
   * Оператор состоит во всех живых пространствах как MEMBER: приложение —
   * один бизнес с парой пространств, второй человек работает в обоих, и
   * новое пространство владельца подхватится на следующем входе. Роль,
   * поднятую владельцем вручную, не понижаем (update: {}).
   */
  private async syncOperatorMemberships(userId: string): Promise<void> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    for (const ws of workspaces) {
      await this.prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: ws.id, userId } },
        update: {},
        create: { workspaceId: ws.id, userId, role: 'MEMBER' },
      });
    }
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return this.toProfile(user);
  }

  /**
   * Единая проверка allowlist для всех путей входа. Пустой TELEGRAM_ALLOWED_IDS =
   * вход открыт (как было); непустой — пускаем только перечисленные telegramId.
   */
  private assertAllowed(id: bigint): void {
    const allowed = this.config.get('TELEGRAM_ALLOWED_IDS', { infer: true });
    if (allowed.length === 0) {
      // Поведение намеренно НЕ меняем (fail-open мог бы залочить прод), но фиксируем
      // в логах, что allowlist пуст и вход открыт всем.
      this.logger.warn('TELEGRAM_ALLOWED_IDS is empty — login allowlist is OPEN to everyone');
      return;
    }
    if (!allowed.includes(id)) {
      throw new ForbiddenException('Telegram user not in allowlist');
    }
  }

  private async upsertAndIssue(input: {
    id: bigint;
    username?: string;
    firstName?: string;
    lastName?: string;
    photoUrl?: string;
  }): Promise<{ token: string; user: UserProfile }> {
    this.assertAllowed(input.id);

    const user = await this.prisma.user.upsert({
      where: { telegramId: input.id },
      update: {
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        photoUrl: input.photoUrl ?? null,
      },
      create: {
        telegramId: input.id,
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        photoUrl: input.photoUrl ?? null,
      },
    });

    const payload: JwtPayload = { sub: user.id, tg: user.telegramId.toString() };
    const token = await this.jwt.signAsync(payload);
    return { token, user: this.toProfile(user) };
  }

  private toProfile(user: {
    id: string;
    telegramId: bigint;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    photoUrl: string | null;
  }): UserProfile {
    return {
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      photoUrl: user.photoUrl,
    };
  }
}
