import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from './auth.service';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): JwtPayload => {
  const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
  if (!req.user) throw new Error('CurrentUser used without JwtAuthGuard');
  return req.user;
});
