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
import { WarehouseService, NoConsumptionsError } from '../warehouse/warehouse.service';
import { AuditService } from '../audit/audit.service';
import { OrderRepository } from './order.repository';
import { add, sub, mul, money, gt, lt, isZero, D } from '../common/money';
import { assertNotFuture } from '../reports/period';
import {
  itemMargin,
  orderMargin,
  type ItemMargin,
  type MarginItemInput,
  type OrderMarginSummary,
} from './order-margin';
import {
  scheduleView,
  type ScheduleEntryRecord,
  type ScheduleView,
} from './payment-schedule';
import type {
  CreateOrderDto,
  UpdateOrderDto,
  ListOrdersQuery,
  AddPaymentDto,
  InstallmentPaymentDto,
  OrderItemInput,
  ReturnItemDto,
  SetScheduleDto,
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

  /**
   * Список заказов + вычисленная сводка графика платежей на каждый (бейдж
   * просрочки в таблице). Сырые строки графика наружу не отдаются.
   */
  async list(workspaceId: string, query: ListOrdersQuery) {
    const page = await this.orders.list(workspaceId, query);
    const asOf = new Date();
    return {
      ...page,
      items: page.items.map((o) => {
        const { schedule, ...rest } = o;
        return {
          ...rest,
          scheduleSummary:
            scheduleView(schedule ?? [], o.paidAmount, o.totalAmount, asOf)?.summary ?? null,
        };
      }),
    };
  }

  async get(workspaceId: string, id: string) {
    const order = await this.orders.findById(workspaceId, id);
    if (!order) throw new NotFoundException('Order not found');
    return this.serializeOrder(order);
  }

  /**
   * F5 (#9): трассировка строк заказа до партий — из какой закупки взято,
   * поставщик и счёт оплаты. Данные — складской net-леджер потреблений.
   */
  async trace(workspaceId: string, id: string) {
    const order = await this.orders.findById(workspaceId, id);
    if (!order) throw new NotFoundException('Order not found');
    return this.warehouse.lotTraceForOrder(workspaceId, id);
  }

  /**
   * Расчётные блоки заказа — считает бэкенд, фронт только рисует (D4):
   *   • F1 (решение #4): маржа строк (margin на каждом item) и итога (margin);
   *   • F2 (#8a): график платежей (schedule) — FIFO-покрытие строк из
   *     paidAmount, статусы и сводка просрочки; null, если графика нет.
   * Оборачивает ВСЕ ответы с заказом (get и каждую мутацию).
   */
  private serializeOrder<
    T extends {
      discountAmount: Prisma.Decimal;
      paidAmount: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
      items?: MarginItemInput[];
      schedule?: ScheduleEntryRecord[];
    },
  >(
    order: T,
    // Omit обязателен: пересечение T & {items: …} НЕ перезаписало бы items из T
    // (элементы читались бы старым типом без margin). Тип элемента выводим из
    // самого T — отдельный дженерик под элемент TS не инферит из constraint.
  ): Omit<T, 'items' | 'schedule'> & {
    items: (NonNullable<T['items']>[number] & { margin: ItemMargin })[];
    margin: OrderMarginSummary;
    schedule: ScheduleView | null;
  } {
    const src = (order.items ?? []) as NonNullable<T['items']>[number][];
    const items = src.map((it) => ({ ...it, margin: itemMargin(it) }));
    return {
      ...order,
      items,
      margin: orderMargin(src, order.discountAmount),
      schedule: scheduleView(
        order.schedule ?? [],
        order.paidAmount,
        order.totalAmount,
        new Date(),
      ),
    };
  }

  /** Свежий заказ из БД + расчётные блоки — единый финал всех мутаций. */
  private async freshWithMargin(workspaceId: string, id: string, tx?: TxClient) {
    const order = await this.orders.findById(workspaceId, id, tx);
    if (!order) throw new NotFoundException('Order not found');
    return this.serializeOrder(order);
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
    // R5b: скидка > суммы позиций увела бы totalAmount в минус (бессмысленный
    // paymentStatus). Явный отказ — чтобы пользователь увидел ошибку, а не молча
    // потерял деньги в дебиторке. (R5a — отрицательная скидка — отсечён в DTO.)
    if (gt(discount, subtotal)) {
      throw new BadRequestException('Скидка не может превышать сумму позиций');
    }
    const total = money(sub(subtotal, discount));

    // B5: при гонке двух create один упрётся в partial-unique по number (P2002) —
    // перечитываем MAX и пробуем снова (короткий bounded-ретрай).
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run(async (tx) => {
          const number = await this.orders.nextNumber(workspaceId, tx);
          const created = await tx.order.create({
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
            // avgCost — как в findById: маржа-оценка уже в ответе create (F1).
            include: {
              items: { include: { warehouseItem: { select: { avgCost: true } } } },
              client: true,
            },
          });
          return this.serializeOrder(created);
        });
      } catch (e) {
        if (isNumberConflict(e) && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
  }

  async update(workspaceId: string, id: string, input: UpdateOrderDto) {
    // B4: внешние refs (клиент/склад) не зависят от состояния заказа — до tx.
    await this.assertOrderRefs(
      workspaceId,
      input.clientId,
      input.items ? input.items.map((it) => it.warehouseItemId) : [],
    );

    return this.uow.run(async (tx) => {
      // B2: лок + свежее чтение под локом, валидация по актуальному состоянию.
      const existing = await this.lockAndLoad(tx, workspaceId, id);
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
      // Если переданы items — заменяем целиком и пересчитываем суммы.
      if (input.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        const subtotal = money(this.subtotalOf(input.items));
        const discount = money(
          input.discountAmount ?? existing.discountAmount.toString(),
        );
        if (gt(discount, subtotal)) {
          throw new BadRequestException('Скидка не может превышать сумму позиций');
        }
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
      return this.freshWithMargin(workspaceId, id, tx);
    });
  }

  /** Добавить оплату по заказу → Transaction(kind=ORDER_PAYMENT). */
  async addPayment(
    workspaceId: string,
    orderId: string,
    userId: string,
    dto: AddPaymentDto,
  ) {
    // DE3: оплата строго положительна. MoneyString в DTO допускает знак (нужен
    // для сторно), поэтому «−15000»/«0» отсекаем здесь — иначе paidAmount ушёл бы
    // в минус и заказ получил фейковый статус REFUNDED без единого возврата.
    if (!gt(money(dto.amount), '0')) {
      throw new BadRequestException('Сумма оплаты должна быть положительной');
    }
    const paymentDate = dto.date ? new Date(dto.date) : new Date();
    assertNotFuture(paymentDate, 'Дата оплаты'); // DE4
    // B1: счёт обязан принадлежать этому workspace — иначе платёж сел бы на чужой
    // счёт (утечка изоляции + порча кэш-флоу). Внешний ref — до tx.
    await this.assertAccount(workspaceId, dto.accountId);

    return this.uow.run(async (tx) => {
      const order = await this.lockAndLoad(tx, workspaceId, orderId); // B2
      if (order.status === 'CANCELLED') {
        throw new BadRequestException('Заказ отменён');
      }
      // #9: перепроверяем счёт под транзакцией (TOCTOU) перед созданием проводки.
      await this.assertAccountTx(tx, workspaceId, dto.accountId);
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
      return this.freshWithMargin(workspaceId, orderId, tx);
    });
  }

  /**
   * C2 (Волна 2, обратимость): доменное удаление ошибочной денежной операции
   * заказа. Раньше ошибочный/неверно привязанный платёж нельзя было ни исправить,
   * ни удалить (SYSTEM_KINDS-барьер в generic-API без контр-пути) → paidAmount и
   * сверка портились навсегда. Теперь soft-delete проводки ПОД локом B2 +
   * пересчёт paidAmount + аудит.
   *
   * Удаляемы: ORDER_PAYMENT / ORDER_REFUND / VARIABLE_COST (комиссия рассрочки).
   * COGS НЕ удаляется через этот путь — себестоимость привязана к складу и
   * управляется отменой/переоткрытием заказа (иначе рассинхрон маржи/P&L).
   * Физический возврат денег клиенту при ошибочном платеже оформляется отдельной
   * расходной операцией (решение блица 2026-07-04).
   */
  async deletePayment(workspaceId: string, orderId: string, txId: string, userId: string) {
    return this.uow.run(async (tx) => {
      const order = await this.lockAndLoad(tx, workspaceId, orderId); // B2
      const payment = await tx.transaction.findFirst({
        where: { id: txId, workspaceId, orderId, deletedAt: null },
      });
      if (!payment) throw new NotFoundException('Операция по заказу не найдена');
      if (!DELETABLE_PAYMENT_KINDS.has(payment.kind)) {
        throw new BadRequestException(
          'Удалить можно только платёж, возврат или комиссию — себестоимость управляется отменой/переоткрытием заказа',
        );
      }
      await tx.transaction.update({ where: { id: txId }, data: { deletedAt: new Date() } });
      await this.syncPaymentState(workspaceId, orderId, tx);
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.payment-delete',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          txId,
          kind: payment.kind,
          amount: payment.amount.toFixed(2),
        },
      });
      return this.freshWithMargin(workspaceId, orderId, tx);
    });
  }

  /**
   * F3 (решение #5): оплата через стороннюю рассрочку — gross, разово.
   * Атомарно две проводки: ORDER_PAYMENT на ПОЛНУЮ сумму (закрывает дебиторку,
   * выручка не занижается) + VARIABLE_COST на комиссию банка (стоимость
   * финансирования — отдельный расход, привязан к заказу). Чистое движение по
   * счёту = amount − fee = фактическое зачисление банка.
   */
  async addInstallmentPayment(
    workspaceId: string,
    orderId: string,
    userId: string,
    dto: InstallmentPaymentDto,
  ) {
    const amount = money(dto.amount);
    const fee = money(dto.fee);
    if (!gt(amount, '0')) {
      throw new BadRequestException('Сумма оплаты должна быть положительной');
    }
    // Комиссия ≥ суммы делает платёж бессмысленным (нетто ≤ 0) — почти наверняка
    // ошибка ввода; явный отказ вместо тихой порчи кэш-флоу.
    if (!lt(fee, amount)) {
      throw new BadRequestException('Комиссия должна быть меньше суммы оплаты');
    }
    const paymentDate = dto.date ? new Date(dto.date) : new Date();
    assertNotFuture(paymentDate, 'Дата оплаты'); // DE4
    await this.assertAccount(workspaceId, dto.accountId);

    return this.uow.run(async (tx) => {
      const order = await this.lockAndLoad(tx, workspaceId, orderId); // B2
      if (order.status === 'CANCELLED') {
        throw new BadRequestException('Заказ отменён');
      }
      await this.assertAccountTx(tx, workspaceId, dto.accountId); // TOCTOU
      await tx.transaction.create({
        data: {
          workspaceId,
          date: paymentDate,
          amount,
          type: 'INCOME',
          kind: 'ORDER_PAYMENT',
          accountId: dto.accountId,
          orderId,
          counterpartyId: order.clientId ?? null,
          description: dto.description ?? `Оплата рассрочкой по заказу ${order.number}`,
          createdById: userId,
        },
      });
      if (gt(fee, '0')) {
        await tx.transaction.create({
          data: {
            workspaceId,
            date: paymentDate,
            amount: fee,
            type: 'EXPENSE',
            kind: 'VARIABLE_COST',
            accountId: dto.accountId,
            orderId,
            counterpartyId: order.clientId ?? null,
            description: `Комиссия рассрочки по заказу ${order.number}`,
            createdById: userId,
          },
        });
      }
      await this.syncPaymentState(workspaceId, orderId, tx);
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.installment',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          amount: amount.toFixed(2),
          fee: fee.toFixed(2),
        },
      });
      return this.freshWithMargin(workspaceId, orderId, tx);
    });
  }

  /**
   * F2 (#8a): заменить график платежей заказа целиком (replace-all, как items
   * в update). Пустой entries снимает график. График — план: Σ строк может
   * расходиться с totalAmount (UI предупредит по summary.matchesTotal).
   * Платежи к строкам не привязываются — покрытие выводится из paidAmount.
   */
  async setSchedule(
    workspaceId: string,
    orderId: string,
    userId: string,
    dto: SetScheduleDto,
  ) {
    return this.uow.run(async (tx) => {
      // B2: лок — параллельные setSchedule/addPayment сериализуются.
      const order = await this.lockAndLoad(tx, workspaceId, orderId);
      if (order.status === 'CANCELLED') {
        throw new BadRequestException('Заказ отменён');
      }
      // Replace-план целиком, hard-delete — как items в update() (строки графика
      // не учётные записи; сам факт правки фиксируется в AuditLog ниже).
      // workspaceId — защита в глубину поверх lockAndLoad (конвенция проекта).
      await tx.paymentScheduleEntry.deleteMany({ where: { workspaceId, orderId } });
      if (dto.entries.length) {
        await tx.paymentScheduleEntry.createMany({
          data: dto.entries.map((e, i) => ({
            workspaceId,
            orderId,
            seq: i + 1,
            dueDate: new Date(e.dueDate),
            amount: new Prisma.Decimal(e.amount),
            note: e.note ?? null,
          })),
        });
      }
      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'order.schedule',
        entityType: 'Order',
        entityId: orderId,
        diff: {
          number: order.number,
          entries: dto.entries.length,
          planned: dto.entries
            .reduce((acc, e) => add(acc, e.amount), D(0))
            .toFixed(2),
        },
      });
      return this.freshWithMargin(workspaceId, orderId, tx);
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
    const shipQty = D(dto.qty);
    if (!gt(shipQty, '0')) {
      throw new BadRequestException('qty должен быть положительным');
    }

    return this.uow.run(async (tx) => {
      // B2: лок + свежее чтение — иначе два параллельных ship по одной позиции
      // оба прошли бы проверку остатка по устаревшему shippedQty (oversell).
      const order = await this.lockAndLoad(tx, workspaceId, orderId);
      if (order.status !== 'OPEN') {
        throw new BadRequestException('Отгрузка возможна только по открытому заказу');
      }
      const item = (order.items ?? []).find((i) => i.id === dto.itemId);
      if (!item) throw new NotFoundException('Позиция заказа не найдена');
      const remaining = sub(item.qty, item.shippedQty);
      if (gt(shipQty, remaining)) {
        throw new BadRequestException(
          `Нельзя отгрузить больше остатка позиции: доступно ${remaining.toString()}`,
        );
      }

      let costSnapshot = item.unitCostAtSale;
      if (item.warehouseItemId) {
        await this.warehouse.decrementForSale(
          tx,
          workspaceId,
          item.warehouseItemId,
          shipQty,
          userId,
          { refType: 'Order', refId: orderId, orderItemId: item.id },
        );
        // unitCostAtSale — деривация из net-леджера FIFO-потреблений (одна формула
        // для ship/finalize/return; убирает дрейф старого взвешивания).
        costSnapshot = await this.warehouse.unitCostAtSaleFor(tx, workspaceId, item.id);
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
      return this.freshWithMargin(workspaceId, orderId, tx);
    });
  }

  /**
   * Детерминированный порядок позиций для лока партий: по warehouseItemId ASC
   * (услуги без склада — в конце). Применяется во ВСЕХ мультипозиционных путях
   * (finalize/reverseFinalization/remove), чтобы две конкурентные операции с
   * зеркальными наборами SKU не ушли в deadlock на встречных лотах-локах.
   */
  private sortItemsForLocking<T extends { warehouseItemId: string | null }>(items: T[]): T[] {
    return [...items].sort((a, b) =>
      (a.warehouseItemId ?? '￿').localeCompare(b.warehouseItemId ?? '￿'),
    );
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
    const returnQty = new Prisma.Decimal(dto.returnQty);
    if (!gt(returnQty, '0')) {
      throw new BadRequestException('returnQty должен быть положительным');
    }
    const refund = money(dto.refundAmount);
    if (refund.isNegative()) {
      throw new BadRequestException('refundAmount не может быть отрицательным');
    }
    await this.assertAccount(workspaceId, dto.accountId);

    const refundDate = dto.date ? new Date(dto.date) : new Date();
    assertNotFuture(refundDate, 'Дата возврата'); // DE4

    return this.uow.run(async (tx) => {
      // B2: лок + свежее чтение — два параллельных возврата по одной позиции
      // не должны пройти оба по устаревшему returnedQty (over-return).
      const order = await this.lockAndLoad(tx, workspaceId, orderId);
      if (order.status !== 'DONE') {
        throw new BadRequestException('Возврат возможен только по закрытому (DONE) заказу');
      }
      // DE5: нельзя вернуть денег больше, чем сейчас собрано по заказу
      // (paidAmount = Σ оплат − Σ возвратов). Иначе paidAmount ушёл бы в минус
      // и заказ получил бы фейковый REFUNDED. Кап по фактически собранному.
      if (gt(refund, order.paidAmount)) {
        throw new BadRequestException(
          `Возврат ${refund.toFixed(2)} превышает собранную сумму ${order.paidAmount.toFixed(2)} — уменьшите сумму возврата`,
        );
      }
      const item = (order.items ?? []).find((i) => i.id === dto.itemId);
      if (!item) throw new NotFoundException('Позиция заказа не найдена');
      const available = sub(item.qty, item.returnedQty);
      if (gt(returnQty, available)) {
        throw new BadRequestException(
          `Нельзя вернуть больше проданного: доступно ${available.toString()}`,
        );
      }
      // #9: перепроверяем счёт возврата под транзакцией (TOCTOU) перед проводками.
      await this.assertAccountTx(tx, workspaceId, dto.accountId);

      let costSnapshot = item.unitCostAtSale;
      if (item.warehouseItemId) {
        // Адресный реверс: восстанавливаем ИМЕННО те партии, из которых ушёл товар
        // (по их снимочной себестоимости). Если потреблений нет (до-миграционный
        // заказ / удалённая позиция) — fallback на новую RETURN_CUSTOMER-партию.
        try {
          await this.warehouse.reverseConsumption(
            tx,
            workspaceId,
            item.warehouseItemId,
            item.id,
            returnQty,
            userId,
            { refType: 'Order', refId: orderId },
          );
        } catch (e) {
          if (e instanceof NoConsumptionsError) {
            await this.warehouse.restock(
              tx,
              workspaceId,
              item.warehouseItemId,
              returnQty,
              userId,
              { refType: 'Order', refId: orderId },
              item.unitCostAtSale ?? item.unitCost ?? null,
            );
          } else {
            throw e;
          }
        }
        // Пересчёт снимка: теперь = себестоимость ОСТАВШИХСЯ проданных единиц → маржа
        // (netQty × unitCostAtSale) остаётся равна FIFO-COGS оставшихся (I8).
        costSnapshot = await this.warehouse.unitCostAtSaleFor(tx, workspaceId, item.id);
      }
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          returnedQty: add(item.returnedQty, returnQty),
          ...(item.warehouseItemId ? { unitCostAtSale: costSnapshot } : {}),
        },
      });

      // CR1/CR2 (Блок C): для УСЛУГ/ручных позиций (без склада) с признанной
      // себестоимостью сторнируем COGS пропорционально возврату — отдельной
      // видимой проводкой (отрицательный COGS, дата возврата, привязка к
      // оригиналу). Независимо от рефанда (себестоимость следует за товаром, R4).
      // Складские товары COGS-проводки не имеют (R1/CR4) — их не трогаем.
      if (!item.warehouseItemId && item.unitCost !== null && gt(item.unitCost, '0')) {
        const cogsReversal = money(mul(returnQty, item.unitCost));
        // Сторнируем ТОЛЬКО против реально признанной COGS-проводки заказа.
        // Нет оригинала (нечего сторнировать) → пропускаем, чтобы не создать
        // «висячее» отрицательное COGS, уводящее себестоимость в минус.
        const originalCogs =
          gt(cogsReversal, '0')
            ? await tx.transaction.findFirst({
                where: { workspaceId, orderId, kind: 'COGS', originalTxId: null, deletedAt: null },
                select: { id: true, accountId: true },
              })
            : null;
        if (originalCogs) {
          await tx.transaction.create({
            data: {
              workspaceId,
              date: refundDate,
              amount: cogsReversal.negated(), // отрицательная → уменьшает COGS в P&L
              type: 'EXPENSE',
              kind: 'COGS',
              accountId: originalCogs.accountId,
              orderId,
              originalTxId: originalCogs.id,
              description: `Сторно себестоимости (возврат): ${item.name}`,
              createdById: userId,
            },
          });
        }
      }

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
      return this.freshWithMargin(workspaceId, orderId, tx);
    });
  }

  /**
   * B2: взять row-lock на заказ и перечитать его СВЕЖИМ внутри транзакции.
   * Все мутации заказа идут через это — чтение и валидация работают по
   * актуальному состоянию под локом, а не по снапшоту, прочитанному до tx.
   */
  private async lockAndLoad(
    tx: TxClient,
    workspaceId: string,
    orderId: string,
  ): Promise<NonNullable<Awaited<ReturnType<OrderRepository['findById']>>>> {
    await this.orders.lockForUpdate(tx, workspaceId, orderId);
    const order = await this.orders.findById(workspaceId, orderId, tx);
    if (!order) throw new NotFoundException('Order not found');
    return order;
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
   * Та же проверка, но ВНУТРИ транзакции (TOCTOU): между внешней assertAccount и
   * созданием проводки счёт могли soft-delete. Перепроверяем под tx прямо перед
   * tx.transaction.create, чтобы платёж/возврат не сел на удалённый счёт.
   */
  private async assertAccountTx(tx: TxClient, workspaceId: string, accountId: string) {
    const acc = await tx.account.findFirst({
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
    return this.uow.run(async (tx) => {
      // B2: лок + свежее чтение — параллельные finalize/ship не должны дважды
      // списать склад по устаревшему остатку (double-ship).
      const order = await this.lockAndLoad(tx, workspaceId, orderId);
      if (order.status === 'CANCELLED') {
        throw new BadRequestException('Заказ отменён');
      }
      if (order.status === 'DONE') return this.serializeOrder(order);

      let manualCogs = D(0);
      // Сортировка по warehouseItemId ASC — единый лок-порядок партий (анти-deadlock).
      for (const item of this.sortItemsForLocking(order.items ?? [])) {
        if (item.warehouseItemId) {
          // Списываем только ещё НЕ отгруженный остаток (часть могла уйти через ship).
          const remaining = sub(item.qty, item.shippedQty);
          if (gt(remaining, '0')) {
            await this.warehouse.decrementForSale(
              tx,
              workspaceId,
              item.warehouseItemId,
              remaining,
              userId,
              { refType: 'Order', refId: orderId, orderItemId: item.id },
            );
          }
          // Снимок себестоимости — из net-леджера (учитывает и ship, и этот finalize).
          const costSnapshot = await this.warehouse.unitCostAtSaleFor(tx, workspaceId, item.id);
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
            // BR2: фиксируем себестоимость услуги снимком в unitCostAtSale —
            // единообразно со складом, чтобы отчёт маржи (BR1) её видел.
            data: { shippedQty: item.qty, unitCostAtSale: item.unitCost },
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
      return this.freshWithMargin(workspaceId, orderId, tx);
    });
  }

  /**
   * Отмена заказа. Если заказ был DONE — откатываем финализацию: возвращаем
   * товар на склад и сторнируем COGS-расход. Платежи остаются (при необходимости
   * оформляется отдельный возврат).
   */
  async cancel(workspaceId: string, orderId: string, userId: string) {
    return this.uow.run(async (tx) => {
      const order = await this.lockAndLoad(tx, workspaceId, orderId); // B2
      if (order.status === 'CANCELLED') return this.serializeOrder(order);
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
      return this.freshWithMargin(workspaceId, orderId, tx);
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
    return this.uow.run(async (tx) => {
      const order = await this.lockAndLoad(tx, workspaceId, orderId); // B2
      if (order.status !== 'DONE' && order.status !== 'CANCELLED') {
        throw new BadRequestException(
          'Вернуть в работу можно только закрытый или отменённый заказ',
        );
      }
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
      return this.freshWithMargin(workspaceId, orderId, tx);
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
    for (const item of this.sortItemsForLocking(order.items ?? [])) {
      if (item.warehouseItemId) {
        const out = order.status === 'DONE' ? item.qty : item.shippedQty;
        const netOut = sub(out, item.returnedQty);
        if (gt(netOut, '0')) {
          // Реверсируем НЕ возвращённый ещё остаток списанного (returnedQty уже
          // реверсировал returnItem) — по остаточной реверсируемости, без двойного
          // реверса. Fallback на restock для до-миграционных/удалённых позиций.
          try {
            await this.warehouse.reverseConsumption(
              tx,
              workspaceId,
              item.warehouseItemId,
              item.id,
              netOut,
              userId,
              { refType: 'Order', refId: order.id },
            );
          } catch (e) {
            if (e instanceof NoConsumptionsError) {
              await this.warehouse.restock(
                tx,
                workspaceId,
                item.warehouseItemId,
                netOut,
                userId,
                { refType: 'Order', refId: order.id },
                item.unitCostAtSale ?? item.unitCost ?? null,
              );
            } else {
              throw e;
            }
          }
        }
      }
      // Сбрасываем отгрузку/снапшот себестоимости И накопленный возврат по всем
      // позициям. После полного отката (cancel/reopen/remove) заказ возвращается
      // в состояние «как с нуля»: товар целиком вернулся на склад (returnQty уже
      // restock'нут возвратом, остаток netOut — этим откатом), поэтому returnedQty
      // обязан обнулиться. Иначе после reopen→finalize повторный возврат считал бы
      // available = qty − старый returnedQty и ломал бы returnItem (M5).
      if (
        gt(item.shippedQty, '0') ||
        item.unitCostAtSale !== null ||
        gt(item.returnedQty, '0')
      ) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { shippedQty: D(0), unitCostAtSale: null, returnedQty: D(0) },
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
    return this.uow.run(async (tx) => {
      const order = await this.lockAndLoad(tx, workspaceId, orderId); // B2
      // Вернуть склад (DONE или частичный OPEN) и сторнировать COGS.
      await this.reverseFinalization(tx, workspaceId, order, userId);
      // Сторнируем все связанные операции (оплаты/возвраты), чтобы не висели в P&L.
      // txIds собираем ДО soft-delete — нужны для чистки вложений, привязанных к
      // платёжным операциям заказа (transactionId-linked, не orderId-linked).
      const orderTxs = await tx.transaction.findMany({
        where: { workspaceId, orderId },
        select: { id: true },
      });
      const orderTxIds = orderTxs.map((t) => t.id);
      await tx.transaction.updateMany({
        where: { workspaceId, orderId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      // DE6: снимаем ВСЕ вложения заказа (чеки) — и привязанные к заказу, и к его
      // платёжным операциям. Иначе строки висят на удалённом заказе (FK-cascade при
      // soft-delete не срабатывает), а download отдавал бы их по прямой ссылке.
      // Файлы content-addressed/дедуп per-workspace — физический GC орфанов = follow-up.
      await tx.attachment.deleteMany({
        where: { workspaceId, OR: [{ orderId }, { transactionId: { in: orderTxIds } }] },
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
   * F3: публичный пересчёт оплаты для внешних доменов (импорт выписки создаёт
   * ORDER_PAYMENT-проводки напрямую в своей транзакции).
   */
  recalcPaymentState(workspaceId: string, orderId: string, tx: TxClient) {
    return this.syncPaymentState(workspaceId, orderId, tx);
  }

  /**
   * GH8: дать внешнему домену (откат импорта) взять тот же строчный лок заказа
   * (FOR UPDATE), что и addPayment/deletePayment. Без него пересчёт оплаты при
   * откате гоняется с параллельной оплатой того же заказа (last-writer-wins по
   * paidAmount). Брать ДО пересчёта; заказы лочить в детерминированном порядке.
   */
  lockForUpdate(tx: TxClient, workspaceId: string, orderId: string): Promise<void> {
    return this.orders.lockForUpdate(tx, workspaceId, orderId);
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

    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount: paid, paymentStatus: resolvePaymentState(paid, total) },
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

/**
 * Чистое правило статуса оплаты заказа от (paid, total). Выделено из
 * syncPaymentState для unit-тестов.
 *
 * #10: при total=0 (нечего платить) и paid≥0 заказ считается PAID, а не UNPAID —
 * раньше ветка isZero(paid) срабатывала раньше сравнения с total и заказ с
 * total=0/paid=0 ошибочно оставался UNPAID. Порядок проверок:
 *   • paid<0  → REFUNDED (при любом total: вернули больше, чем заплатили);
 *   • total=0: paid=0 → PAID (платить нечего), paid>0 → OVERPAID (клиент
 *     переплатил по нулевому заказу — ему причитается возврат; важно для
 *     кэш-флоу, поэтому НЕ схлопываем в PAID);
 *   • далее (total>0) как раньше: 0→UNPAID, <total→PARTIAL, >total→OVERPAID, =→PAID.
 */
export function resolvePaymentState(
  paid: Prisma.Decimal,
  total: Prisma.Decimal,
): OrderPaymentState {
  if (paid.isNegative()) return 'REFUNDED';
  if (isZero(total)) return isZero(paid) ? 'PAID' : 'OVERPAID';
  if (isZero(paid)) return 'UNPAID';
  if (lt(paid, total)) return 'PARTIAL';
  if (gt(paid, total)) return 'OVERPAID';
  return 'PAID';
}

/** C2: kind'ы денежных операций заказа, удаляемых через deletePayment (не COGS). */
const DELETABLE_PAYMENT_KINDS = new Set<string>([
  'ORDER_PAYMENT',
  'ORDER_REFUND',
  'VARIABLE_COST',
]);

/** Хелпер: пересчёт total при изменении только скидки. */
function recomputeWithDiscount(
  subtotal: Prisma.Decimal,
  discountStr: string,
): { discountAmount: Prisma.Decimal; totalAmount: Prisma.Decimal } {
  const discount = money(discountStr);
  // R5b: та же защита, что и в create/replace — скидка не должна превышать
  // сумму позиций (иначе totalAmount < 0). DTO уже отсёк отрицательную скидку.
  if (gt(discount, subtotal)) {
    throw new BadRequestException('Скидка не может превышать сумму позиций');
  }
  return { discountAmount: discount, totalAmount: money(sub(subtotal, discount)) };
}
