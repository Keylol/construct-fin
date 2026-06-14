import { Module } from '@nestjs/common';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { UnitOfWork } from '../common/unit-of-work';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [TransferController],
  providers: [TransferService, UnitOfWork, WorkspaceGuard],
  exports: [TransferService],
})
export class TransferModule {}
