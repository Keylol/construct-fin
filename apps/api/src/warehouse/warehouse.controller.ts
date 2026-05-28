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
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { WarehouseService } from './warehouse.service';
import {
  CreateWarehouseItemSchema,
  UpdateWarehouseItemSchema,
  ListWarehouseQuerySchema,
  AdjustStockSchema,
  SupplierReturnSchema,
  type CreateWarehouseItemDto,
  type UpdateWarehouseItemDto,
  type ListWarehouseQuery,
  type AdjustStockDto,
  type SupplierReturnDto,
} from './warehouse.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/warehouse')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListWarehouseQuerySchema)) query: ListWarehouseQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Get('stock-value')
  stockValue(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.stockValue(ws.workspaceId).then((value) => ({ value }));
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ws.workspaceId, id);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateWarehouseItemSchema)) body: CreateWarehouseItemDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateWarehouseItemSchema)) body: UpdateWarehouseItemDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Post(':id/adjust')
  @HttpCode(200)
  adjust(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(AdjustStockSchema)) body: AdjustStockDto,
  ) {
    return this.service.adjust(ws.workspaceId, id, body);
  }

  @Post(':id/supplier-return')
  @HttpCode(200)
  supplierReturn(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(SupplierReturnSchema)) body: SupplierReturnDto,
  ) {
    return this.service.supplierReturn(ws.workspaceId, id, ws.userId, body);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ws.workspaceId, id);
  }
}
