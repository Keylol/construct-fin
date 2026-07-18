import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { PnlService } from './pnl.service';
import { CashflowService } from './cashflow.service';
import { BreakdownService } from './breakdown.service';
import { TaxService } from './tax.service';
import { BalanceService } from './balance.service';
import { BreakevenService } from './breakeven.service';
import { TradeReportsModule } from '../trade-reports/trade-reports.module';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  // Баланс переиспользует дебиторку (ReceivablesService) из торговых отчётов.
  imports: [TradeReportsModule],
  controllers: [ReportsController],
  providers: [
    PnlService,
    CashflowService,
    BreakdownService,
    TaxService,
    BalanceService,
    BreakevenService,
    WorkspaceGuard,
  ],
  exports: [
    PnlService,
    CashflowService,
    BreakdownService,
    TaxService,
    BalanceService,
    BreakevenService,
  ],
})
export class ReportsModule {}
