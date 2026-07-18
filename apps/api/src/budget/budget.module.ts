import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { BudgetService } from './budget.service';
import { BudgetController } from './budget.controller';

/** Бюджет план/факт по категориям (месячные лимиты/планы). */
@Module({
  providers: [BudgetService, WorkspaceGuard],
  controllers: [BudgetController],
  exports: [BudgetService],
})
export class BudgetModule {}
