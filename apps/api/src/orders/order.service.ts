import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  Prisma,
  type OrderStatus,
  type OrderPaymentState,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork, type TxClient } from '../common/unit-of-work';
import { WarehouseService } from '../warehouse/warehouse.service';
import { AuditService } from '../audit/audit.service';
import { OrderRepository } from './order.repository';
import { add, sub, mul, div, money, cost, gt, lt, isZero, D } from '../common/money';
import type {
  CreateOrderDto,
  UpdateOrderDto,
  ListOrdersQuery,
  AddPaymentDto,
  OrderItemInput,
  ReturnItemDto,
  ShipItemDto,
} from './order.dto';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderRepository,
    private readonly uow: UnitOfWork,
    private readonly warehouse: WarehouseService,
    private readonly audit: AuditService,
  ) {}

  list(workspaceId: string, query: ListOrdersQuery) {
    return this.orders.list(workspaceId, query);
  }

  async get(workspaceId: string, id: string) {
    const order = await this.orders.findById(workspaceId, id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Сумма позиций. */
  private subtotalOf(items: OrderItemInput[]): Prisma.Decimal {
    return items.reduce((acc, it) => add(acc, mul(it.qty, it.unitPrice)), D(0));
  }

  async create(workspaceId: string, input: CreateOrderDto) {
    await this.assertOrderRefs(
      workspaceId,
      input.clientId,
      input.items.map((it) => it.warehouseItemId),
    );
    const subtotal = money(this.subtotalOf(input.items));
    const discount = money(input.discountAmount ?? '0');
    const total = money(sub(subtotal, discount));

    // B5: при гонке двух create один упрётся в partial-unique по number (P2002) —
    // перечитываем MAX и пробуем снова (короткий bounded-ретрай).
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run(async (tx) => {
          const number = await this.orders.nextNumber(workspaceId, tx);
          return tx.order.create({
            data: {
              workspaceId,
              number,
              clientId: input.clientId ?? null,
              title: input.title ?? null,
              description: input.description ?? null,
              status: 'OPEN',
              paymentStatus: 'UNPAID',
              subtotal,
              discountAmount: discount,
              totalAmount: total,
              paidAmount: new Prisma.Decimal(0),
              expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
              items: {
                create: input.items.map((it) => ({
                  warehouseItemId: it.warehouseItemId ?? null,
                  name: it.name,
                  qty: new Prisma.Decimal(it.qty),
                  unitPrice: new Prisma.Decimal(it.unitPrice),
                  unitCost: it.unitCost != null ? new Prisma.Decimal(it.unitCost) : null,
                  lineTotal: money(mul(it.qty, it.unitPrice)),
                })),
              },
            },
            include: { items: true, client: true },
          });
        });
      } catch (e) {
        if (isNumberConflict(e) && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
  }

  async update(workspaceId: string, id: string, input: UpdateOrderDto) {
    const existing = await this.orders.findById(workspaceId, id);
    if (!existing) throw new NotFoundException('Order not found');
    if (existing.status === 'DONE' || existing.status === 'CANCELLED') {
      throw new BadRequestException('Нельзя редактировать закрытый/отменённый заказ');
    }

    // Нельзя менять позиции, если что-то уже отгружено — иначе осиротеет
    // списанный со склада остаток (replace items = delete+recreate).
    if (input.items && (existing.items ?? []).some((it) => gt(it.shippedQty, '0'))) {
      throw new BadRequestException(
        'Нельзя менять позиции частично отгруженного заказа — сначала отмените отгрузку',
      );
    }

    // B4: новый клиент/складские позиции обязаны принадлежать workspace.
    await this.assertOrderRefs(
      workspaceId,
      input.clientId,
      input.items ? input.items.map((it) => it.warehouseItemId) : [],
    );

    return this.uow.run(async (tx) => {
      // Если переданы items — заменяем целиком и пересчитываем суммы.
      if (input.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        const subtotal = money(this.subtotalOf(input.items));
        const discount = money(
          input.discountAmount ?? existing.discountAmount.toString(),
        );
        const total = money(sub(subtotal, discount));
        await tx.order.update({
          where: { id },
          data: {
            subtotal,
            discountAmount: discount,
            totalAmount: total,
            items: {
              create: input.items.map((it) => ({
                warehouseItemId: it.warehouseItemId ?? null,
                name: it.name,
                qty: new Prisma.Decimal(it.qty),
                unitPrice: new Prisma.Decimal(it.unitPrice),
                unitCost: it.unitCost != null ? new Prisma.Decimal(it.unitCost) : null,
                lineTotal: money(mul(it.qty, it.unitPrice)),
              })),
            },
          },
        });
      }
      await tx.order.update({
        where: { id },
        data: {
          clientId: input.clientId === undefined ? undefined : input.clientId,
          title: input.title === undefined ? undefined : input.title,
          description:
            input.description === undefined ? undefined : input.description,
          expectedDate:
            input.expectedDate === undefined
              ? undefined
              : input.expectedDate
                ? new Date(input.expectedDate)
                : null,
          ...(input.discountAmount !== undefined && !input.items
            ? recomputeWithDiscount(existing.subtotal, input.discountAmount)
            : {}),
        },
      });
      await this.syncPaymentState(workspaceId, id, tx);
      return this.orders.findById(workspaceId, id, tx);
    });
  }

  /** Добавить оплату по заказу → Transaction(kind=ORDER_PAYMENT). */
  async addPayment(
    workspaceId: string,
    orderId: string,
    userId: string,
    dto: AddPaymentDto,
  ) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') {
      throw new BadRequestException('Заказ отменён');
    }

    const paymentDate = dto.date ? new Date(dto.date) : new Date();
    // B1: счёт обязан принадлежать этому workspace — иначе платёж сел бы на чужой
    // счёт (утечка изоляции + порча кэш-флоу). Как в returnItem.
    await this.assertAccount(workspaceId, dto.accountId);

    return this.uow.run(async (tx) => {
      await tx.transaction.create({
        data: {
          workspaceId,
          date: paymentDate,
          amount: money(dto.amount),
          type: 'INCOME',
          kind: 'ORDER_PAYMENT',
          accountId: dto.accountId,
          orderId,
          counterpartyId: order.clientId ?? null,
          description: dto.description ?? `Оплата по заказу ${order.number}`,
          createdById: userId,
        },
      });
      await this.syncPaymentState(workspaceId, orderId, tx);
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /**
   * Частичная отгрузка позиции ОТКРЫТОГО заказа. Списывает склад СРАЗУ на qty
   * (StockMovement SALE через decrementForSale), копит OrderItem.shippedQty и
   * накапливает средневзвешенную unitCostAtSale (для маржи). Заказ остаётся
   * OPEN; finalize позже отгрузит остаток и закроет. Услуги (без склада) только
   * увеличивают shippedQty.
   */
  async ship(workspaceId: string, orderId: string, userId: string, dto: ShipItemDto) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'OPEN') {
      throw new BadRequestException('Отгрузка возможна только по открытому заказу');
    }
    const item = (order.items ?? []).find((i) => i.id === dto.itemId);
    if (!item) throw new NotFoundException('Позиция заказа не найдена');

    const shipQty = D(dto.qty);
    if (!gt(shipQty, '0')) {
      throw new BadRequestException('qty должен быть положительным');
    }
    const remaining = sub(item.qty, item.shippedQty);
    if (gt(shipQty, remaining)) {
      throw new BadRequestException(
        `Нельзя отгрузить больше остатка позиции: доступно ${remaining.toString()}`,
      );
    }

    return this.uow.run(async (tx) => {
      let costSnapshot = item.unitCostAtSale;
      if (item.warehouseItemId) {
        const unitCost = await this.warehouse.decrementForSale(
          tx,
          workspaceId,
          item.warehouseItemId,
          shipQty,
          userId,
          { refType: 'Order', refId: orderId },
        );
        costSnapshot = this.weightedCost(item.unitCostAtSale, item.shippedQty, unitCost, shipQty);
      }
      await tx.orderItem.update({
        where: { id: item.id },
        data: { shippedQty: add(item.shippedQty, shipQty), unitCostAtSale: costSnapshot },
      });
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.ship',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          itemId: item.id,
          itemName: item.name,
          shipQty: shipQty.toString(),
        },
      });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /** Взвешенная себестоимость единицы при доборе отгрузки. prevCost=null → 0. */
  private weightedCost(
    prevCost: Prisma.Decimal | null,
    prevQty: Prisma.Decimal,
    newCost: Prisma.Decimal,
    newQty: Prisma.Decimal,
  ): Prisma.Decimal {
    const denom = add(prevQty, newQty);
    if (isZero(denom)) return cost(newCost);
    const total = add(mul(prevCost ?? D(0), prevQty), mul(newCost, newQty));
    return cost(div(total, denom));
  }

  /**
   * Возврат клиента (RMA) по позиции ЗАКРЫТОГО заказа. Атомарно:
   *   • returnQty возвращается на склад (StockMovement RETURN_CUSTOMER, avgCost
   *     не меняется), если позиция складская; ручные позиции склад не трогают;
   *   • OrderItem.returnedQty += returnQty (накопительно — частичные возвраты);
   *   • Transaction(kind=ORDER_REFUND, type=EXPENSE) на refundAmount (если >0) —
   *     деньги клиенту; syncPaymentState пересчитывает paidAmount/paymentStatus.
   *
   * COGS-транзакция (движение денег/расход) по возвращённой доле НЕ сторнируется
   * (cash-basis: складская себестоимость признана при закупке, ручной COGS
   * остаётся) — движение денег и остаток склада корректны. А вот ОТЧЁТ по марже
   * с Трека A (A4) теперь считает по netQty = qty − returnedQty, т.е. возврат
   * сужает маржу позиции (см. margin.service.ts).
   */
  async returnItem(
    workspaceId: string,
    orderId: string,
    userId: string,
    dto: ReturnItemDto,
  ) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'DONE') {
      throw new BadRequestException('Возврат возможен только по закрытому (DONE) заказу');
    }
    const item = (order.items ?? []).find((i) => i.id === dto.itemId);
    if (!item) throw new NotFoundException('Позиция заказа не найдена');

    const returnQty = new Prisma.Decimal(dto.returnQty);
    if (!gt(returnQty, '0')) {
      throw new BadRequestException('returnQty должен быть положительным');
    }
    const available = sub(item.qty, item.returnedQty);
    if (gt(returnQty, available)) {
      throw new BadRequestException(
        `Нельзя вернуть больше проданного: доступно ${available.toString()}`,
      );
    }
    const refund = money(dto.refundAmount);
    if (refund.isNegative()) {
      throw new BadRequestException('refundAmount не может быть отрицательным');
    }
    await this.assertAccount(workspaceId, dto.accountId);

    const refundDate = dto.date ? new Date(dto.date) : new Date();

    return this.uow.run(async (tx) => {
      if (item.warehouseItemId) {
        await this.warehouse.restock(
          tx,
          workspaceId,
          item.warehouseItemId,
          returnQty,
          userId,
          { refType: 'Order', refId: orderId },
        );
      }
      await tx.orderItem.update({
        where: { id: item.id },
        data: { returnedQty: add(item.returnedQty, returnQty) },
      });
      if (gt(refund, '0')) {
        await tx.transaction.create({
          data: {
            workspaceId,
            date: refundDate,
            amount: refund,
            type: 'EXPENSE',
            kind: 'ORDER_REFUND',
            accountId: dto.accountId,
            orderId,
            counterpartyId: order.clientId ?? null,
            description:
              dto.note ?? `Возврат клиента по заказу ${order.number}: ${item.name}`,
            createdById: userId,
          },
        });
      }
      await this.syncPaymentState(workspaceId, orderId, tx);
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.return',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          itemId: item.id,
          itemName: item.name,
          returnQty: returnQty.toString(),
          refundAmount: refund.toFixed(2),
        },
      });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /** Проверка принадлежности счёта workspace (для возврата денег). */
  private async assertAccount(workspaceId: string, accountId: string) {
    const acc = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!acc) throw new BadRequestException('Account not found in this workspace');
  }

  /**
   * B4: клиент и складские позиции заказа обязаны принадлежать этому workspace.
   * Без проверки можно прикрепить чужого контрагента или (опаснее) чужую
   * складскую позицию — она затем списывалась бы при finalize и пачкала отчёты.
   */
  private async assertOrderRefs(
    workspaceId: string,
    clientId: string | null | undefined,
    warehouseItemIds: (string | null | undefined)[],
  ) {
    if (clientId) {
      const client = await this.prisma.counterparty.findFirst({
        where: { id: clientId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!client) throw new BadRequestException('Клиент не найден в этом пространстве');
    }
    const ids = [...new Set(warehouseItemIds.filter((x): x is string => !!x))];
    if (ids.length) {
      const found = await this.prisma.warehouseItem.findMany({
        where: { id: { in: ids }, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('Складская позиция не найдена в этом пространстве');
      }
    }
  }

  /**
   * Закрыть заказ (DONE) АТОМАРНО:
   *   • позиции со складским SKU — списать по WAVG, снапшотить unitCostAtSale
   *     (себестоимость уже была учтена при закупке — новый расход НЕ создаём);
   *   • позиции с ручной закупочной ценой (unitCost, без склада) — суммарная
   *     себестоимость создаётся одной расходной операцией Transaction(kind=COGS)
   *     со счёта последней оплаты → попадает в P&L;
   *   • при нехватке остатка по складу — ошибка, ничего не списывается (rollback).
   */
  async finalize(workspaceId: string, orderId: string, userId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') {
      throw new BadRequestException('Заказ отменён');
    }
    if (order.status === 'DONE') return order;

    return this.uow.run(async (tx) => {
      let manualCogs = D(0);
      for (const item of order.items ?? []) {
        if (item.warehouseItemId) {
          // Списываем только ещё НЕ отгруженный остаток (часть могла уйти через ship).
          const remaining = sub(item.qty, item.shippedQty);
          let costSnapshot = item.unitCostAtSale;
          if (gt(remaining, '0')) {
            const unitCost = await this.warehouse.decrementForSale(
              tx,
              workspaceId,
              item.warehouseItemId,
              remaining,
              userId,
              { refType: 'Order', refId: orderId },
            );
            costSnapshot = this.weightedCost(item.unitCostAtSale, item.shippedQty, unitCost, remaining);
          }
          await tx.orderItem.update({
            where: { id: item.id },
            data: { unitCostAtSale: costSnapshot, shippedQty: item.qty },
          });
        } else {
          if (item.unitCost !== null) {
            manualCogs = add(manualCogs, mul(item.qty, item.unitCost));
          }
          await tx.orderItem.update({
            where: { id: item.id },
            data: { shippedQty: item.qty },
          });
        }
      }

      // Расход себестоимости по ручным позициям → в P&L.
      if (gt(manualCogs, '0')) {
        const accountId = await this.resolveCostAccount(tx, workspaceId, order);
        if (!accountId) {
          throw new BadRequestException(
            'Нет счёта для списания себестоимости — добавьте счёт или примите оплату',
          );
        }
        await tx.transaction.create({
          data: {
            workspaceId,
            date: new Date(),
            amount: money(manualCogs),
            type: 'EXPENSE',
            kind: 'COGS',
            accountId,
            orderId,
            counterpartyId: order.clientId ?? null,
            description: `Себестоимость заказа ${order.number}`,
            createdById: userId,
          },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: 'DONE', closedAt: new Date() },
      });
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.finalize',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          previousStatus: order.status,
          totalAmount: order.totalAmount.toFixed(2),
          manualCogs: manualCogs.toFixed(2),
        },
      });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /**
   * Отмена заказа. Если заказ был DONE — откатываем финализацию: возвращаем
   * товар на склад и сторнируем COGS-расход. Платежи остаются (при необходимости
   * оформляется отдельный возврат).
   */
  async cancel(workspaceId: string, orderId: string, userId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') return order;

    return this.uow.run(async (tx) => {
      // Возвращаем отгруженное и для DONE, и для частично отгруженного OPEN.
      await this.reverseFinalization(tx, workspaceId, order, userId);
      await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.cancel',
        entityType: 'Order',
        entityId: orderId,
        diff: { number: order.number, previousStatus: order.status },
      });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /**
   * Вернуть заказ в работу (OPEN). Доступно для DONE и CANCELLED:
   *   • DONE → откатывает финализацию (возврат склада + сторно COGS-расхода);
   *   • CANCELLED → финализация уже была откатана при отмене, поэтому только
   *     меняем статус. Платежи никуда не девались.
   * В обоих случаях пересчитываем оплату.
   */
  async reopen(workspaceId: string, orderId: string, userId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'DONE' && order.status !== 'CANCELLED') {
      throw new BadRequestException(
        'Вернуть в работу можно только закрытый или отменённый заказ',
      );
    }
    return this.uow.run(async (tx) => {
      // Откатываем отгрузку (DONE или частичный OPEN) — вернуть в работу «с нуля».
      await this.reverseFinalization(tx, workspaceId, order, userId);
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'OPEN', closedAt: null },
      });
      await this.syncPaymentState(workspaceId, orderId, tx);
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.reopen',
        entityType: 'Order',
        entityId: orderId,
        diff: { number: order.number, previousStatus: order.status },
      });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /**
   * Откат отгрузки/финализации: возврат склада + сторно COGS-расхода. Внутри UoW.
   * Возвращаем на склад фактически отгруженное за вычетом уже возвращённого
   * (RMA): для DONE отгружено = qty, для частично отгруженного OPEN = shippedQty;
   * минус returnedQty (его уже вернул возврат). Сбрасываем shippedQty/unitCostAtSale.
   */
  private async reverseFinalization(
    tx: TxClient,
    workspaceId: string,
    order: NonNullable<Awaited<ReturnType<OrderRepository['findById']>>>,
    userId: string,
  ) {
    for (const item of order.items ?? []) {
      if (item.warehouseItemId) {
        const out = order.status === 'DONE' ? item.qty : item.shippedQty;
        const netOut = sub(out, item.returnedQty);
        if (gt(netOut, '0')) {
          await this.warehouse.restock(tx, workspaceId, item.warehouseItemId, netOut, userId, {
            refType: 'Order',
            refId: order.id,
          });
        }
      }
      // Сбрасываем отгрузку/снапшот себестоимости по всем позициям.
      if (gt(item.shippedQty, '0') || item.unitCostAtSale !== null) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { shippedQty: D(0), unitCostAtSale: null },
        });
      }
    }
    await tx.transaction.updateMany({
      where: { workspaceId, orderId: order.id, kind: 'COGS', deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /** Счёт для списания себестоимости: счёт последней оплаты, иначе первый активный. */
  private async resolveCostAccount(
    tx: TxClient,
    workspaceId: string,
    order: NonNullable<Awaited<ReturnType<OrderRepository['findById']>>>,
  ): Promise<string | null> {
    const lastPayment = (order.transactions ?? []).find(
      (t) => t.kind === 'ORDER_PAYMENT',
    );
    if (lastPayment) return lastPayment.accountId;
    const acc = await tx.account.findFirst({
      where: { workspaceId, deletedAt: null, isArchived: false },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return acc?.id ?? null;
  }

  async remove(workspaceId: string, orderId: string, userId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    return this.uow.run(async (tx) => {
      // Вернуть склад (DONE или частичный OPEN) и сторнировать COGS.
      await this.reverseFinalization(tx, workspaceId, order, userId);
      // Сторнируем все связанные операции (оплаты/возвраты), чтобы не висели в P&L.
      await tx.transaction.updateMany({
        where: { workspaceId, orderId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await tx.order.update({ where: { id: orderId }, data: { deletedAt: new Date() } });
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.delete',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          status: order.status,
          totalAmount: order.totalAmount.toFixed(2),
          paidAmount: order.paidAmount.toFixed(2),
        },
      });
      return { ok: true };
    });
  }

  /**
   * Пересчитывает paidAmount = Σ(ORDER_PAYMENT) − Σ(ORDER_REFUND) и
   * paymentStatus относительно totalAmount. Вызывается внутри UoW.
   */
  private async syncPaymentState(workspaceId: string, orderId: string, tx: TxClient) {
    const order = await tx.order.findFirstOrThrow({
      where: { id: orderId },
      select: { totalAmount: true },
    });
    const grouped = await tx.transaction.groupBy({
      by: ['kind'],
      where: {
        workspaceId,
        orderId,
        deletedAt: null,
        kind: { in: ['ORDER_PAYMENT', 'ORDER_REFUND'] },
      },
      _sum: { amount: true },
    });
    const paidIn = grouped.find((g) => g.kind === 'ORDER_PAYMENT')?._sum.amount ?? D(0);
    const refunded = grouped.find((g) => g.kind === 'ORDER_REFUND')?._sum.amount ?? D(0);
    const paid = money(sub(paidIn, refunded));
    const total = order.totalAmount;

    let state: OrderPaymentState;
    if (lt(paid, '0') || isZero(paid)) state = paid.isNegative() ? 'REFUNDED' : 'UNPAID';
    else if (lt(paid, total)) state = 'PARTIAL';
    else if (gt(paid, total)) state = 'OVERPAID';
    else state = 'PAID';

    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount: paid, paymentStatus: state },
    });
  }
}

/**
 * B5: конфликт уникальности номера заказа (partial-unique по number) при гонке
 * двух create. Единственный unique, который может нарушить order.create, — это
 * number, поэтому P2002 здесь = коллизия номера → ретрай.
 */
function isNumberConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** Хелпер: пересчёт total при изменении только скидки. */
function recomputeWithDiscount(
  subtotal: Prisma.Decimal,
  discountStr: string,
): { discountAmount: Prisma.Decimal; totalAmount: Prisma.Decimal } {
  const discount = money(discountStr);
  return { discountAmount: discount, totalAmount: money(sub(subtotal, discount)) };
}
