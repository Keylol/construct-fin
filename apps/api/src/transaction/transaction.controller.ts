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
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { TransactionService } from './transaction.service';
import {
  CreateTransactionSchema,
  UpdateTransactionSchema,
  ListTransactionsQuerySchema,
  TransactionSummaryQuerySchema,
  type CreateTransactionDto,
  type UpdateTransactionDto,
  type ListTransactionsQuery,
  type TransactionSummaryQuery,
} from './transaction.dto';
import type { WorkspaceContext } from '../common/workspace.guard';
import type { JwtPayload } from '../auth/auth.service';

@Controller('workspaces/:wsId/transactions')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class TransactionController {
  constructor(private readonly service: TransactionService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListTransactionsQuerySchema)) query: ListTransactionsQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Get('summary')
  summary(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(TransactionSummaryQuerySchema)) query: TransactionSummaryQuery,
  ) {
    return this.service.summary(ws.workspaceId, query);
  }

  @Get(':id')
  getById(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.getById(ws.workspaceId, id);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CreateTransactionSchema)) body: CreateTransactionDto,
  ) {
    return this.service.create(ws.workspaceId, user.sub, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateTransactionSchema)) body: UpdateTransactionDto,
  ) {
    return this.service.update(ws.workspaceId, id, body, ws.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id, ws.userId);
  }
}
