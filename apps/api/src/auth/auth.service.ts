import { Injectable, Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { verifyTelegramLogin, verifyTelegramInitData } from './telegram-verify';
import type { ConfigSchema } from '../config';
import type { TelegramLoginPayload, UserProfile } from '@construct/shared';

const PASSWORD_USER_TELEGRAM_ID = 1n;

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

  async loginViaPassword(password: string): Promise<{ token: string; user: UserProfile }> {
    const hash = this.config.get('AUTH_PASSWORD_HASH', { infer: true });
    if (!hash) throw new UnauthorizedException('Password auth not configured');
    const ok = await bcrypt.compare(password, hash);
    if (!ok) throw new UnauthorizedException('Неверный пароль');
    // Password-вход прогоняем через тот же allowlist, что и Telegram (Фаза 2 п.11):
    // раньше он обходил TELEGRAM_ALLOWED_IDS. Синтетический id=1 не соответствует
    // ни одному реальному Telegram-аккаунту, поэтому его наличие в списке = «пароль
    // разрешён». Чтобы десктоп-вход продолжал работать, добавь `1` в TELEGRAM_ALLOWED_IDS.
    this.assertAllowed(PASSWORD_USER_TELEGRAM_ID);
    const user = await this.prisma.user.upsert({
      where: { telegramId: PASSWORD_USER_TELEGRAM_ID },
      update: {},
      create: { telegramId: PASSWORD_USER_TELEGRAM_ID, firstName: 'Admin' },
    });
    const payload: JwtPayload = { sub: user.id, tg: user.telegramId.toString() };
    const token = await this.jwt.signAsync(payload);
    return { token, user: this.toProfile(user) };
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
