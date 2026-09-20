import { Module } from '@nestjs/common';
import { CounterpartyController } from './counterparty.controller';
import { CounterpartyService } from './counterparty.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [CounterpartyController],
  providers: [CounterpartyService, WorkspaceGuard],
  // CrmModule: заведение заказа из сделки amo подбирает/создаёт клиента.
  exports: [CounterpartyService],
})
export class CounterpartyModule {}
