import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { PeriodService } from './period.service';
import {
  ClosePeriodSchema,
  ReopenPeriodSchema,
  ListPeriodsQuerySchema,
  type ClosePeriodDto,
  type ReopenPeriodDto,
  type ListPeriodsQuery,
} from './period.dto';
import type { WorkspaceContext } from '../common/workspace.guard';
import type { JwtPayload } from '../auth/auth.service';

@Controller('workspaces/:wsId/periods')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class PeriodController {
  constructor(private readonly service: PeriodService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListPeriodsQuerySchema)) query: ListPeriodsQuery,
  ) {
    return this.service.list(ws.workspaceId, query.year);
  }

  @Post('close')
  close(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(ClosePeriodSchema)) body: ClosePeriodDto,
  ) {
    return this.service.close(ws.workspaceId, user.sub, body);
  }

  @Post('reopen')
  reopen(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(ReopenPeriodSchema)) body: ReopenPeriodDto,
  ) {
    return this.service.reopen(ws.workspaceId, user.sub, body);
  }
}
