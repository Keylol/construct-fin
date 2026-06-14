import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [ReconciliationController],
  providers: [ReconciliationService, WorkspaceGuard],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
