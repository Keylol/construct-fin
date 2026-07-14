import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../orders/order.service';
import type { CategorizeDto, ListInboxQuery } from './inbox.dto';

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
  ) {}

  /** Список строк на разбор (NEW), курсор-пагинация. */
  async list(workspaceId: string, query: ListInboxQuery) {
    const items = await this.prisma.bankStatementLine.findMany({
      where: { workspaceId, status: 'NEW' },
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
        suggestedCategoryId: l.suggestedCategoryId,
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
        throw new ConflictException('Строка уже разобрана другим действием');
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
      throw new ConflictException('Строка уже разобрана другим действием');
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

  /** Загрузить строку в статусе NEW (с accountId подключения) или 404/400. */
  private async loadNew(workspaceId: string, lineId: string) {
    const line = await this.prisma.bankStatementLine.findFirst({
      where: { id: lineId, workspaceId },
      include: { connection: { select: { accountId: true } } },
    });
    if (!line) throw new NotFoundException('Строка не найдена');
    if (line.status !== 'NEW') {
      throw new BadRequestException('Строка уже разобрана');
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
