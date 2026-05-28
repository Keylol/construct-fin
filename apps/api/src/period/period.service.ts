import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TxClient } from '../common/unit-of-work';
import { AuditService } from '../audit/audit.service';

/**
 * Возвращает (year, month) для даты. month — 1..12, локальное UTC.
 */
export function periodKeyFor(date: Date): { year: number; month: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

/**
 * Закрытие месячного периода. Если запись с status=CLOSED существует — все
 * мутирующие операции с датой в этом диапазоне отклоняются. Редактирование
 * закрытой операции = создание сторно (originalTxId) + новой записи
 * сегодняшней датой; reversal-логика сама проходит мимо гарда.
 */
@Injectable()
export class PeriodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Список периодов с состояниями. Если year не задан — последние 24 мес. */
  async list(workspaceId: string, year?: number) {
    const rows = await this.prisma.accountingPeriod.findMany({
      where: { workspaceId, ...(year ? { year } : {}) },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return rows.map((p) => ({
      id: p.id,
      year: p.year,
      month: p.month,
      status: p.status,
      closedAt: p.closedAt?.toISOString() ?? null,
      closedById: p.closedById,
      note: p.note,
    }));
  }

  /**
   * Закрыть период (year, month). Если записи нет — создаём CLOSED.
   * Если есть и уже CLOSED — ConflictException.
   */
  async close(
    workspaceId: string,
    userId: string,
    input: { year: number; month: number; note?: string | null },
  ) {
    const existing = await this.prisma.accountingPeriod.findUnique({
      where: { workspaceId_year_month: { workspaceId, year: input.year, month: input.month } },
    });
    if (existing && existing.status === 'CLOSED') {
      throw new ConflictException('Период уже закрыт');
    }
    const period = existing
      ? await this.prisma.accountingPeriod.update({
          where: { id: existing.id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closedById: userId,
            note: input.note ?? existing.note,
          },
        })
      : await this.prisma.accountingPeriod.create({
          data: {
            workspaceId,
            year: input.year,
            month: input.month,
            status: 'CLOSED',
            closedAt: new Date(),
            closedById: userId,
            note: input.note ?? null,
          },
        });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'period.close',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      diff: { year: input.year, month: input.month, note: input.note ?? null },
    });
    return period;
  }

  async reopen(workspaceId: string, userId: string, input: { year: number; month: number }) {
    const existing = await this.prisma.accountingPeriod.findUnique({
      where: { workspaceId_year_month: { workspaceId, year: input.year, month: input.month } },
    });
    if (!existing) throw new NotFoundException('Период не найден');
    if (existing.status === 'OPEN') return existing;
    const period = await this.prisma.accountingPeriod.update({
      where: { id: existing.id },
      data: { status: 'OPEN', closedAt: null, closedById: null },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'period.reopen',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      diff: { year: input.year, month: input.month },
    });
    return period;
  }

  /**
   * Проверка: попадает ли дата в закрытый период. Бросает BadRequest если да.
   * Принимает PrismaService или TxClient — чтобы работать внутри UoW.
   */
  async assertOpenForDate(
    client: PrismaService | TxClient,
    workspaceId: string,
    date: Date | string,
  ): Promise<void> {
    const d = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(d.getTime())) throw new BadRequestException('Невалидная дата');
    const { year, month } = periodKeyFor(d);
    const period = await client.accountingPeriod.findUnique({
      where: { workspaceId_year_month: { workspaceId, year, month } },
    });
    if (period?.status === 'CLOSED') {
      throw new BadRequestException(
        `Период ${String(month).padStart(2, '0')}.${year} закрыт. Откройте его в разделе «Закрытие месяца», чтобы внести правку.`,
      );
    }
  }

  /** То же, но удобно когда дат может быть несколько (например, при правке). */
  async assertOpenForDates(
    client: PrismaService | TxClient,
    workspaceId: string,
    dates: Array<Date | string | null | undefined>,
  ): Promise<void> {
    for (const d of dates) {
      if (!d) continue;
      await this.assertOpenForDate(client, workspaceId, d);
    }
  }

  /** Доступно ли редактирование для (year, month). Используется UI-чеками. */
  async isOpen(workspaceId: string, year: number, month: number): Promise<boolean> {
    const period = await this.prisma.accountingPeriod.findUnique({
      where: { workspaceId_year_month: { workspaceId, year, month } },
    });
    return period?.status !== 'CLOSED';
  }
}

// re-export типа, на случай если где-то понадобится
export type AccountingPeriodRow = Prisma.AccountingPeriodGetPayload<Record<string, never>>;
