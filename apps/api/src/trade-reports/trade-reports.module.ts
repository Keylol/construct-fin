import { Module } from '@nestjs/common';
import { TradeReportsController } from './trade-reports.controller';
import { MarginService } from './margin.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [TradeReportsController],
  providers: [MarginService, WorkspaceGuard],
  exports: [MarginService],
})
export class TradeReportsModule {}
