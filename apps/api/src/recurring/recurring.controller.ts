import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { RecurringService } from './recurring.service';
import {
  CreateRecurringRuleSchema,
  UpdateRecurringRuleSchema,
  type CreateRecurringRuleDto,
  type UpdateRecurringRuleDto,
} from './recurring.dto';
import type { JwtPayload } from '../auth/auth.service';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/recurring')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class RecurringController {
  constructor(private readonly service: RecurringService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.list(ws.workspaceId);
  }

  @Get(':id')
  getById(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.getById(ws.workspaceId, id);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateRecurringRuleSchema)) body: CreateRecurringRuleDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateRecurringRuleSchema)) body: UpdateRecurringRuleDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }

  @Post(':id/run-now')
  runNow(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.service.runRule(ws.workspaceId, id, user.sub);
  }
}
