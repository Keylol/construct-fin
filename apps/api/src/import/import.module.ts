import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { OrderModule } from '../orders/order.module';

@Module({
  imports: [OrderModule], // F3: пересчёт оплат заказов при привязке строк
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
