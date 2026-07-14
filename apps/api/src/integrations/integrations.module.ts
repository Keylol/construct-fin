import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { SyncService } from './sync.service';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';

/**
 * Модуль интеграций (Ф1 «Полный автомат»): шифрование секретов (CryptoService),
 * реестр адаптеров провайдеров + фейк для dev/тестов, синк выписки (SyncService,
 * ежечасный cron + ручной запуск), CRUD подключений (IntegrationsService,
 * OwnerGuard). Inbox — Ф1-C2.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [
    CryptoService,
    AdapterRegistry,
    FakeBankAdapter,
    SyncService,
    IntegrationsService,
  ],
  exports: [CryptoService, AdapterRegistry, SyncService],
})
export class IntegrationsModule {}
