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
import { WorkspaceGuard } from '../common/workspace.guard';
import { OwnerGuard } from '../common/owner.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { IntegrationsService } from './integrations.service';
import {
  CreateIntegrationSchema,
  UpdateIntegrationSchema,
  type CreateIntegrationDto,
  type UpdateIntegrationDto,
} from './integrations.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

/**
 * Управление банковскими подключениями — ТОЛЬКО владелец пространства
 * (OwnerGuard после WorkspaceGuard). Токены наружу не отдаются.
 */
@Controller('workspaces/:wsId/integrations')
@UseGuards(JwtAuthGuard, WorkspaceGuard, OwnerGuard)
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.list(ws.workspaceId);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateIntegrationSchema)) body: CreateIntegrationDto,
  ) {
    return this.service.create(ws.workspaceId, ws.userId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateIntegrationSchema)) body: UpdateIntegrationDto,
  ) {
    return this.service.update(ws.workspaceId, id, ws.userId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id, ws.userId);
  }

  /** «Обновить сейчас» — ручной синк выписки. */
  @Post(':id/sync')
  @HttpCode(200)
  syncNow(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.syncNow(ws.workspaceId, id);
  }

  /**
   * «Перезагрузить выписку» — снести загруженное из банка и вытянуть заново
   * (например, после того как завели правила автокатегоризации).
   */
  @Post(':id/reset')
  @HttpCode(200)
  reset(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.resetStatement(ws.workspaceId, id, ws.userId);
  }
}
