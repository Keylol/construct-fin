import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { verifyTelegramLogin, verifyTelegramInitData } from './telegram-verify';
import type { ConfigSchema } from '../config';
import type { TelegramLoginPayload, UserProfile } from '@construct/shared';

export interface JwtPayload {
  sub: string; // user.id
  tg: string;  // telegramId (string, т.к. BigInt не сериализуем в JWT)
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<ConfigSchema, true>,
  ) {}

  /** Вход через Telegram Login Widget (desktop). */
  async loginViaWidget(payload: TelegramLoginPayload): Promise<{ token: string; user: UserProfile }> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    const result = verifyTelegramLogin(payload, token);
    if (!result.ok) throw new UnauthorizedException(`Telegram verify failed: ${result.reason}`);
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
    if (!result.ok) throw new UnauthorizedException(`Telegram initData verify failed: ${result.reason}`);
    const userJson = result.data.get('user');
    if (!userJson) throw new UnauthorizedException('initData has no user');
    const parsed = JSON.parse(userJson) as {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      photo_url?: string;
    };
    return this.upsertAndIssue({
      id: BigInt(parsed.id),
      username: parsed.username,
      firstName: parsed.first_name,
      lastName: parsed.last_name,
      photoUrl: parsed.photo_url,
    });
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return this.toProfile(user);
  }

  private async upsertAndIssue(input: {
    id: bigint;
    username?: string;
    firstName?: string;
    lastName?: string;
    photoUrl?: string;
  }): Promise<{ token: string; user: UserProfile }> {
    const allowed = this.config.get('TELEGRAM_ALLOWED_IDS', { infer: true });
    if (allowed.length > 0 && !allowed.includes(input.id)) {
      throw new ForbiddenException('Telegram user not in allowlist');
    }

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
