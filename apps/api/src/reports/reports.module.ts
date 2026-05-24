import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { PnlService } from './pnl.service';
import { CashflowService } from './cashflow.service';
import { BreakdownService } from './breakdown.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [ReportsController],
  providers: [PnlService, CashflowService, BreakdownService, WorkspaceGuard],
  exports: [PnlService, CashflowService, BreakdownService],
})
export class ReportsModule {}
