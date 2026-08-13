import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { InboxService } from './inbox.service';
import {
  ListInboxSchema,
  CategorizeSchema,
  AttachOrderSchema,
  UndoBulkSchema,
  ConfirmTransferSchema,
  MarkTransferSchema,
  PayPlannedFromLineSchema,
  type ListInboxQuery,
  type CategorizeDto,
  type AttachOrderDto,
  type UndoBulkDto,
  type ConfirmTransferDto,
  type MarkTransferDto,
  type PayPlannedFromLineDto,
} from './inbox.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

/**
 * Экран «Входящие»: разбор строк выписки. Обычный доступ члена пространства
 * (без OwnerGuard — оператор разбирает Inbox, решение №18).
 */
@Controller('workspaces/:wsId/inbox')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class InboxController {
  constructor(private readonly service: InboxService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListInboxSchema)) query: ListInboxQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Get('count')
  count(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.count(ws.workspaceId);
  }

  /** Прогнать правила по строкам, уже лежащим на разборе. */
  @Post('apply-rules')
  @HttpCode(200)
  applyRules(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.applyRulesToPending(ws.workspaceId, ws.userId);
  }

  /** Массовый откат авто-проведённого — списком строк или целиком по правилу. */
  @Post('undo-bulk')
  @HttpCode(200)
  undoBulk(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(UndoBulkSchema)) body: UndoBulkDto,
  ) {
    return this.service.undoBulk(ws.workspaceId, body);
  }

  /** Пары строк, похожие на две ноги одного перевода. Только предложение. */
  @Get('transfer-candidates')
  transferCandidates(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.transferCandidates(ws.workspaceId);
  }

  /** Строки, похожие на ожидаемые платежи. Только предложение. */
  @Get('planned-suggestions')
  plannedSuggestions(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.plannedSuggestions(ws.workspaceId);
  }

  /** Погасить план строкой: проводка с видом/категорией плана + закрытие плана. */
  @Post(':id/pay-planned')
  @HttpCode(200)
  payPlanned(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(PayPlannedFromLineSchema)) body: PayPlannedFromLineDto,
  ) {
    return this.service.payPlannedFromLine(ws.workspaceId, ws.userId, id, body.plannedPaymentId);
  }

  /** Подтвердить пару → создать перевод, обе строки уходят из разбора. */
  @Post('confirm-transfer')
  @HttpCode(200)
  confirmTransfer(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(ConfirmTransferSchema)) body: ConfirmTransferDto,
  ) {
    return this.service.confirmTransfer(ws.workspaceId, ws.userId, body);
  }

  /** Перевод на счёт, выписку которого банк не отдаёт (вторая нога — наша). */
  @Post(':id/mark-transfer')
  @HttpCode(200)
  markTransfer(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(MarkTransferSchema)) body: MarkTransferDto,
  ) {
    return this.service.markAsTransfer(ws.workspaceId, ws.userId, id, body.counterAccountId);
  }

  @Post(':id/categorize')
  @HttpCode(200)
  categorize(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(CategorizeSchema)) body: CategorizeDto,
  ) {
    return this.service.categorize(ws.workspaceId, ws.userId, id, body);
  }

  @Post(':id/attach-order')
  @HttpCode(200)
  attachOrder(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(AttachOrderSchema)) body: AttachOrderDto,
  ) {
    return this.service.attachOrder(ws.workspaceId, ws.userId, id, body);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.dismiss(ws.workspaceId, id);
  }

  @Post(':id/undo')
  @HttpCode(200)
  undo(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.undo(ws.workspaceId, id);
  }
}
