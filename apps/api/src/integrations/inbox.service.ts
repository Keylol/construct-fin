import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AusnMark, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../orders/order.service';
import { RuleService } from '../rule/rule.service';
import { TransferService } from '../transfer/transfer.service';
import { applyRules, type RuleDef } from '../rule/engine';
import { computeRowHash } from '../common/import-hash';
import { matchTransferPairs } from './transfer-match';
import type {
  CategorizeDto,
  ConfirmTransferDto,
  ListInboxQuery,
  UndoBulkDto,
} from './inbox.dto';

/** Потолок строк на один прогон правил: держим ответ быстрым, остаток — следующим
 * вызовом (`remaining` в ответе). */
const APPLY_BATCH = 500;
/** Потолок строк для поиска пар: подбор идёт в памяти и квадратичен по числу строк. */
const TRANSFER_SCAN_LIMIT = 500;

/**
 * Экран «Входящие» (Ф1-C2): разбор строк банковской выписки в статусе NEW.
 * Доступ — обычный член пространства (решение №18: оператор разбирает весь
 * Inbox; закрыты только настройки интеграций/ключи).
 *
 * Действия оператора превращают строку в проводку/оплату заказа или помечают
 * «не учитывать». Обратимо: undo снимает авто/ручную проводку и возвращает
 * строку в Inbox (кроме оплат заказа — те отменяются в карточке заказа).
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly rules: RuleService,
    private readonly transfers: TransferService,
  ) {}

  /** Список строк выбранного статуса (по умолчанию NEW), курсор-пагинация. */
  async list(workspaceId: string, query: ListInboxQuery) {
    const items = await this.prisma.bankStatementLine.findMany({
      where: { workspaceId, status: query.status },
      include: {
        connection: {
          select: { provider: true, account: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    // Имя сработавшего правила: FK на Rule нет (ссылка историческая), поэтому
    // подтягиваем отдельным запросом — иначе на вкладке авто-проведённого не видно,
    // ЧТО именно провело строку, и ревизовать нечего.
    const ruleNames = await this.loadRuleNames(page.map((l) => l.appliedRuleId));
    return {
      items: page.map((l) => ({
        id: l.id,
        date: l.date.toISOString(),
        amount: l.amount.toString(),
        direction: l.direction,
        counterpartyName: l.counterpartyName,
        counterpartyInn: l.counterpartyInn,
        description: l.description,
        ausnMark: l.ausnMark,
        status: l.status,
        adopted: l.adopted,
        suggestedCategoryId: l.suggestedCategoryId,
        appliedRule: l.appliedRuleId
          ? { id: l.appliedRuleId, name: ruleNames.get(l.appliedRuleId) ?? null }
          : null,
        provider: l.connection.provider,
        account: l.connection.account,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  /** Счётчик строк на разбор — для бейджа в навигации. */
  async count(workspaceId: string): Promise<{ count: number }> {
    const count = await this.prisma.bankStatementLine.count({
      where: { workspaceId, status: 'NEW' },
    });
    return { count };
  }

  /** Имена правил по id — правило могло быть удалено мягко, тогда имя просто null. */
  private async loadRuleNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const rules = await this.prisma.rule.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rules.map((r) => [r.id, r.name]));
  }

  /** Разобрать строку → проводка с категорией. */
  async categorize(workspaceId: string, userId: string, lineId: string, dto: CategorizeDto) {
    const line = await this.loadNew(workspaceId, lineId);
    const category = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!category) throw new BadRequestException('Категория не найдена в этом пространстве');
    if (dto.counterpartyId) await this.assertCounterparty(workspaceId, dto.counterpartyId);

    await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          workspaceId,
          accountId: line.connection.accountId,
          date: line.date,
          amount: line.amount,
          type: line.direction,
          kind: 'OTHER',
          categoryId: dto.categoryId,
          counterpartyId: dto.counterpartyId ?? null,
          description: dto.description ?? line.description,
          // Ф4: переносим АУСН-маркировку банка на проводку (приоритетна в базе
          // налога; оператор может переопределить позже через PATCH).
          ausnMark: line.ausnMark,
          // Отпечаток строки — чтобы CSV-выгрузка того же периода, загруженная
          // позже, распознала эту операцию как уже существующую.
          importHash: computeRowHash({
            workspaceId,
            accountId: line.connection.accountId,
            date: line.date,
            amount: line.amount.toString(),
            type: line.direction,
            counterpartyName: line.counterpartyName,
            description: line.description,
          }),
          createdById: userId,
        },
        select: { id: true },
      });
      // Compare-and-swap статуса: обновляем строку, только пока она NEW.
      // Параллельный разбор (двойной клик) не создаст вторую проводку — под
      // локом строки второй updateMany увидит уже RESOLVED и вернёт 0 → откат.
      const claim = await tx.bankStatementLine.updateMany({
        where: { id: line.id, status: 'NEW' },
        data: { status: 'RESOLVED', transactionId: transaction.id, suggestedCategoryId: dto.categoryId },
      });
      if (claim.count === 0) {
        throw new ConflictException('Строка уже обработана другим действием');
      }
    });
    return { ok: true };
  }

  /** Привязать приход к заказу → оплата заказа (ORDER_PAYMENT). */
  async attachOrder(workspaceId: string, userId: string, lineId: string, orderId: string) {
    const line = await this.loadNew(workspaceId, lineId);
    if (line.direction !== 'INCOME') {
      throw new BadRequestException('К заказу привязывается только приход (INCOME)');
    }
    // Застолбить строку ДО создания оплаты: только один параллельный запрос
    // пройдёт CAS (NEW→RESOLVED), остальные получат «уже разобрана» и НЕ создадут
    // дублирующую оплату заказа.
    const claim = await this.prisma.bankStatementLine.updateMany({
      where: { id: line.id, status: 'NEW' },
      data: { status: 'RESOLVED' },
    });
    if (claim.count === 0) {
      throw new ConflictException('Строка уже обработана другим действием');
    }

    try {
      // Оплата создаётся доменным сервисом (лок заказа, пересчёт paidAmount).
      await this.orders.addPayment(workspaceId, orderId, userId, {
        amount: line.amount.toString(),
        accountId: line.connection.accountId,
        date: line.date.toISOString(),
        description: line.description ?? undefined,
      });
    } catch (e) {
      // Заказ отменён/не найден и т.п. — возвращаем строку в Inbox.
      await this.prisma.bankStatementLine.updateMany({
        where: { id: line.id },
        data: { status: 'NEW' },
      });
      throw e;
    }

    // Провенанс (best-effort): свежайшая непривязанная ORDER_PAYMENT этого
    // заказа/счёта/суммы. Гонка привязки к общей оплате даст P2002 — тогда
    // просто оставляем строку без провенанс-линка (деньги/статус корректны).
    const payment = await this.prisma.transaction.findFirst({
      where: {
        workspaceId,
        orderId,
        kind: 'ORDER_PAYMENT',
        accountId: line.connection.accountId,
        amount: line.amount,
        deletedAt: null,
        bankLine: { is: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (payment) {
      try {
        await this.prisma.bankStatementLine.update({
          where: { id: line.id },
          data: { transactionId: payment.id },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    return { ok: true };
  }

  /** «Не учитывать» — строка уходит из Inbox, в отчёты не идёт. */
  async dismiss(workspaceId: string, lineId: string) {
    const line = await this.loadNew(workspaceId, lineId);
    await this.prisma.bankStatementLine.update({
      where: { id: line.id },
      data: { status: 'DISMISSED' },
    });
    return { ok: true };
  }

  /** Отменить разбор: снять созданную проводку, вернуть строку в Inbox. */
  async undo(workspaceId: string, lineId: string) {
    const line = await this.prisma.bankStatementLine.findFirst({
      where: { id: lineId, workspaceId },
      include: { transaction: { select: { id: true, kind: true } } },
    });
    if (!line) throw new NotFoundException('Строка не найдена');
    if (!line.transaction) {
      throw new BadRequestException('У строки нет созданной проводки — отменять нечего');
    }
    // Усыновление: операция существовала до строки и принадлежит человеку —
    // отменяем только привязку. Удалить её значило бы стереть чужую запись
    // вместе с категорией, которую оператор проставил руками.
    if (line.adopted) {
      await this.prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'NEW', transactionId: null, adopted: false },
      });
      return { ok: true };
    }
    // Оплаты заказа завязаны на инварианты заказа — отменяются в его карточке.
    if (line.transaction.kind !== 'OTHER') {
      throw new BadRequestException(
        'Операция создана из заказа — отмените её в карточке заказа',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: line.transaction!.id },
        data: { deletedAt: new Date() },
      });
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'NEW', transactionId: null },
      });
    });
    return { ok: true };
  }

  /**
   * Прогнать правила по строкам, УЖЕ лежащим на разборе. Правила срабатывают только
   * в момент приезда строки, поэтому без этого метода набор правил, заведённый после
   * загрузки выписки, не действует ни на что: единственным выходом был сброс выписки
   * и повторный поход в банк — с потерей всего, чего банк уже не отдаёт.
   *
   * За один вызов обрабатывается не более APPLY_BATCH строк; `remaining` говорит,
   * сколько осталось (фронт зовёт повторно). Каждая строка проводится своей
   * транзакцией: ошибка на одной не должна отменять уже проведённые.
   */
  async applyRulesToPending(workspaceId: string, userId: string) {
    const rules = await this.rules.loadActive(workspaceId, 'IMPORT');
    if (rules.length === 0) {
      return { scanned: 0, posted: 0, skipped: 0, remaining: 0 };
    }
    const lines = await this.prisma.bankStatementLine.findMany({
      where: { workspaceId, status: 'NEW' },
      include: { connection: { select: { accountId: true } } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: APPLY_BATCH,
    });
    // Правило переживает soft-delete категории, на которую ссылается (ссылки лежат
    // в JSON, cascade нет). Мёртвую ссылку отсеиваем заранее — иначе create упал бы
    // на нарушении FK, и вся пачка встала бы на первой же такой строке.
    const { categories, counterparties } = await this.liveRefs(workspaceId, rules);

    let posted = 0;
    let skipped = 0;
    for (const line of lines) {
      const suggestion = applyRules(rules, {
        description: line.description,
        counterpartyName: line.counterpartyName,
        counterpartyInn: line.counterpartyInn,
        accountId: line.connection.accountId,
        type: line.direction,
        amount: line.amount.toString(),
        source: 'IMPORT',
      });
      const categoryId =
        suggestion.categoryId && categories.has(suggestion.categoryId)
          ? suggestion.categoryId
          : null;
      if (!categoryId) {
        skipped++;
        continue;
      }
      const counterpartyId =
        suggestion.counterpartyId && counterparties.has(suggestion.counterpartyId)
          ? suggestion.counterpartyId
          : null;
      const done = await this.postByRule(workspaceId, userId, line, {
        categoryId,
        counterpartyId,
        appliedRuleId: suggestion.categoryRuleId ?? null,
      });
      if (done) posted++;
      else skipped++;
    }

    const remaining = await this.prisma.bankStatementLine.count({
      where: { workspaceId, status: 'NEW' },
    });
    return { scanned: lines.length, posted, skipped, remaining };
  }

  /** Провести одну строку по подсказке правила. false — строку увели параллельно. */
  private async postByRule(
    workspaceId: string,
    userId: string,
    line: { id: string; date: Date; amount: Prisma.Decimal; direction: 'INCOME' | 'EXPENSE';
      description: string | null; ausnMark: AusnMark | null; connection: { accountId: string } },
    applied: { categoryId: string; counterpartyId: string | null; appliedRuleId: string | null },
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const transaction = await tx.transaction.create({
          data: {
            workspaceId,
            accountId: line.connection.accountId,
            date: line.date,
            amount: line.amount,
            type: line.direction,
            kind: 'OTHER',
            categoryId: applied.categoryId,
            counterpartyId: applied.counterpartyId,
            description: line.description,
            ausnMark: line.ausnMark,
            createdById: userId,
          },
          select: { id: true },
        });
        // Тот же compare-and-swap, что и в ручном разборе: строку могли увести
        // параллельным categorize/dismiss, пока мы считали правила.
        const claim = await tx.bankStatementLine.updateMany({
          where: { id: line.id, status: 'NEW' },
          data: {
            status: 'AUTO_POSTED',
            transactionId: transaction.id,
            suggestedCategoryId: applied.categoryId,
            appliedRuleId: applied.appliedRuleId,
          },
        });
        if (claim.count === 0) throw new ConflictException('Строка уже обработана');
      });
      return true;
    } catch (e) {
      if (e instanceof ConflictException) return false;
      throw e;
    }
  }

  /** Живые категории/контрагенты, на которые ссылаются действия правил. */
  private async liveRefs(workspaceId: string, rules: RuleDef[]) {
    const categoryIds = new Set<string>();
    const counterpartyIds = new Set<string>();
    for (const r of rules) {
      for (const a of r.actions) {
        if (a.type === 'SET_CATEGORY') categoryIds.add(a.categoryId);
        else if (a.type === 'SET_COUNTERPARTY') counterpartyIds.add(a.counterpartyId);
      }
    }
    const [cats, cps] = await Promise.all([
      categoryIds.size
        ? this.prisma.category.findMany({
            where: { id: { in: [...categoryIds] }, workspaceId, deletedAt: null },
            select: { id: true },
          })
        : [],
      counterpartyIds.size
        ? this.prisma.counterparty.findMany({
            where: { id: { in: [...counterpartyIds] }, workspaceId, deletedAt: null },
            select: { id: true },
          })
        : [],
    ]);
    return {
      categories: new Set(cats.map((c) => c.id)),
      counterparties: new Set(cps.map((c) => c.id)),
    };
  }

  /**
   * Массовый откат: снять проводки пачкой и вернуть строки в Inbox. Нужен, когда
   * правило оказалось неверным — иначе сотни авто-проведённых строк пришлось бы
   * откатывать по одной.
   */
  async undoBulk(workspaceId: string, dto: UndoBulkDto) {
    const lines = await this.prisma.bankStatementLine.findMany({
      where: {
        workspaceId,
        status: 'AUTO_POSTED',
        ...(dto.appliedRuleId
          ? { appliedRuleId: dto.appliedRuleId }
          : { id: { in: dto.lineIds! } }),
      },
      select: { id: true },
    });
    let undone = 0;
    let skipped = 0;
    for (const line of lines) {
      try {
        await this.undo(workspaceId, line.id);
        undone++;
      } catch {
        // Строку уже откатили/переразобрали параллельно, либо её проводка — оплата
        // заказа (та отменяется в карточке заказа). Не роняем всю пачку.
        skipped++;
      }
    }
    return { undone, skipped };
  }

  /**
   * Строки на разборе, похожие на две ноги одного перевода между своими счетами.
   * Только предложение: подтверждает человек (`confirmTransfer`).
   */
  async transferCandidates(workspaceId: string) {
    const lines = await this.prisma.bankStatementLine.findMany({
      where: { workspaceId, status: 'NEW' },
      include: {
        connection: {
          select: { accountId: true, account: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: TRANSFER_SCAN_LIMIT,
    });
    const pairs = matchTransferPairs(
      lines.map((l) => ({
        id: l.id,
        accountId: l.connection.accountId,
        date: l.date,
        amount: l.amount.toString(),
        direction: l.direction,
        line: l,
      })),
    );
    return {
      items: pairs.map((p) => ({
        fee: p.fee,
        confidence: p.confidence,
        out: this.candidateView(p.out.line),
        in: this.candidateView(p.in.line),
      })),
    };
  }

  private candidateView(l: {
    id: string;
    date: Date;
    amount: Prisma.Decimal;
    description: string | null;
    counterpartyName: string | null;
    connection: { account: { id: string; name: string } };
  }) {
    return {
      id: l.id,
      date: l.date.toISOString(),
      amount: l.amount.toString(),
      description: l.description,
      counterpartyName: l.counterpartyName,
      account: l.connection.account,
    };
  }

  /**
   * Подтвердить, что две строки — один перевод: создаётся `Transfer` с двумя
   * ногами (и комиссией, если суммы разошлись), обе строки уходят из разбора и
   * привязываются каждая к своей ноге.
   *
   * Ноги ищем по `transferGroupId` после создания: `TransferService` их не
   * возвращает, а знать их надо — иначе строка останется без провенанса.
   */
  async confirmTransfer(workspaceId: string, userId: string, dto: ConfirmTransferDto) {
    if (dto.outLineId === dto.inLineId) {
      throw new BadRequestException('Нужны две разные строки');
    }
    const [outLine, inLine] = await Promise.all([
      this.loadNew(workspaceId, dto.outLineId),
      this.loadNew(workspaceId, dto.inLineId),
    ]);
    if (outLine.direction !== 'EXPENSE' || inLine.direction !== 'INCOME') {
      throw new BadRequestException('Перевод — это списание с одного счёта и приход на другой');
    }
    if (outLine.connection.accountId === inLine.connection.accountId) {
      throw new BadRequestException('Обе строки на одном счёте — это не перевод');
    }
    // Комиссию считаем сами по фактическим суммам: присланное значение могло бы
    // разойтись с выпиской и увести баланс счёта.
    const fee = outLine.amount.minus(inLine.amount);
    if (fee.isNegative()) {
      throw new BadRequestException('Пришло больше, чем ушло — это не перевод');
    }

    // Застолбить обе строки ДО создания перевода: иначе параллельный разбор
    // одной из них оставил бы половину перевода без строки.
    const claim = await this.prisma.bankStatementLine.updateMany({
      where: { id: { in: [outLine.id, inLine.id] }, status: 'NEW' },
      data: { status: 'RESOLVED' },
    });
    if (claim.count !== 2) {
      await this.prisma.bankStatementLine.updateMany({
        where: { id: { in: [outLine.id, inLine.id] }, transactionId: null },
        data: { status: 'NEW' },
      });
      throw new ConflictException('Одна из строк уже обработана другим действием');
    }

    try {
      const transfer = await this.transfers.create(workspaceId, userId, {
        fromAccountId: outLine.connection.accountId,
        toAccountId: inLine.connection.accountId,
        amount: inLine.amount.toString(),
        fee: fee.toFixed(2),
        date: outLine.date.toISOString(),
        note: outLine.description ?? inLine.description ?? undefined,
      });
      const legs = await this.prisma.transaction.findMany({
        where: { workspaceId, transferGroupId: transfer.id, deletedAt: null },
        select: { id: true, kind: true },
      });
      const outLeg = legs.find((l) => l.kind === 'TRANSFER_OUT');
      const inLeg = legs.find((l) => l.kind === 'TRANSFER_IN');
      await this.prisma.$transaction([
        this.prisma.bankStatementLine.update({
          where: { id: outLine.id },
          data: { transferId: transfer.id, transactionId: outLeg?.id ?? null },
        }),
        this.prisma.bankStatementLine.update({
          where: { id: inLine.id },
          data: { transferId: transfer.id, transactionId: inLeg?.id ?? null },
        }),
      ]);
      return { ok: true, transferId: transfer.id, fee: fee.toFixed(2) };
    } catch (e) {
      // Счёт архивирован/удалён и т.п. — возвращаем обе строки на разбор.
      await this.prisma.bankStatementLine.updateMany({
        where: { id: { in: [outLine.id, inLine.id] } },
        data: { status: 'NEW' },
      });
      throw e;
    }
  }

  /**
   * Одна строка — перевод на счёт, выписку которого банк не отдаёт (карты
   * физлиц: `ВБ Антропов`, `ВБ Каменск` — 58 операций в истории). Второй ноги в
   * выписке не будет никогда, поэтому её создаём сами и привязываем строку к
   * своей стороне.
   */
  async markAsTransfer(
    workspaceId: string,
    userId: string,
    lineId: string,
    counterAccountId: string,
  ) {
    const line = await this.loadNew(workspaceId, lineId);
    if (counterAccountId === line.connection.accountId) {
      throw new BadRequestException('Нельзя перевести счёт сам на себя');
    }
    const isOut = line.direction === 'EXPENSE';
    const claim = await this.prisma.bankStatementLine.updateMany({
      where: { id: line.id, status: 'NEW' },
      data: { status: 'RESOLVED' },
    });
    if (claim.count === 0) {
      throw new ConflictException('Строка уже обработана другим действием');
    }

    try {
      const transfer = await this.transfers.create(workspaceId, userId, {
        // Направление строки задаёт стороны: списание — уходит с её счёта,
        // приход — приходит на её счёт.
        fromAccountId: isOut ? line.connection.accountId : counterAccountId,
        toAccountId: isOut ? counterAccountId : line.connection.accountId,
        amount: line.amount.toString(),
        fee: '0',
        date: line.date.toISOString(),
        note: line.description ?? undefined,
      });
      const leg = await this.prisma.transaction.findFirst({
        where: {
          workspaceId,
          transferGroupId: transfer.id,
          kind: isOut ? 'TRANSFER_OUT' : 'TRANSFER_IN',
          deletedAt: null,
        },
        select: { id: true },
      });
      await this.prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { transferId: transfer.id, transactionId: leg?.id ?? null },
      });
      return { ok: true, transferId: transfer.id };
    } catch (e) {
      await this.prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'NEW' },
      });
      throw e;
    }
  }

  /** Загрузить строку в статусе NEW (с accountId подключения) или 404/400. */
  private async loadNew(workspaceId: string, lineId: string) {
    const line = await this.prisma.bankStatementLine.findFirst({
      where: { id: lineId, workspaceId },
      include: { connection: { select: { accountId: true } } },
    });
    if (!line) throw new NotFoundException('Строка не найдена');
    if (line.status !== 'NEW') {
      throw new BadRequestException('Строка уже обработана');
    }
    return line;
  }

  private async assertCounterparty(workspaceId: string, counterpartyId: string) {
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, workspaceId },
      select: { id: true },
    });
    if (!cp) throw new BadRequestException('Контрагент не найден в этом пространстве');
  }
}
