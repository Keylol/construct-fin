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
import { OrderService } from './order.service';
import {
  CreateOrderSchema,
  UpdateOrderSchema,
  ListOrdersQuerySchema,
  AddPaymentSchema,
  ReturnItemSchema,
  ShipItemSchema,
  type CreateOrderDto,
  type UpdateOrderDto,
  type ListOrdersQuery,
  type AddPaymentDto,
  type ReturnItemDto,
  type ShipItemDto,
} from './order.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/orders')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListOrdersQuerySchema)) query: ListOrdersQuery,
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
    @Body(new ZodPipe(CreateOrderSchema)) body: CreateOrderDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateOrderSchema)) body: UpdateOrderDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Post(':id/payments')
  @HttpCode(200)
  addPayment(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(AddPaymentSchema)) body: AddPaymentDto,
  ) {
    return this.service.addPayment(ws.workspaceId, id, ws.userId, body);
  }

  @Post(':id/ship')
  @HttpCode(200)
  ship(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ShipItemSchema)) body: ShipItemDto,
  ) {
    return this.service.ship(ws.workspaceId, id, ws.userId, body);
  }

  @Post(':id/returns')
  @HttpCode(200)
  returnItem(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ReturnItemSchema)) body: ReturnItemDto,
  ) {
    return this.service.returnItem(ws.workspaceId, id, ws.userId, body);
  }

  @Post(':id/finalize')
  @HttpCode(200)
  finalize(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.finalize(ws.workspaceId, id, ws.userId);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.reopen(ws.workspaceId, id, ws.userId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.cancel(ws.workspaceId, id, ws.userId);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ws.workspaceId, id, ws.userId);
  }
}
