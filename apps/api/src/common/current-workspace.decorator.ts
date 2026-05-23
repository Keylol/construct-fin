import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { WorkspaceContext } from './workspace.guard';

export const CurrentWorkspace = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const req = ctx.switchToHttp().getRequest<{ workspace?: WorkspaceContext }>();
    if (!req.workspace) throw new Error('CurrentWorkspace used without WorkspaceGuard');
    return req.workspace;
  },
);
