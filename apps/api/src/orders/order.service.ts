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
import { OrderRepository } from './order.repository';
import { add, sub, mul, money, gt, lt, isZero, D } from '../common/money';
import type {
  CreateOrderDto,
  UpdateOrderDto,
  ListOrdersQuery,
  AddPaymentDto,
  RefundDto,
  OrderItemInput,
} from './order.dto';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderRepository,
    private readonly uow: UnitOfWork,
    private readonly warehouse: WarehouseService,
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
    const subtotal = money(this.subtotalOf(input.items));
    const discount = money(input.discountAmount ?? '0');
    const total = money(sub(subtotal, discount));

    return this.uow.run(async (tx) => {
      const number = await this.orders.nextNumber(workspaceId, tx);
      return tx.order.create({
        data: {
          workspaceId,
          number,
          clientId: input.clientId ?? null,
          title: input.title ?? null,
          description: input.description ?? null,
          status: input.open ? 'OPEN' : 'DRAFT',
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
              lineTotal: money(mul(it.qty, it.unitPrice)),
            })),
          },
        },
        include: { items: true, client: true },
      });
    });
  }

  async update(workspaceId: string, id: string, input: UpdateOrderDto) {
    const existing = await this.orders.findById(workspaceId, id);
    if (!existing) throw new NotFoundException('Order not found');
    if (existing.status === 'DONE' || existing.status === 'CANCELLED') {
      throw new BadRequestException('Нельзя редактировать закрытый/отменённый заказ');
    }

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

    return this.uow.run(async (tx) => {
      await tx.transaction.create({
        data: {
          workspaceId,
          date: dto.date ? new Date(dto.date) : new Date(),
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
      // DRAFT → OPEN при первой оплате.
      if (order.status === 'DRAFT') {
        await tx.order.update({ where: { id: orderId }, data: { status: 'OPEN' } });
      }
      await this.syncPaymentState(workspaceId, orderId, tx);
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /** Возврат клиенту → Transaction(kind=ORDER_REFUND). Склад вернём на этапе warehouse. */
  async refund(
    workspaceId: string,
    orderId: string,
    userId: string,
    dto: RefundDto,
  ) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');

    return this.uow.run(async (tx) => {
      await tx.transaction.create({
        data: {
          workspaceId,
          date: dto.date ? new Date(dto.date) : new Date(),
          amount: money(dto.amount),
          type: 'EXPENSE',
          kind: 'ORDER_REFUND',
          accountId: dto.accountId,
          orderId,
          counterpartyId: order.clientId ?? null,
          description: dto.reason ?? `Возврат по заказу ${order.number}`,
          createdById: userId,
        },
      });
      await this.syncPaymentState(workspaceId, orderId, tx);
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /**
   * Закрыть заказ (DONE) АТОМАРНО:
   *   • для каждой позиции со складским SKU — списать по WAVG, снапшотить
   *     unitCostAtSale (себестоимость на момент продажи);
   *   • позиции-услуги (warehouseItemId=null) пропускаются;
   *   • при нехватке остатка — ошибка, ничего не списывается (rollback).
   */
  async finalize(workspaceId: string, orderId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') {
      throw new BadRequestException('Заказ отменён');
    }
    if (order.status === 'DONE') return order;

    return this.uow.run(async (tx) => {
      for (const item of order.items ?? []) {
        if (!item.warehouseItemId) continue;
        const unitCost = await this.warehouse.decrementForSale(
          tx,
          workspaceId,
          item.warehouseItemId,
          item.qty,
        );
        await tx.orderItem.update({
          where: { id: item.id },
          data: { unitCostAtSale: unitCost },
        });
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'DONE', closedAt: new Date() },
      });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  /**
   * Отмена заказа. Если заказ был DONE — возвращаем списанный товар на склад
   * (restock по unitCostAtSale, avgCost не меняется). Деньги (платежи) остаются:
   * при необходимости оформляется отдельный возврат.
   */
  async cancel(workspaceId: string, orderId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') return order;

    return this.uow.run(async (tx) => {
      if (order.status === 'DONE') {
        for (const item of order.items ?? []) {
          if (!item.warehouseItemId || item.unitCostAtSale === null) continue;
          await this.warehouse.restock(tx, workspaceId, item.warehouseItemId, item.qty);
        }
      }
      await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
      return this.orders.findById(workspaceId, orderId, tx);
    });
  }

  async remove(workspaceId: string, orderId: string) {
    const order = await this.orders.findById(workspaceId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    await this.orders.softDelete(orderId);
    return { ok: true };
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

/** Хелпер: пересчёт total при изменении только скидки. */
function recomputeWithDiscount(
  subtotal: Prisma.Decimal,
  discountStr: string,
): { discountAmount: Prisma.Decimal; totalAmount: Prisma.Decimal } {
  const discount = money(discountStr);
  return { discountAmount: discount, totalAmount: money(sub(subtotal, discount)) };
}
