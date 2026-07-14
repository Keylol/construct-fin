import { Module } from '@nestjs/common';
import { WarehouseModule } from '../warehouse/warehouse.module';
import { OrderModule } from '../orders/order.module';
import { UnitOfWork } from '../common/unit-of-work';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WbReceiptService } from './wb-receipt.service';
import { WbReceiptController } from './wb-receipt.controller';

// Ф6: разбор кассовых чеков Wildberries — деньги/склад/заказы из PDF-чека.
@Module({
  imports: [WarehouseModule, OrderModule],
  providers: [WbReceiptService, UnitOfWork, WorkspaceGuard],
  controllers: [WbReceiptController],
})
export class WbReceiptModule {}
