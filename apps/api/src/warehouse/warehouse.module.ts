import { Module } from '@nestjs/common';
import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';
import { WarehouseRepository } from './warehouse.repository';
import { WorkspaceGuard } from '../common/workspace.guard';
import { UnitOfWork } from '../common/unit-of-work';

@Module({
  controllers: [WarehouseController],
  providers: [WarehouseService, WarehouseRepository, WorkspaceGuard, UnitOfWork],
  exports: [WarehouseService, WarehouseRepository],
})
export class WarehouseModule {}
