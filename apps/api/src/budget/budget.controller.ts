import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';
import { WorkspaceGuard, type WorkspaceContext } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { BudgetService } from './budget.service';
import {
  BudgetListQuerySchema,
  CreateBudgetSchema,
  UpdateBudgetSchema,
  type BudgetListQuery,
  type CreateBudgetDto,
  type UpdateBudgetDto,
} from './budget.dto';

/** Бюджет план/факт: лимиты расходов и планы доходов по категориям. */
@Controller('workspaces/:wsId/budgets')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class BudgetController {
  constructor(private readonly budgets: BudgetService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(BudgetListQuerySchema)) q: BudgetListQuery,
  ) {
    return this.budgets.list(ws.workspaceId, q);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CreateBudgetSchema)) body: CreateBudgetDto,
  ) {
    return this.budgets.create(ws.workspaceId, user.sub, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateBudgetSchema)) body: UpdateBudgetDto,
  ) {
    return this.budgets.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.budgets.remove(ws.workspaceId, id);
  }
}
