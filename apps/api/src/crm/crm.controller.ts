import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard, type WorkspaceContext } from '../common/workspace.guard';
import { OwnerGuard } from '../common/owner.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { CrmConnectionService } from './crm-connection.service';
import { CrmSyncService } from './crm-sync.service';
import { CrmDealsService } from './crm-deals.service';
import {
  CreateCrmConnectionSchema,
  LinkCrmDealSchema,
  ListCrmDealsSchema,
  UpdateCrmConnectionSchema,
  type CreateCrmConnectionDto,
  type LinkCrmDealDto,
  type ListCrmDealsQuery,
  type UpdateCrmConnectionDto,
} from './crm.dto';

/**
 * amoCRM внутри приложения. Подключение и его настройки — владелец
 * (OwnerGuard на методах, как ключи банков); сделки, «Обновить», связь с
 * заказами — любой член пространства (оператор работает с результатом).
 */
@Controller('workspaces/:wsId/crm')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class CrmController {
  constructor(
    private readonly connections: CrmConnectionService,
    private readonly sync: CrmSyncService,
    private readonly deals: CrmDealsService,
  ) {}

  // ───────────────────────── подключение ─────────────────────────

  @Get('connection')
  connection(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.connections.get(ws.workspaceId);
  }

  @Post('connection')
  @UseGuards(OwnerGuard)
  connect(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateCrmConnectionSchema)) body: CreateCrmConnectionDto,
  ) {
    return this.connections.create(ws.workspaceId, ws.userId, body);
  }

  @Patch('connection')
  @UseGuards(OwnerGuard)
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(UpdateCrmConnectionSchema)) body: UpdateCrmConnectionDto,
  ) {
    return this.connections.update(ws.workspaceId, ws.userId, body);
  }

  @Delete('connection')
  @UseGuards(OwnerGuard)
  @HttpCode(204)
  async disconnect(@CurrentWorkspace() ws: WorkspaceContext) {
    await this.connections.softDelete(ws.workspaceId, ws.userId);
  }

  /** Живые воронки и этапы из amo — для окна настроек. */
  @Get('connection/pipelines')
  @UseGuards(OwnerGuard)
  pipelines(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.connections.livePipelines(ws.workspaceId);
  }

  /** «Обновить» — синк по кнопке, не дожидаясь крона. */
  @Post('connection/sync')
  @HttpCode(200)
  async syncNow(@CurrentWorkspace() ws: WorkspaceContext) {
    const conn = await this.connections.assertOwned(ws.workspaceId);
    return this.sync.syncConnection(conn.id);
  }

  // ───────────────────────── сделки ─────────────────────────

  @Get('deals/summary')
  summary(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.deals.summary(ws.workspaceId);
  }

  @Get('deals')
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListCrmDealsSchema)) query: ListCrmDealsQuery,
  ) {
    return this.deals.list(ws.workspaceId, query);
  }

  @Post('deals/:id/link')
  @HttpCode(200)
  link(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(LinkCrmDealSchema)) body: LinkCrmDealDto,
  ) {
    return this.deals.link(ws.workspaceId, ws.userId, id, body.orderId);
  }

  @Post('deals/:id/unlink')
  @HttpCode(200)
  unlink(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.deals.unlink(ws.workspaceId, ws.userId, id);
  }

  @Post('deals/:id/dismiss')
  @HttpCode(200)
  dismiss(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.deals.setDismissed(ws.workspaceId, ws.userId, id, true);
  }

  @Post('deals/:id/undismiss')
  @HttpCode(200)
  undismiss(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.deals.setDismissed(ws.workspaceId, ws.userId, id, false);
  }

  /** Завести заказ из сделки одной кнопкой (клиент по телефону или новый). */
  @Post('deals/:id/create-order')
  @HttpCode(201)
  createOrder(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.deals.createOrder(ws.workspaceId, ws.userId, id);
  }
}
