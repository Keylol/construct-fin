import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { UnitOfWork } from '../common/unit-of-work';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WarehouseModule } from '../warehouse/warehouse.module';

@Module({
  imports: [WarehouseModule],
  controllers: [OrderController],
  providers: [OrderService, OrderRepository, UnitOfWork, WorkspaceGuard],
  // F3: импорт выписки привязывает строки к заказам и пересчитывает их оплату.
  exports: [OrderService],
})
export class OrderModule {}
