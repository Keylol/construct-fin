import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { UnitOfWork } from '../common/unit-of-work';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [OrderController],
  providers: [OrderService, OrderRepository, UnitOfWork, WorkspaceGuard],
})
export class OrderModule {}
