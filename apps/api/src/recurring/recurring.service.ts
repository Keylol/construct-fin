import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeNextRunAt,
  enumerateOccurrences,
  type ScheduleInput,
} from './recurring.engine';
import type {
  CreateRecurringRuleDto,
  UpdateRecurringRuleDto,
} from './recurring.dto';

interface RuleWithTemplate {
  id: string;
  workspaceId: string;
  name: string;
  templateJson: Prisma.JsonValue;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  startDate: Date;
  endDate: Date | null;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  nextRunAt: Date;
  lastRunAt: Date | null;
  active: boolean;
}

@Injectable()
export class RecurringService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.recurringRule.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(workspaceId: string, id: string) {
    const rule = await this.prisma.recurringRule.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!rule) throw new NotFoundException('Recurring rule not found');
    return rule;
  }

  async create(workspaceId: string, dto: CreateRecurringRuleDto) {
    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    const schedule: ScheduleInput = {
      frequency: dto.frequency,
      interval: dto.interval,
      startDate,
      endDate,
      dayOfMonth: dto.dayOfMonth ?? null,
      dayOfWeek: dto.dayOfWeek ?? null,
    };
    const nextRunAt = computeNextRunAt(schedule, new Date()) ?? startDate;
    return this.prisma.recurringRule.create({
      data: {
        workspaceId,
        name: dto.name,
        templateJson: dto.template as unknown as Prisma.InputJsonValue,
        frequency: dto.frequency,
        interval: dto.interval,
        startDate,
        endDate,
        dayOfMonth: dto.dayOfMonth ?? null,
        dayOfWeek: dto.dayOfWeek ?? null,
        active: dto.active,
        nextRunAt,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateRecurringRuleDto) {
    const existing = await this.getById(workspaceId, id);

    const startDate = dto.startDate ? new Date(dto.startDate) : existing.startDate;
    const endDate = dto.endDate === undefined ? existing.endDate : dto.endDate ? new Date(dto.endDate) : null;
    const frequency = dto.frequency ?? existing.frequency;
    const interval = dto.interval ?? existing.interval;
    const dayOfMonth = dto.dayOfMonth === undefined ? existing.dayOfMonth : dto.dayOfMonth;
    const dayOfWeek = dto.dayOfWeek === undefined ? existing.dayOfWeek : dto.dayOfWeek;

    // Recompute nextRunAt if schedule changed
    const scheduleChanged =
      dto.frequency !== undefined ||
      dto.interval !== undefined ||
      dto.startDate !== undefined ||
      dto.endDate !== undefined ||
      dto.dayOfMonth !== undefined ||
      dto.dayOfWeek !== undefined;
    const nextRunAt = scheduleChanged
      ? computeNextRunAt(
          { frequency, interval, startDate, endDate, dayOfMonth, dayOfWeek },
          new Date(),
        ) ?? existing.nextRunAt
      : existing.nextRunAt;

    return this.prisma.recurringRule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.template !== undefined && {
          templateJson: dto.template as unknown as Prisma.InputJsonValue,
        }),
        frequency,
        interval,
        startDate,
        endDate,
        dayOfMonth,
        dayOfWeek,
        ...(dto.active !== undefined && { active: dto.active }),
        nextRunAt,
      },
    });
  }

  async softDelete(workspaceId: string, id: string) {
    await this.getById(workspaceId, id);
    await this.prisma.recurringRule.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }

  /** Запустить правило вручную (run-now). Возвращает счётчик созданных. */
  async runRule(workspaceId: string, id: string, userId: string, now = new Date()) {
    const rule = await this.getById(workspaceId, id);
    if (!rule.active) return { created: 0, skipped: 0, reason: 'inactive' as const };
    return this.runOne(rule as RuleWithTemplate, userId, now);
  }

  /** Прокрутить все правила, у которых nextRunAt <= now. Для cron-планировщика. */
  async runDue(now = new Date()) {
    const due = await this.prisma.recurringRule.findMany({
      where: {
        active: true,
        deletedAt: null,
        nextRunAt: { lte: now },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      include: { workspace: { select: { id: true, deletedAt: true } } },
    });

    let totalCreated = 0;
    let processed = 0;
    for (const rule of due) {
      if (rule.workspace.deletedAt) continue;
      // Используем owner workspace в качестве createdBy для авто-генерированных
      const owner = await this.prisma.workspace.findFirst({
        where: { id: rule.workspaceId },
        select: { ownerId: true },
      });
      if (!owner) continue;
      const result = await this.runOne(rule as RuleWithTemplate, owner.ownerId, now);
      totalCreated += result.created;
      processed++;
    }
    return { rules: processed, created: totalCreated };
  }

  private async runOne(rule: RuleWithTemplate, userId: string, now: Date) {
    const schedule: ScheduleInput = {
      frequency: rule.frequency,
      interval: rule.interval,
      startDate: rule.startDate,
      endDate: rule.endDate,
      dayOfMonth: rule.dayOfMonth,
      dayOfWeek: rule.dayOfWeek,
    };
    const occurrences = enumerateOccurrences(schedule, {
      lastRunAt: rule.lastRunAt,
      now,
    });

    if (occurrences.length === 0) {
      const nextRunAt = computeNextRunAt(schedule, now) ?? rule.nextRunAt;
      await this.prisma.recurringRule.update({
        where: { id: rule.id },
        data: { nextRunAt },
      });
      return { created: 0, skipped: 0, reason: 'no-occurrences' as const };
    }

    const template = rule.templateJson as {
      amount: string;
      type: 'INCOME' | 'EXPENSE';
      accountId: string;
      categoryId?: string | null;
      counterpartyId?: string | null;
      description?: string | null;
    };

    let created = 0;
    let skipped = 0;
    for (const occurrenceDate of occurrences) {
      try {
        await this.prisma.transaction.create({
          data: {
            workspaceId: rule.workspaceId,
            accountId: template.accountId,
            date: occurrenceDate,
            amount: template.amount,
            type: template.type,
            description: template.description ?? null,
            categoryId: template.categoryId ?? null,
            counterpartyId: template.counterpartyId ?? null,
            recurringRuleId: rule.id,
            recurringOccurrenceDate: occurrenceDate,
            createdById: userId,
          },
        });
        created++;
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          skipped++; // idempotent: уже создано
        } else {
          throw e;
        }
      }
    }

    const nextRunAt = computeNextRunAt(schedule, now) ?? rule.nextRunAt;
    await this.prisma.recurringRule.update({
      where: { id: rule.id },
      data: { lastRunAt: now, nextRunAt },
    });

    return { created, skipped };
  }
}
