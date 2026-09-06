import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { WorkspaceGuard } from '../common/workspace.guard';
import { AccountModule } from '../account/account.module';

@Module({
  // AccountModule: BalanceAnchorService — сверка, принятая как якорь начального остатка.
  imports: [AccountModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, WorkspaceGuard],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
