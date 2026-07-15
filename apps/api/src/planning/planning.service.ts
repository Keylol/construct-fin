import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TransactionKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { money } from '../common/money';
import {
  assertNotFuture,
  businessDayParts,
  businessInstant,
  startOfDay,
} from '../reports/period';
import { recurrenceOccurrences, type RecurrenceRule } from './recurrence';
import type {
  CreatePlannedDto,
  CreateRecurringDto,
  PayPlannedDto,
  PlannedListQuery,
  UpdatePlannedDto,
  UpdateRecurringDto,
} from './planning.dto';

const DAY_MS = 86_400_000;

// Все плановые kind'ы — расходные оттоки: проводка оплаты всегда EXPENSE.
function txTypeForKind(_kind: TransactionKind): 'EXPENSE' {
  return 'EXPENSE';
}

const RECURRING_INCLUDE = {
  account: { select: { name: true } },
  category: { select: { name: true } },
  counterparty: { select: { name: true } },
} as const;

const PLANNED_INCLUDE = {
  account: { select: { name: true } },
  category: { select: { name: true } },
  counterparty: { select: { name: true } },
  recurring: { select: { title: true } },
} as const;

@Injectable()
export class PlanningService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────── Регулярные платежи ─────────────────────────

  async listRecurring(workspaceId: string) {
    const rows = await this.prisma.recurringPayment.findMany({
      where: { workspaceId, deletedAt: null },
      include: RECURRING_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { title: 'asc' }],
    });
    return rows.map((r) => this.serializeRecurring(r));
  }

  async createRecurring(workspaceId: string, userId: string, dto: CreateRecurringDto) {
    await this.assertRefs(workspaceId, dto);
    const created = await this.prisma.recurringPayment.create({
      data: {
        workspaceId,
        title: dto.title,
        amount: money(dto.amount),
        txKind: dto.txKind,
        cadence: dto.cadence,
        dayOfMonth: dto.cadence === 'MONTHLY' ? dto.dayOfMonth ?? null : null,
        weekday: dto.cadence === 'WEEKLY' ? dto.weekday ?? null : null,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        leadDays: dto.leadDays,
        isActive: dto.isActive,
        accountId: dto.accountId ?? null,
        categoryId: dto.categoryId ?? null,
        counterpartyId: dto.counterpartyId ?? null,
        note: dto.note ?? null,
        createdById: userId,
      },
      include: RECURRING_INCLUDE,
    });
    return this.serializeRecurring(created);
  }

  async updateRecurring(workspaceId: string, id: string, dto: UpdateRecurringDto) {
    const existing = await this.prisma.recurringPayment.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Регулярный платёж не найден');
    await this.assertRefs(workspaceId, dto);

    const cadence = dto.cadence ?? existing.cadence;
    // Атомарная мутация с workspaceId+deletedAt в WHERE (не update по голому id):
    // закрывает и cross-tenant, и гонку с параллельным soft-delete между findFirst
    // и записью (иначе update воскресил бы удалённую строку).
    const res = await this.prisma.recurringPayment.updateMany({
      where: { id, workspaceId, deletedAt: null },
      data: {
        title: dto.title ?? undefined,
        amount: dto.amount !== undefined ? money(dto.amount) : undefined,
        txKind: dto.txKind ?? undefined,
        cadence: dto.cadence ?? undefined,
        // Смена периодичности синхронизирует «второе» поле графика в null.
        dayOfMonth:
          dto.dayOfMonth !== undefined
            ? cadence === 'MONTHLY'
              ? dto.dayOfMonth
              : null
            : cadence === 'WEEKLY'
              ? null
              : undefined,
        weekday:
          dto.weekday !== undefined
            ? cadence === 'WEEKLY'
              ? dto.weekday
              : null
            : cadence === 'MONTHLY'
              ? null
              : undefined,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate === undefined ? undefined : dto.endDate ? new Date(dto.endDate) : null,
        leadDays: dto.leadDays ?? undefined,
        isActive: dto.isActive ?? undefined,
        accountId: dto.accountId === undefined ? undefined : dto.accountId,
        categoryId: dto.categoryId === undefined ? undefined : dto.categoryId,
        counterpartyId: dto.counterpartyId === undefined ? undefined : dto.counterpartyId,
        note: dto.note === undefined ? undefined : dto.note,
      },
    });
    if (res.count === 0) throw new NotFoundException('Регулярный платёж не найден');
    const updated = await this.prisma.recurringPayment.findUniqueOrThrow({
      where: { id },
      include: RECURRING_INCLUDE,
    });
    return this.serializeRecurring(updated);
  }

  /** Мягко удалить правило + отменить его будущие НЕоплаченные плановые позиции. */
  async deleteRecurring(workspaceId: string, id: string) {
    const now = new Date();
    const res = await this.prisma.$transaction(async (tx) => {
      const del = await tx.recurringPayment.updateMany({
        where: { id, workspaceId, deletedAt: null },
        data: { deletedAt: now, isActive: false },
      });
      if (del.count === 0) return 0;
      // Будущие ожидаемые позиции из этого правила больше не актуальны.
      await tx.plannedPayment.updateMany({
        where: { recurringId: id, workspaceId, status: 'PLANNED', deletedAt: null },
        data: { status: 'CANCELLED' },
      });
      return del.count;
    });
    if (res === 0) throw new NotFoundException('Регулярный платёж не найден');
    return { ok: true };
  }

  // ───────────────────────── Плановые платежи ─────────────────────────

  async listPlanned(workspaceId: string, q: PlannedListQuery) {
    const rows = await this.prisma.plannedPayment.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(q.counterpartyId ? { counterpartyId: q.counterpartyId } : {}),
        ...(q.from || q.to
          ? { dueDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
          : {}),
      },
      include: PLANNED_INCLUDE,
      orderBy: [{ dueDate: 'asc' }],
    });
    const today = startOfDay(new Date());
    return rows.map((r) => this.serializePlanned(r, today));
  }

  async createPlanned(workspaceId: string, userId: string, dto: CreatePlannedDto) {
    await this.assertRefs(workspaceId, dto);
    const created = await this.prisma.plannedPayment.create({
      data: {
        workspaceId,
        title: dto.title,
        amount: money(dto.amount),
        txKind: dto.source === 'SALARY' ? 'SALARY' : dto.txKind,
        dueDate: new Date(dto.dueDate),
        source: dto.source,
        status: 'PLANNED',
        leadDays: dto.leadDays,
        accountId: dto.accountId ?? null,
        categoryId: dto.categoryId ?? null,
        counterpartyId: dto.counterpartyId ?? null,
        note: dto.note ?? null,
        createdById: userId,
      },
      include: PLANNED_INCLUDE,
    });
    return this.serializePlanned(created, startOfDay(new Date()));
  }

  /** Правка плановой позиции разрешена, только пока она в ожидании (PLANNED). */
  async updatePlanned(workspaceId: string, id: string, dto: UpdatePlannedDto) {
    const existing = await this.prisma.plannedPayment.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Плановый платёж не найден');
    if (existing.status !== 'PLANNED') {
      throw new BadRequestException('Править можно только платёж в статусе «ожидается»');
    }
    await this.assertRefs(workspaceId, dto);
    // Атомарно с guard'ом статуса: если между проверкой и записью план успели
    // оплатить (PLANNED→PAID), правка не пройдёт (count=0) — не редактируем факт.
    const res = await this.prisma.plannedPayment.updateMany({
      where: { id, workspaceId, deletedAt: null, status: 'PLANNED' },
      data: {
        title: dto.title ?? undefined,
        amount: dto.amount !== undefined ? money(dto.amount) : undefined,
        txKind: dto.txKind ?? undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        leadDays: dto.leadDays ?? undefined,
        accountId: dto.accountId === undefined ? undefined : dto.accountId,
        categoryId: dto.categoryId === undefined ? undefined : dto.categoryId,
        counterpartyId: dto.counterpartyId === undefined ? undefined : dto.counterpartyId,
        note: dto.note === undefined ? undefined : dto.note,
      },
    });
    if (res.count === 0) {
      throw new BadRequestException('Платёж изменился (уже оплачен?) — обновите список');
    }
    const updated = await this.prisma.plannedPayment.findUniqueOrThrow({
      where: { id },
      include: PLANNED_INCLUDE,
    });
    return this.serializePlanned(updated, startOfDay(new Date()));
  }

  /** Пропустить/отменить/вернуть в ожидание. Оплаченный план сначала отменяют оплату. */
  async setPlannedStatus(workspaceId: string, id: string, status: 'PLANNED' | 'SKIPPED' | 'CANCELLED') {
    const existing = await this.prisma.plannedPayment.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: { status: true },
    });
    if (!existing) throw new NotFoundException('Плановый платёж не найден');
    if (existing.status === 'PAID') {
      throw new BadRequestException('Сначала отмените оплату этого платежа');
    }
    await this.prisma.plannedPayment.updateMany({
      where: { id, workspaceId, deletedAt: null, status: { not: 'PAID' } },
      data: { status },
    });
    return { ok: true };
  }

  async deletePlanned(workspaceId: string, id: string) {
    const existing = await this.prisma.plannedPayment.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: { status: true },
    });
    if (!existing) throw new NotFoundException('Плановый платёж не найден');
    if (existing.status === 'PAID') {
      throw new BadRequestException('Сначала отмените оплату этого платежа');
    }
    // Атомарно: не удаляем, если план успели оплатить между проверкой и записью.
    const res = await this.prisma.plannedPayment.updateMany({
      where: { id, workspaceId, deletedAt: null, status: { not: 'PAID' } },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new BadRequestException('Сначала отмените оплату этого платежа');
    return { ok: true };
  }

  /**
   * Оплатить план → кладёт проводку на общую шину и переводит в PAID. Два режима:
   *  • transactionId — привязать УЖЕ существующую операцию (autoTx=false);
   *  • accountId+amount+date — создать новую EXPENSE-проводку (autoTx=true).
   * Атомарно: создание/привязка проводки и перевод статуса в одной транзакции с
   * compare-and-swap по статусу (гонка двойного клика не задвоит оплату).
   */
  async payPlanned(workspaceId: string, userId: string, id: string, dto: PayPlannedDto) {
    const plan = await this.prisma.plannedPayment.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!plan) throw new NotFoundException('Плановый платёж не найден');
    if (plan.status === 'PAID') throw new BadRequestException('Платёж уже оплачен');

    // Режим привязки существующей операции.
    if (dto.transactionId) {
      const existingTx = await this.prisma.transaction.findFirst({
        where: { id: dto.transactionId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!existingTx) throw new NotFoundException('Операция не найдена в этом пространстве');
      const taken = await this.prisma.plannedPayment.findFirst({
        where: { matchedTransactionId: dto.transactionId, deletedAt: null, id: { not: id } },
        select: { id: true },
      });
      if (taken) throw new ConflictException('Эта операция уже привязана к другому плану');
      return this.claimPaid(workspaceId, id, dto.transactionId, false);
    }

    // Режим создания новой проводки.
    if (!dto.accountId) throw new BadRequestException('Укажите счёт списания');
    const acc = await this.prisma.account.findFirst({
      where: { id: dto.accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!acc) throw new NotFoundException('Счёт не найден в этом пространстве');
    const date = dto.date ? new Date(dto.date) : new Date();
    assertNotFuture(date, 'Дата оплаты');
    const amount = dto.amount !== undefined ? money(dto.amount) : plan.amount;

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          workspaceId,
          accountId: dto.accountId!,
          date,
          amount,
          type: txTypeForKind(plan.txKind),
          kind: plan.txKind,
          categoryId: plan.categoryId,
          counterpartyId: plan.counterpartyId,
          description: dto.note?.trim() || plan.title,
          createdById: userId,
        },
        select: { id: true },
      });
      const claim = await tx.plannedPayment.updateMany({
        where: { id, workspaceId, deletedAt: null, status: { not: 'PAID' } },
        data: { status: 'PAID', matchedTransactionId: created.id, autoTx: true },
      });
      if (claim.count === 0) throw new ConflictException('Платёж уже оплачен другим действием');
      return { ok: true, transactionId: created.id };
    });
  }

  /** Отменить оплату: авто-проводку удаляем (soft), привязанную — только отвязываем. */
  async revertPlanned(workspaceId: string, id: string) {
    const plan = await this.prisma.plannedPayment.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: { status: true, matchedTransactionId: true, autoTx: true },
    });
    if (!plan) throw new NotFoundException('Плановый платёж не найден');
    if (plan.status !== 'PAID') throw new BadRequestException('Платёж не оплачен');

    await this.prisma.$transaction(async (tx) => {
      // Claim-first: сперва атомарно снимаем оплату (PAID→PLANNED). Проводку
      // удаляем ТОЛЬКО если claim выиграл — параллельный revert (count=0) откатит
      // транзакцию, не тронув чужую работу.
      const claim = await tx.plannedPayment.updateMany({
        where: { id, workspaceId, status: 'PAID' },
        data: { status: 'PLANNED', matchedTransactionId: null, autoTx: false },
      });
      if (claim.count === 0) throw new ConflictException('Оплата уже отменена');
      if (plan.autoTx && plan.matchedTransactionId) {
        await tx.transaction.updateMany({
          where: { id: plan.matchedTransactionId, workspaceId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
    });
    return { ok: true };
  }

  // ───────────────────────── Материализация / горизонт ─────────────────────────

  /**
   * Сгенерировать плановые позиции из активных правил на горизонт вперёд.
   * Идемпотентно: на (правило, дата) — одна позиция (partial-unique в БД +
   * проверка существующих). Повторный прогон/крон не задваивает.
   */
  async materialize(workspaceId: string, horizonDays = 45): Promise<{ created: number }> {
    const rules = await this.prisma.recurringPayment.findMany({
      where: { workspaceId, isActive: true, deletedAt: null },
    });
    if (rules.length === 0) return { created: 0 };

    const now = new Date();
    const t = businessDayParts(now);
    const windowEnd = businessInstant(t.y, t.mo, t.d + horizonDays, 23);
    let created = 0;

    for (const rule of rules) {
      const windowStart =
        rule.cadence === 'MONTHLY'
          ? businessInstant(t.y, t.mo, 1, 0) // с начала текущего месяца (ловим просроченное)
          : businessInstant(t.y, t.mo, t.d - 14, 0); // недельная: backfill 2 недели
      const occ = recurrenceOccurrences(rule as RecurrenceRule, windowStart, windowEnd);
      if (occ.length === 0) continue;

      const existing = await this.prisma.plannedPayment.findMany({
        where: { recurringId: rule.id, deletedAt: null, dueDate: { in: occ } },
        select: { dueDate: true },
      });
      const seen = new Set(existing.map((e) => e.dueDate.getTime()));

      for (const due of occ) {
        if (seen.has(due.getTime())) continue;
        try {
          await this.prisma.plannedPayment.create({
            data: {
              workspaceId,
              title: rule.title,
              amount: rule.amount,
              txKind: rule.txKind,
              dueDate: due,
              source: 'RECURRING',
              status: 'PLANNED',
              leadDays: rule.leadDays,
              recurringId: rule.id,
              accountId: rule.accountId,
              categoryId: rule.categoryId,
              counterpartyId: rule.counterpartyId,
              note: rule.note,
              createdById: rule.createdById,
            },
          });
          created++;
        } catch (e) {
          // Гонка с параллельной материализацией → partial-unique P2002: пропускаем.
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        }
      }
    }
    return { created };
  }

  /**
   * Ближайшие платежи: просроченные + попадающие в горизонт. Перед выдачей
   * материализует правила, чтобы горизонт был заполнен. Каждой позиции считает
   * dueInDays/overdue/soon; отдаёт счётчики и суммы для сводки и бейджа.
   */
  async upcoming(workspaceId: string, horizonDays = 30) {
    await this.materialize(workspaceId, Math.max(horizonDays, 45));
    const now = new Date();
    const today = startOfDay(now);
    const t = businessDayParts(now);
    const horizonEnd = businessInstant(t.y, t.mo, t.d + horizonDays, 23);

    const rows = await this.prisma.plannedPayment.findMany({
      where: { workspaceId, deletedAt: null, status: 'PLANNED', dueDate: { lte: horizonEnd } },
      include: PLANNED_INCLUDE,
      orderBy: [{ dueDate: 'asc' }],
    });

    const items = rows.map((r) => this.serializePlanned(r, today));
    // Суммы считаем из «сырых» Decimal (rows), чтобы не парсить строки обратно.
    let overdueSum = new Prisma.Decimal(0);
    let soonSum = new Prisma.Decimal(0);
    let overdueCount = 0;
    let soonCount = 0;
    items.forEach((it, i) => {
      const row = rows[i]!; // items = rows.map — индексы совпадают 1:1
      if (it.overdue) {
        overdueCount++;
        overdueSum = overdueSum.add(row.amount);
      } else if (it.soon) {
        soonCount++;
        soonSum = soonSum.add(row.amount);
      }
    });
    return {
      horizonDays,
      items,
      overdueCount,
      soonCount,
      overdueSum: overdueSum.toFixed(2),
      soonSum: soonSum.toFixed(2),
    };
  }

  /** Дешёвый счётчик для бейджа навигации: просроченные + «горит» по leadDays. */
  async attentionCount(workspaceId: string): Promise<{ count: number }> {
    const now = new Date();
    const today = startOfDay(now);
    const t = businessDayParts(now);
    const cap = businessInstant(t.y, t.mo, t.d + 60, 23); // разумный потолок выборки
    const rows = await this.prisma.plannedPayment.findMany({
      where: { workspaceId, deletedAt: null, status: 'PLANNED', dueDate: { lte: cap } },
      select: { dueDate: true, leadDays: true },
    });
    let count = 0;
    for (const r of rows) {
      const dueInDays = Math.round((startOfDay(r.dueDate).getTime() - today.getTime()) / DAY_MS);
      if (dueInDays < 0 || dueInDays <= r.leadDays) count++;
    }
    return { count };
  }

  // ───────────────────────── helpers ─────────────────────────

  private async assertRefs(
    workspaceId: string,
    dto: { accountId?: string | null; categoryId?: string | null; counterpartyId?: string | null },
  ) {
    if (dto.accountId) {
      const a = await this.prisma.account.findFirst({
        where: { id: dto.accountId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!a) throw new BadRequestException('Счёт не найден в этом пространстве');
    }
    if (dto.categoryId) {
      const c = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!c) throw new BadRequestException('Категория не найдена в этом пространстве');
    }
    if (dto.counterpartyId) {
      const cp = await this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!cp) throw new BadRequestException('Контрагент не найден в этом пространстве');
    }
  }

  private async claimPaid(workspaceId: string, id: string, transactionId: string, autoTx: boolean) {
    const claim = await this.prisma.plannedPayment.updateMany({
      where: { id, workspaceId, deletedAt: null, status: { not: 'PAID' } },
      data: { status: 'PAID', matchedTransactionId: transactionId, autoTx },
    });
    if (claim.count === 0) throw new ConflictException('Платёж уже оплачен другим действием');
    return { ok: true, transactionId };
  }

  private serializeRecurring(
    r: Prisma.RecurringPaymentGetPayload<{ include: typeof RECURRING_INCLUDE }>,
  ) {
    const nextDue = this.nextDueDate(r);
    return {
      id: r.id,
      title: r.title,
      amount: r.amount.toFixed(2),
      txKind: r.txKind,
      cadence: r.cadence,
      dayOfMonth: r.dayOfMonth,
      weekday: r.weekday,
      startDate: r.startDate.toISOString(),
      endDate: r.endDate ? r.endDate.toISOString() : null,
      leadDays: r.leadDays,
      isActive: r.isActive,
      accountId: r.accountId,
      accountName: r.account?.name ?? null,
      categoryId: r.categoryId,
      categoryName: r.category?.name ?? null,
      counterpartyId: r.counterpartyId,
      counterpartyName: r.counterparty?.name ?? null,
      note: r.note,
      nextDueDate: nextDue ? nextDue.toISOString() : null,
    };
  }

  /** Ближайшая будущая дата вхождения правила (для карточки регулярки). */
  private nextDueDate(r: {
    cadence: 'MONTHLY' | 'WEEKLY';
    dayOfMonth: number | null;
    weekday: number | null;
    startDate: Date;
    endDate: Date | null;
    isActive: boolean;
  }): Date | null {
    if (!r.isActive) return null;
    const now = new Date();
    const today = startOfDay(now);
    const t = businessDayParts(now);
    const windowEnd = businessInstant(t.y, t.mo, t.d + 366, 23);
    const occ = recurrenceOccurrences(r as RecurrenceRule, today, windowEnd);
    return occ[0] ?? null;
  }

  private serializePlanned(
    p: Prisma.PlannedPaymentGetPayload<{ include: typeof PLANNED_INCLUDE }>,
    today: Date,
  ) {
    const dueInDays = Math.round((startOfDay(p.dueDate).getTime() - today.getTime()) / DAY_MS);
    const overdue = p.status === 'PLANNED' && dueInDays < 0;
    const soon = p.status === 'PLANNED' && !overdue && dueInDays <= p.leadDays;
    return {
      id: p.id,
      title: p.title,
      amount: p.amount.toFixed(2),
      txKind: p.txKind,
      dueDate: p.dueDate.toISOString(),
      source: p.source,
      status: p.status,
      leadDays: p.leadDays,
      dueInDays,
      overdue,
      soon,
      recurringId: p.recurringId,
      recurringTitle: p.recurring?.title ?? null,
      accountId: p.accountId,
      accountName: p.account?.name ?? null,
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      counterpartyId: p.counterpartyId,
      counterpartyName: p.counterparty?.name ?? null,
      note: p.note,
      matchedTransactionId: p.matchedTransactionId,
      autoTx: p.autoTx,
    };
  }
}
