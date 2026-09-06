import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { BalanceAnchorService } from './balance-anchor.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [AccountController],
  providers: [AccountService, BalanceAnchorService, WorkspaceGuard],
  // BalanceAnchorService нужен синку выписки (якорь из банка) и сверке (якорь
  // из принятого факта) — обе точки живут в других модулях.
  exports: [BalanceAnchorService],
})
export class AccountModule {}
