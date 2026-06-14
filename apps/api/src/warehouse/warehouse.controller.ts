import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
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
  WarehouseImportMappingSchema,
  WarehouseImportCommitSchema,
  type CreateWarehouseItemDto,
  type UpdateWarehouseItemDto,
  type ListWarehouseQuery,
  type AdjustStockDto,
  type SupplierReturnDto,
  type WarehouseImportCommitDto,
} from './warehouse.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

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

  @Get('low-stock')
  lowStock(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.lowStock(ws.workspaceId);
  }

  @Post('import/preview')
  async importPreview(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query('mapping') mappingRaw: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const buffer = await this.readUpload(req);
    if (!mappingRaw) {
      throw new BadRequestException('mapping query param required (JSON)');
    }
    let mapping;
    try {
      mapping = WarehouseImportMappingSchema.parse(JSON.parse(mappingRaw));
    } catch {
      throw new BadRequestException('Invalid mapping JSON');
    }
    return this.service.importPreview(ws.workspaceId, buffer, mapping);
  }

  @Post('import/commit')
  importCommit(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(WarehouseImportCommitSchema)) body: WarehouseImportCommitDto,
  ) {
    return this.service.importCommit(ws.workspaceId, ws.userId, body.rows);
  }

  @Get(':id/movements')
  movements(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.listMovements(ws.workspaceId, id);
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
    return this.service.adjust(ws.workspaceId, id, body, ws.userId);
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

  /** Достаёт первый файл из multipart-запроса (по образцу ImportController). */
  private async readUpload(req: FastifyRequest): Promise<Buffer> {
    const reqAny = req as FastifyRequest & {
      isMultipart?: () => boolean;
      file?: () => Promise<{ toBuffer: () => Promise<Buffer> } | undefined>;
    };
    if (!reqAny.isMultipart?.()) {
      throw new BadRequestException('Request must be multipart/form-data');
    }
    const part = await reqAny.file?.();
    if (!part) throw new BadRequestException('No file in request');
    const buffer = await part.toBuffer();
    if (buffer.byteLength === 0) throw new BadRequestException('Empty file');
    if (buffer.byteLength > MAX_IMPORT_BYTES) {
      throw new BadRequestException(`File too large (max ${MAX_IMPORT_BYTES} bytes)`);
    }
    return buffer;
  }
}
