import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { SyncService } from './sync.service';

/**
 * Модуль интеграций (Ф1 «Полный автомат»): шифрование секретов (CryptoService),
 * реестр адаптеров провайдеров + фейк для dev/тестов, синк выписки (SyncService,
 * ежечасный cron + ручной запуск). CRUD подключений и Inbox — Ф1-C.
 */
@Module({
  providers: [CryptoService, AdapterRegistry, FakeBankAdapter, SyncService],
  exports: [CryptoService, AdapterRegistry, SyncService],
})
export class IntegrationsModule {}
