import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigSchema, validateConfig } from './config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { AccountModule } from './account/account.module';
import { CategoryModule } from './category/category.module';
import { CounterpartyModule } from './counterparty/counterparty.module';
import { TransactionModule } from './transaction/transaction.module';
import { TransferModule } from './transfer/transfer.module';
import { AttachmentModule } from './attachment/attachment.module';
import { ImportModule } from './import/import.module';
import { CategoryRuleModule } from './category-rule/category-rule.module';
import { ReportsModule } from './reports/reports.module';
import { TradeReportsModule } from './trade-reports/trade-reports.module';
import { OrderModule } from './orders/order.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { PurchaseModule } from './purchase/purchase.module';
import { AuditModule } from './audit/audit.module';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateConfig,
    }),
    ScheduleModule.forRoot(),
    // Базовый лимит: 10 запросов/мин с одного IP. Применяется точечно через
    // ThrottlerGuard только на login-эндпоинтах (см. AuthController) —
    // защита от брутфорса, остальной API не троттлится.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    PrismaModule,
    AuthModule,
    WorkspaceModule,
    AccountModule,
    CategoryModule,
    CounterpartyModule,
    TransactionModule,
    TransferModule,
    AttachmentModule,
    ImportModule,
    CategoryRuleModule,
    ReportsModule,
    TradeReportsModule,
    OrderModule,
    WarehouseModule,
    PurchaseModule,
    AuditModule,
  ],
  controllers: [HealthController],
  providers: [IdempotencyInterceptor],
})
export class AppModule {}

export type AppConfig = ConfigSchema;
