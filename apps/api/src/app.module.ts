import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigSchema, validateConfig } from './config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { AccountModule } from './account/account.module';
import { CategoryModule } from './category/category.module';
import { CounterpartyModule } from './counterparty/counterparty.module';
import { TransactionModule } from './transaction/transaction.module';
import { AttachmentModule } from './attachment/attachment.module';
import { ImportModule } from './import/import.module';
import { RecurringModule } from './recurring/recurring.module';
import { CategoryRuleModule } from './category-rule/category-rule.module';
import { ReportsModule } from './reports/reports.module';
import { OrderModule } from './orders/order.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { PurchaseModule } from './purchase/purchase.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateConfig,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    WorkspaceModule,
    AccountModule,
    CategoryModule,
    CounterpartyModule,
    TransactionModule,
    AttachmentModule,
    ImportModule,
    RecurringModule,
    CategoryRuleModule,
    ReportsModule,
    OrderModule,
    WarehouseModule,
    PurchaseModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

export type AppConfig = ConfigSchema;
