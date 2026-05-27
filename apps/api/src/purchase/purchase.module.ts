import { Module } from '@nestjs/common';
import { PurchaseController } from './purchase.controller';
import { PurchaseService } from './purchase.service';
import { UnitOfWork } from '../common/unit-of-work';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WarehouseModule } from '../warehouse/warehouse.module';

@Module({
  imports: [WarehouseModule],
  controllers: [PurchaseController],
  providers: [PurchaseService, UnitOfWork, WorkspaceGuard],
})
export class PurchaseModule {}
