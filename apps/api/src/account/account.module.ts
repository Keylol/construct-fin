import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [AccountController],
  providers: [AccountService, WorkspaceGuard],
})
export class AccountModule {}
