import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';
import { WorkspaceGuard, type WorkspaceContext } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { PlanningService } from './planning.service';
import { ForecastService } from './forecast.service';
import {
  CreatePlannedSchema,
  CreateRecurringSchema,
  ForecastQuerySchema,
  PayPlannedSchema,
  PlannedListQuerySchema,
  PlannedStatusSchema,
  UpcomingQuerySchema,
  UpdatePlannedSchema,
  UpdateRecurringSchema,
  type CreatePlannedDto,
  type CreateRecurringDto,
  type ForecastQuery,
  type PayPlannedDto,
  type PlannedListQuery,
  type PlannedStatusDto,
  type UpcomingQuery,
  type UpdatePlannedDto,
  type UpdateRecurringDto,
} from './planning.dto';

/**
 * Ф5. API регулярных и плановых платежей. Всё редактируемо в приложении:
 * шаблоны регулярки, ручные/зарплатные плановые позиции, отметка оплаты
 * (проводка на общую шину) и её отмена. Сотрудники — через counterparty API
 * (role=EMPLOYEE), отдельной сущности нет.
 */
@Controller('workspaces/:wsId/planning')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly forecast: ForecastService,
  ) {}

  // ── Регулярка ──
  @Get('recurring')
  listRecurring(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.planning.listRecurring(ws.workspaceId);
  }

  @Post('recurring')
  createRecurring(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CreateRecurringSchema)) body: CreateRecurringDto,
  ) {
    return this.planning.createRecurring(ws.workspaceId, user.sub, body);
  }

  @Patch('recurring/:id')
  updateRecurring(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateRecurringSchema)) body: UpdateRecurringDto,
  ) {
    return this.planning.updateRecurring(ws.workspaceId, id, body);
  }

  @Delete('recurring/:id')
  deleteRecurring(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.planning.deleteRecurring(ws.workspaceId, id);
  }

  // ── Плановые платежи ──
  @Get('planned')
  listPlanned(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(PlannedListQuerySchema)) q: PlannedListQuery,
  ) {
    return this.planning.listPlanned(ws.workspaceId, q);
  }

  @Post('planned')
  createPlanned(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CreatePlannedSchema)) body: CreatePlannedDto,
  ) {
    return this.planning.createPlanned(ws.workspaceId, user.sub, body);
  }

  @Patch('planned/:id')
  updatePlanned(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdatePlannedSchema)) body: UpdatePlannedDto,
  ) {
    return this.planning.updatePlanned(ws.workspaceId, id, body);
  }

  @Post('planned/:id/status')
  setStatus(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(PlannedStatusSchema)) body: PlannedStatusDto,
  ) {
    return this.planning.setPlannedStatus(ws.workspaceId, id, body.status);
  }

  @Post('planned/:id/pay')
  payPlanned(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body(new ZodPipe(PayPlannedSchema)) body: PayPlannedDto,
  ) {
    return this.planning.payPlanned(ws.workspaceId, user.sub, id, body);
  }

  @Post('planned/:id/revert')
  revertPlanned(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.planning.revertPlanned(ws.workspaceId, id);
  }

  @Delete('planned/:id')
  deletePlanned(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.planning.deletePlanned(ws.workspaceId, id);
  }

  // ── Горизонт / бейдж ──
  @Get('upcoming')
  upcoming(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(UpcomingQuerySchema)) q: UpcomingQuery,
  ) {
    return this.planning.upcoming(ws.workspaceId, q.horizonDays);
  }

  @Get('count')
  count(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.planning.attentionCount(ws.workspaceId);
  }

  /** Прогноз остатка на горизонте: кассовый разрыв заранее. */
  @Get('forecast')
  getForecast(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ForecastQuerySchema)) q: ForecastQuery,
  ) {
    return this.forecast.build(ws.workspaceId, q.days);
  }
}
