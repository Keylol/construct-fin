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
import { PurchaseService } from './purchase.service';
import {
  CreatePurchaseSchema,
  ListPurchasesQuerySchema,
  type CreatePurchaseDto,
  type ListPurchasesQuery,
} from './purchase.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/purchases')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class PurchaseController {
  constructor(private readonly service: PurchaseService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListPurchasesQuerySchema)) query: ListPurchasesQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ws.workspaceId, id);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreatePurchaseSchema)) body: CreatePurchaseDto,
  ) {
    return this.service.register(ws.workspaceId, ws.userId, body);
  }

  /** GH9: отменить закупку (только если её партии не тронуты). */
  @Delete(':id')
  @HttpCode(200)
  void(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.voidPurchase(ws.workspaceId, id, ws.userId);
  }
}
