import { Module } from '@nestjs/common';
import { OrderModule } from '../orders/order.module';
import { AuditModule } from '../audit/audit.module';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { AlfaAdapter } from './adapters/alfa.adapter';
import { ALFA_HTTP, AlfaTransport } from './adapters/alfa-transport';
import { TbankAdapter } from './adapters/tbank.adapter';
import { TBANK_HTTP, TbankTransport } from './adapters/tbank-transport';
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
  // OrderModule: InboxService.attachOrder → OrderService.addPayment.
  // AuditModule: след подключения/ротации токена банка (integration.*).
  imports: [OrderModule, AuditModule],
  controllers: [IntegrationsController, InboxController],
  providers: [
    CryptoService,
    AdapterRegistry,
    FakeBankAdapter,
    AlfaTransport,
    // Транспорт Альфы прячем за токеном: адаптер зависит от интерфейса AlfaHttp,
    // и тест подставляет объект без сети, не поднимая mTLS.
    { provide: ALFA_HTTP, useExisting: AlfaTransport },
    AlfaAdapter,
    TbankTransport,
    { provide: TBANK_HTTP, useExisting: TbankTransport },
    TbankAdapter,
    SyncService,
    IntegrationsService,
    InboxService,
  ],
  exports: [CryptoService, AdapterRegistry, SyncService],
})
export class IntegrationsModule {}
