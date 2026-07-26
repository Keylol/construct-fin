import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { WorkspaceService } from './workspace.service';
import {
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  type CreateWorkspaceDto,
  type UpdateWorkspaceDto,
} from './workspace.dto';
import type { JwtPayload } from '../auth/auth.service';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly service: WorkspaceService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.service.listForUser(user.sub);
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CreateWorkspaceSchema)) body: CreateWorkspaceDto,
  ) {
    return this.service.create(user.sub, body);
  }

  @Patch(':wsId')
  @UseGuards(WorkspaceGuard)
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(UpdateWorkspaceSchema)) body: UpdateWorkspaceDto,
  ) {
    this.requireRole(ws, ['OWNER', 'ADMIN']);
    return this.service.update(ws.workspaceId, body);
  }

  @Delete(':wsId')
  @UseGuards(WorkspaceGuard)
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext) {
    this.requireRole(ws, ['OWNER']);
    await this.service.softDelete(ws.workspaceId);
  }

  private requireRole(ws: WorkspaceContext, allowed: WorkspaceContext['role'][]): void {
    if (!allowed.includes(ws.role)) {
      throw new ForbiddenException(`Requires role: ${allowed.join('|')}`);
    }
  }
}
