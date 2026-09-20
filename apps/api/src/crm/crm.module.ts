import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigSchema } from '../config';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OrderModule } from '../orders/order.module';
import { CounterpartyModule } from '../counterparty/counterparty.module';
import { AuditModule } from '../audit/audit.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import { OwnerGuard } from '../common/owner.guard';
import { AMO_HTTP, AmoTransport } from './amo-http';
import { FakeAmoTransport } from './fake-amo-transport';
import { AmoClient } from './amo.client';
import { CrmConnectionService } from './crm-connection.service';
import { CrmSyncService } from './crm-sync.service';
import { CrmDealsService } from './crm-deals.service';
import { CrmDiscrepancyService } from './crm-discrepancy.service';
import { CrmController } from './crm.controller';

/**
 * amoCRM внутри приложения (волна 1: amo → учёт). Подключение с зашифрованным
 * долгосрочным токеном, опрос сделок раз в 10 минут, панель «Сделки» со связью
 * сделка ↔ заказ и заведением заказа одной кнопкой.
 */
@Module({
  // IntegrationsModule: CryptoService — тот же мастер-ключ, что у банков.
  // OrderModule / CounterpartyModule: заведение заказа и клиента из сделки.
  // AuditModule: след подключения, ротации токена и каждой связи с заказом.
  imports: [IntegrationsModule, OrderModule, CounterpartyModule, AuditModule],
  controllers: [CrmController],
  providers: [
    AmoTransport,
    FakeAmoTransport,
    // Транспорт за DI-токеном. В NODE_ENV=test — подменный amo без сети (как
    // FakeBankAdapter у банков); везде остальном — настоящий fetch. Выбор по
    // окружению, а не по флагу: в production подмена невозможна.
    {
      provide: AMO_HTTP,
      inject: [ConfigService, AmoTransport, FakeAmoTransport],
      useFactory: (
        config: ConfigService<ConfigSchema, true>,
        real: AmoTransport,
        fake: FakeAmoTransport,
      ) => (config.get('NODE_ENV', { infer: true }) === 'test' ? fake : real),
    },
    AmoClient,
    CrmConnectionService,
    CrmSyncService,
    CrmDealsService,
    CrmDiscrepancyService,
    WorkspaceGuard,
    OwnerGuard,
  ],
})
export class CrmModule {}
