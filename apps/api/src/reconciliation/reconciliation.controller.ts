import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { ReconciliationService } from './reconciliation.service';
import {
  CreateBalanceCheckSchema,
  ListChecksQuerySchema,
  ReconciliationQuerySchema,
  type CreateBalanceCheckDto,
  type ListChecksQueryDto,
  type ReconciliationQueryDto,
} from './reconciliation.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/reconciliation')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  /** Отчёт сверки: расчётный vs фактический по счёту на дату. */
  @Get()
  build(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ReconciliationQuerySchema)) q: ReconciliationQueryDto,
  ) {
    return this.service.build(ws.workspaceId, q.accountId, q.asOf);
  }

  @Get('checks')
  listChecks(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListChecksQuerySchema)) q: ListChecksQueryDto,
  ) {
    return this.service.listChecks(ws.workspaceId, q.accountId);
  }

  @Post('checks')
  createCheck(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateBalanceCheckSchema)) body: CreateBalanceCheckDto,
  ) {
    return this.service.createCheck(ws.workspaceId, ws.userId, body);
  }

  @Delete('checks/:id')
  @HttpCode(204)
  async deleteCheck(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.deleteCheck(ws.workspaceId, id);
  }
}
