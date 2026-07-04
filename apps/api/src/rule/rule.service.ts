import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { applyRules, type RuleCondition, type RuleAction, type RuleSuggestion } from './engine';
import type { CreateRuleDto, UpdateRuleDto, SuggestDto } from './rule.dto';

@Injectable()
export class RuleService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.rule.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
      take: 500,
    });
  }

  async create(workspaceId: string, input: CreateRuleDto) {
    await this.assertRefsBelong(workspaceId, input.conditions, input.actions);
    return this.prisma.rule.create({
      data: {
        workspaceId,
        name: input.name,
        priority: input.priority,
        isActive: input.isActive,
        appliesTo: input.appliesTo,
        conditions: input.conditions as unknown as Prisma.InputJsonValue,
        actions: input.actions as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async update(workspaceId: string, id: string, input: UpdateRuleDto) {
    const existing = await this.prisma.rule.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Rule not found');
    // Ревалидируем ссылки, только если условия/действия меняются — на НОВЫХ значениях
    // (или на существующих, если приходит частичное обновление одного из массивов).
    if (input.conditions !== undefined || input.actions !== undefined) {
      const conditions = input.conditions ?? (existing.conditions as unknown as RuleCondition[]);
      const actions = input.actions ?? (existing.actions as unknown as RuleAction[]);
      await this.assertRefsBelong(workspaceId, conditions, actions);
    }
    return this.prisma.rule.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        priority: input.priority ?? undefined,
        isActive: input.isActive ?? undefined,
        appliesTo: input.appliesTo ?? undefined,
        conditions:
          input.conditions !== undefined
            ? (input.conditions as unknown as Prisma.InputJsonValue)
            : undefined,
        actions:
          input.actions !== undefined
            ? (input.actions as unknown as Prisma.InputJsonValue)
            : undefined,
      },
    });
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.rule.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Rule not found');
    await this.prisma.rule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /**
   * Подсказки для формы/импорта: грузим активные правила, применимые к источнику
   * (appliesTo ⊇ source), и прогоняем чистый движок. Возвращаем что подставить +
   * какие правила сработали. Деньги НЕ трогаем — фронт показывает подсказку.
   */
  async suggest(workspaceId: string, input: SuggestDto): Promise<RuleSuggestion> {
    const scope = input.source === 'IMPORT' ? ['IMPORT', 'BOTH'] : ['MANUAL', 'BOTH'];
    const rules = await this.prisma.rule.findMany({
      where: { workspaceId, deletedAt: null, isActive: true, appliesTo: { in: scope } },
    });
    const suggestion = applyRules(
      rules.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        conditions: r.conditions as unknown as RuleCondition[],
        actions: r.actions as unknown as RuleAction[],
      })),
      {
        description: input.description,
        counterpartyId: input.counterpartyId,
        counterpartyName: input.counterpartyName,
        accountId: input.accountId,
        amount: input.amount,
        type: input.type,
        source: input.source,
      },
    );
    // Правило переживает soft-delete сущности, на которую ссылается (ссылки в JSON
    // валидируются только при create/update, cascade нет). Отсеиваем «мёртвые»
    // подсказки — иначе фронт подставит удалённую категорию/контрагента/счёт, и
    // сохранение упадёт с невнятной ошибкой «не найдено в workspace».
    return this.pruneDeadRefs(workspaceId, suggestion);
  }

  private async pruneDeadRefs(
    workspaceId: string,
    s: RuleSuggestion,
  ): Promise<RuleSuggestion> {
    const checks: Promise<void>[] = [];
    if (s.categoryId) {
      const id = s.categoryId;
      checks.push(
        this.prisma.category
          .count({ where: { id, workspaceId, deletedAt: null } })
          .then((n) => {
            if (n === 0) delete s.categoryId;
          }),
      );
    }
    if (s.counterpartyId) {
      const id = s.counterpartyId;
      checks.push(
        this.prisma.counterparty
          .count({ where: { id, workspaceId, deletedAt: null } })
          .then((n) => {
            if (n === 0) delete s.counterpartyId;
          }),
      );
    }
    if (s.accountId) {
      const id = s.accountId;
      checks.push(
        this.prisma.account
          .count({ where: { id, workspaceId, deletedAt: null } })
          .then((n) => {
            if (n === 0) delete s.accountId;
          }),
      );
    }
    await Promise.all(checks);
    return s;
  }

  /**
   * Cross-tenant guard: все id категорий/контрагентов/счетов, зашитые в условия/
   * действия, обязаны принадлежать этому workspace. FK внутри JSON не enforce-ится,
   * поэтому проверяем здесь — иначе правило могло бы подставить чужую сущность.
   */
  private async assertRefsBelong(
    workspaceId: string,
    conditions: RuleCondition[],
    actions: RuleAction[],
  ) {
    const categoryIds = new Set<string>();
    const counterpartyIds = new Set<string>();
    const accountIds = new Set<string>();
    for (const c of conditions) {
      if (c.type === 'COUNTERPARTY_EQUALS') counterpartyIds.add(c.counterpartyId);
      else if (c.type === 'ACCOUNT_EQUALS') accountIds.add(c.accountId);
    }
    for (const a of actions) {
      if (a.type === 'SET_CATEGORY') categoryIds.add(a.categoryId);
      else if (a.type === 'SET_COUNTERPARTY') counterpartyIds.add(a.counterpartyId);
      else if (a.type === 'SET_ACCOUNT') accountIds.add(a.accountId);
    }
    await Promise.all([
      this.assertCount('категория', categoryIds, (ids) =>
        this.prisma.category.count({ where: { id: { in: ids }, workspaceId, deletedAt: null } }),
      ),
      this.assertCount('контрагент', counterpartyIds, (ids) =>
        this.prisma.counterparty.count({ where: { id: { in: ids }, workspaceId, deletedAt: null } }),
      ),
      this.assertCount('счёт', accountIds, (ids) =>
        this.prisma.account.count({ where: { id: { in: ids }, workspaceId, deletedAt: null } }),
      ),
    ]);
  }

  private async assertCount(
    label: string,
    ids: Set<string>,
    counter: (ids: string[]) => Promise<number>,
  ) {
    if (ids.size === 0) return;
    const arr = [...ids];
    const found = await counter(arr);
    if (found !== arr.length) {
      throw new BadRequestException(`Правило ссылается на чужой ресурс: ${label}`);
    }
  }
}
