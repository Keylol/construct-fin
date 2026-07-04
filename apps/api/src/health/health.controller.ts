import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(): Promise<{ status: 'ok'; db: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok' };
    } catch {
      // L2 (наблюдаемость): при недоступной БД отдаём HTTP 503, а НЕ 200 с телом
      // {degraded}. Иначе docker healthcheck (`statusCode===200`), service_healthy-
      // gate и авто-откат деплоя слепы к отказу БД — тот самый gate, что должен
      // ловить плохие деплои, сам обязан падать при мёртвой пробе. Тело сохраняем
      // как payload исключения, чтобы диагностика осталась читаемой.
      throw new ServiceUnavailableException({ status: 'degraded', db: 'down' });
    }
  }
}
