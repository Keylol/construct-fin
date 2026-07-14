import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationProvider } from '@prisma/client';
import type { ConfigSchema } from '../config';
import type { BankProviderAdapter } from './provider-adapter';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';

/**
 * Разрешает провайдера подключения в адаптер выписки.
 *
 * Реальные адаптеры (ALFA/TBANK/WB_CARD) регистрируются в своих фазах (Ф2/Ф3/Ф6)
 * через register(). Пока их нет:
 *   • вне production (dev/test) — fallback на FakeBankAdapter (демо/тесты
 *     полного цикла без реальных ключей);
 *   • в production — явный 503 «провайдер ещё не подключён».
 * Зарегистрированный реальный адаптер всегда приоритетнее фейка (в т.ч. в dev).
 */
@Injectable()
export class AdapterRegistry {
  private readonly real = new Map<IntegrationProvider, BankProviderAdapter>();
  private readonly fakeAllowed: boolean;

  constructor(
    private readonly fake: FakeBankAdapter,
    config: ConfigService<ConfigSchema, true>,
  ) {
    this.fakeAllowed = config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  register(provider: IntegrationProvider, adapter: BankProviderAdapter): void {
    this.real.set(provider, adapter);
  }

  resolve(provider: IntegrationProvider): BankProviderAdapter {
    const real = this.real.get(provider);
    if (real) return real;
    if (this.fakeAllowed) return this.fake;
    throw new ServiceUnavailableException(
      `Провайдер ${provider} ещё не подключён (реализация в своей фазе Ф2/Ф3/Ф6)`,
    );
  }
}
