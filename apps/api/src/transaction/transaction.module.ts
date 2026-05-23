import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [TransactionController],
  providers: [TransactionService, WorkspaceGuard],
  exports: [TransactionService],
})
export class TransactionModule {}
