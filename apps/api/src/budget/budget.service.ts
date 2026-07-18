import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { money } from '../common/money';
import { businessDayParts, businessInstant } from '../reports/period';
import type { BudgetListQuery, CreateBudgetDto, UpdateBudgetDto } from './budget.dto';

/**
 * Бюджет план/факт: один действующий месячный лимит на категорию
 * (partial-unique Budget_workspaceId_categoryId_active_key), факт считается
 * за выбранный месяц по транзакциям категории И её подкатегорий.
 *
 * Для расходной категории факт = Σ EXPENSE − Σ INCOME (возврат уменьшает факт),
 * для доходной — Σ INCOME − Σ EXPENSE. «Использование» = факт / план.
 */

export interface BudgetRow {
  id: string;
  categoryId: string;
  categoryName: string;
  kind: 'INCOME' | 'EXPENSE';
  amount: string;
  note: string | null;
  fact: string;
  /** Факт / план × 100, 1 знак. */
  usagePct: number;
  /** EXPENSE: факт превысил лимит. INCOME: план не достигнут — false (не «перерасход»). */
  over: boolean;
}

export interface BudgetReport {
  month: string; // YYYY-MM
  rows: BudgetRow[];
  totals: {
    expensePlan: string;
    expenseFact: string;
    incomePlan: string;
    incomeFact: string;
    overCount: number;
  };
}

const D0 = new Prisma.Decimal(0);

@Injectable()
export class BudgetService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, q: BudgetListQuery): Promise<BudgetReport> {
    const { y, mo0, label } = this.resolveMonth(q.month);
    const from = businessInstant(y, mo0, 1, 0);
    const to = businessInstant(y, mo0 + 1, 1, 0); // date < to

    const budgets = await this.prisma.budget.findMany({
      where: { workspaceId, deletedAt: null },
      include: {
        category: { select: { id: true, name: true, kind: true, parentId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (budgets.length === 0) {
      return {
        month: label,
        rows: [],
        totals: {
          expensePlan: '0.00',
          expenseFact: '0.00',
          incomePlan: '0.00',
          incomeFact: '0.00',
          overCount: 0,
        },
      };
    }

    // Дети бюджетных категорий (иерархия 2 уровня): факт родителя включает детей.
    const catIds = budgets.map((b) => b.categoryId);
    const children = await this.prisma.category.findMany({
      where: { workspaceId, deletedAt: null, parentId: { in: catIds } },
      select: { id: true, parentId: true },
    });
    const childrenByParent = new Map<string, string[]>();
    for (const c of children) {
      if (!c.parentId) continue;
      childrenByParent.set(c.parentId, [...(childrenByParent.get(c.parentId) ?? []), c.id]);
    }

    // Один groupBy на все затронутые категории за месяц.
    const allIds = [...new Set([...catIds, ...children.map((c) => c.id)])];
    const sums = await this.prisma.transaction.groupBy({
      by: ['categoryId', 'type'],
      where: {
        workspaceId,
        deletedAt: null,
        categoryId: { in: allIds },
        date: { gte: from, lt: to },
      },
      _sum: { amount: true },
    });
    const net = new Map<string, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
    for (const s of sums) {
      if (!s.categoryId) continue;
      const e = net.get(s.categoryId) ?? { income: D0, expense: D0 };
      const amount = new Prisma.Decimal(s._sum.amount ?? 0);
      if (s.type === 'INCOME') e.income = e.income.plus(amount);
      else e.expense = e.expense.plus(amount);
      net.set(s.categoryId, e);
    }
    const factFor = (categoryId: string, kind: 'INCOME' | 'EXPENSE'): Prisma.Decimal => {
      const ids = [categoryId, ...(childrenByParent.get(categoryId) ?? [])];
      let income = D0;
      let expense = D0;
      for (const id of ids) {
        const e = net.get(id);
        if (!e) continue;
        income = income.plus(e.income);
        expense = expense.plus(e.expense);
      }
      return kind === 'EXPENSE' ? expense.minus(income) : income.minus(expense);
    };

    let expensePlan = D0;
    let expenseFact = D0;
    let incomePlan = D0;
    let incomeFact = D0;
    let overCount = 0;
    const rows: BudgetRow[] = budgets.map((b) => {
      const kind = b.category.kind;
      const plan = new Prisma.Decimal(b.amount);
      const fact = factFor(b.categoryId, kind);
      const usagePct = plan.greaterThan(0)
        ? Number(fact.div(plan).times(100).toFixed(1))
        : 0;
      const over = kind === 'EXPENSE' && fact.greaterThan(plan);
      if (kind === 'EXPENSE') {
        expensePlan = expensePlan.plus(plan);
        expenseFact = expenseFact.plus(fact);
        if (over) overCount++;
      } else {
        incomePlan = incomePlan.plus(plan);
        incomeFact = incomeFact.plus(fact);
      }
      return {
        id: b.id,
        categoryId: b.categoryId,
        categoryName: b.category.name,
        kind,
        amount: plan.toFixed(2),
        note: b.note,
        fact: fact.toFixed(2),
        usagePct,
        over,
      };
    });
    // Расходы вперёд (контроль лимитов важнее), внутри — по убыванию использования.
    rows.sort((a, b) =>
      a.kind === b.kind ? b.usagePct - a.usagePct : a.kind === 'EXPENSE' ? -1 : 1,
    );

    return {
      month: label,
      rows,
      totals: {
        expensePlan: expensePlan.toFixed(2),
        expenseFact: expenseFact.toFixed(2),
        incomePlan: incomePlan.toFixed(2),
        incomeFact: incomeFact.toFixed(2),
        overCount,
      },
    };
  }

  async create(workspaceId: string, userId: string, dto: CreateBudgetDto) {
    const cat = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!cat) throw new BadRequestException('Категория не найдена в этом пространстве');
    try {
      return await this.prisma.budget.create({
        data: {
          workspaceId,
          categoryId: dto.categoryId,
          amount: money(dto.amount),
          note: dto.note ?? null,
          createdById: userId,
        },
        select: { id: true },
      });
    } catch (e) {
      // Partial-unique (workspaceId, categoryId) WHERE deletedAt IS NULL.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Бюджет по этой категории уже задан');
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: UpdateBudgetDto) {
    const res = await this.prisma.budget.updateMany({
      where: { id, workspaceId, deletedAt: null },
      data: {
        amount: dto.amount !== undefined ? money(dto.amount) : undefined,
        note: dto.note === undefined ? undefined : dto.note,
      },
    });
    if (res.count === 0) throw new NotFoundException('Бюджет не найден');
    return { ok: true };
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.budget.updateMany({
      where: { id, workspaceId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Бюджет не найден');
    return { ok: true };
  }

  /** month=YYYY-MM или текущий бизнес-месяц (UTC+5). */
  private resolveMonth(month?: string): { y: number; mo0: number; label: string } {
    if (month) {
      const [ys, ms] = month.split('-');
      const y = Number(ys);
      const mo0 = Number(ms) - 1;
      return { y, mo0, label: month };
    }
    const t = businessDayParts(new Date());
    return { y: t.y, mo0: t.mo, label: `${t.y}-${String(t.mo + 1).padStart(2, '0')}` };
  }
}
