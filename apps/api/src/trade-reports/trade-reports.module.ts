import { Module } from '@nestjs/common';
import { TradeReportsController } from './trade-reports.controller';
import { MarginService } from './margin.service';
import { ReceivablesService } from './receivables.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [TradeReportsController],
  providers: [MarginService, ReceivablesService, WorkspaceGuard],
  exports: [MarginService, ReceivablesService],
})
export class TradeReportsModule {}
