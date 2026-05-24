import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RecurringService } from './recurring.service';

/**
 * Cron-планировщик повторяющихся транзакций.
 *
 * Запускается каждый час, забирает Postgres advisory-lock,
 * чтобы при scale-out / случайных дубль-инстансах не было гонок.
 * Idempotency на уровне БД дополнительно гарантирована
 * unique-индексом (recurringRuleId, recurringOccurrenceDate).
 */
@Injectable()
export class RecurringScheduler {
  private readonly logger = new Logger(RecurringScheduler.name);
  private readonly LOCK_KEY = 0x636f6e73; // 'cons' as bigint hash
  private readonly disabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: RecurringService,
  ) {
    this.disabled = process.env.RECURRING_SCHEDULER_DISABLED === '1';
  }

  @Cron(CronExpression.EVERY_HOUR)
  async tick() {
    if (this.disabled) return;
    const got = await this.tryLock();
    if (!got) {
      this.logger.debug('Skipping tick: another instance holds the lock');
      return;
    }
    try {
      const result = await this.service.runDue();
      if (result.rules > 0 || result.created > 0) {
        this.logger.log(
          `Recurring tick: processed ${result.rules} rules, created ${result.created} transactions`,
        );
      }
    } catch (err) {
      this.logger.error('Recurring tick failed', err as Error);
    } finally {
      await this.releaseLock();
    }
  }

  private async tryLock(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>(
      Prisma.sql`SELECT pg_try_advisory_lock(${this.LOCK_KEY}) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  private async releaseLock(): Promise<void> {
    await this.prisma
      .$queryRaw(Prisma.sql`SELECT pg_advisory_unlock(${this.LOCK_KEY})`)
      .catch(() => undefined);
  }
}
