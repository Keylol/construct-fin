import { Module } from '@nestjs/common';
import { CounterpartyController } from './counterparty.controller';
import { CounterpartyService } from './counterparty.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [CounterpartyController],
  providers: [CounterpartyService, WorkspaceGuard],
})
export class CounterpartyModule {}
