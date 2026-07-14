import { Module } from '@nestjs/common';
import { OrderModule } from '../orders/order.module';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { SyncService } from './sync.service';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';

/**
 * Модуль интеграций (Ф1 «Полный автомат»): шифрование секретов (CryptoService),
 * реестр адаптеров провайдеров + фейк для dev/тестов, синк выписки (SyncService,
 * ежечасный cron + ручной запуск), CRUD подключений (IntegrationsService,
 * OwnerGuard), экран «Входящие» (InboxService — разбор строк выписки).
 */
@Module({
  imports: [OrderModule], // InboxService.attachOrder → OrderService.addPayment
  controllers: [IntegrationsController, InboxController],
  providers: [
    CryptoService,
    AdapterRegistry,
    FakeBankAdapter,
    SyncService,
    IntegrationsService,
    InboxService,
  ],
  exports: [CryptoService, AdapterRegistry, SyncService],
})
export class IntegrationsModule {}
