import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/**
 * Модуль интеграций (Ф1 «Полный автомат»). Пока — только CryptoService
 * (шифрование секретов). Синк-каркас, адаптеры провайдеров, CRUD подключений
 * и Inbox добавляются в следующих волнах (Ф1-B, Ф1-C).
 */
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class IntegrationsModule {}
