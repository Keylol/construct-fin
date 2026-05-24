import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { CurrentUser } from './current-user.decorator';
import type { JwtPayload } from './auth.service';
import { TelegramLoginPayloadSchema } from '@construct/shared';
import { z } from 'zod';
import type { ConfigSchema } from '../config';

const MiniAppLoginSchema = z.object({ initData: z.string().min(1) });
const PasswordLoginSchema = z.object({ password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<ConfigSchema, true>,
  ) {}

  @Post('telegram/widget')
  @HttpCode(200)
  async loginViaWidget(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const payload = TelegramLoginPayloadSchema.parse(body);
    const { token, user } = await this.authService.loginViaWidget(payload);
    this.setCookie(reply, token);
    return { user };
  }

  @Post('telegram/miniapp')
  @HttpCode(200)
  async loginViaMiniApp(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { initData } = MiniAppLoginSchema.parse(body);
    const { token, user } = await this.authService.loginViaMiniApp(initData);
    this.setCookie(reply, token);
    return { user };
  }

  @Post('login')
  @HttpCode(200)
  async loginViaPassword(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { password } = PasswordLoginSchema.parse(body);
    const { token, user } = await this.authService.loginViaPassword(password);
    this.setCookie(reply, token);
    return { user };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.clearCookie('construct_jwt', { path: '/' });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: JwtPayload) {
    const profile = await this.authService.getProfile(user.sub);
    return { user: profile };
  }

  private setCookie(reply: FastifyReply, token: string): void {
    const isProd = this.config.get('NODE_ENV', { infer: true }) === 'production';
    reply.setCookie('construct_jwt', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60, // 30d
    });
  }
}
