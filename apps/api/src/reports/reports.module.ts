import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { PnlService } from './pnl.service';
import { CashflowService } from './cashflow.service';
import { BreakdownService } from './breakdown.service';
import { TaxService } from './tax.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [ReportsController],
  providers: [PnlService, CashflowService, BreakdownService, TaxService, WorkspaceGuard],
  exports: [PnlService, CashflowService, BreakdownService, TaxService],
})
export class ReportsModule {}
