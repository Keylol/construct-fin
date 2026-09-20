import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CrmConnection } from '@prisma/client';
import { findClient } from '@construct/shared';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../orders/order.service';
import { CounterpartyService } from '../counterparty/counterparty.service';
import { AuditService } from '../audit/audit.service';
import type { ListCrmDealsQuery } from './crm.dto';
import type { PipelineSnapshot } from './amo-map';
import { matchDealsToOrders, type MatchPair, type MatchReason } from './crm-match';

const ORDER_SELECT = {
  id: true,
  number: true,
  phone: true,
  status: true,
  paymentStatus: true,
  totalAmount: true,
  paidAmount: true,
  createdAt: true,
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;
type DealRow = Prisma.CrmDealGetPayload<{ include: { order: { select: typeof ORDER_SELECT } } }>;

/** Сколько заказов-кандидатов по телефону показывать у сделки. */
const SUGGESTIONS_PER_DEAL = 3;

/**
 * Панель amoCRM: список сделок из снимка, связь сделка ↔ заказ, заведение
 * заказа из сделки. Доступно всем членам пространства — оператор работает с
 * результатом, ключи ему не видны (как «Входящие»).
 */
@Injectable()
export class CrmDealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly counterparties: CounterpartyService,
    private readonly audit: AuditService,
  ) {}

  async summary(workspaceId: string) {
    const conn = await this.connection(workspaceId);
    if (!conn) {
      return { connected: false as const };
    }
    const waitingWhere = this.waitingWhere(conn);
    const [waiting, linked, total] = await Promise.all([
      this.prisma.crmDeal.aggregate({
        where: waitingWhere,
        _count: { _all: true },
        _sum: { price: true },
      }),
      this.prisma.crmDeal.count({
        where: { workspaceId, connectionId: conn.id, orderId: { not: null } },
      }),
      this.prisma.crmDeal.count({
        where: {
          workspaceId,
          connectionId: conn.id,
          isClosed: false,
          ...this.pipelineFilter(conn),
        },
      }),
    ]);
    const pipeline = this.pipelineOf(conn);
    const waitingStageNames = (pipeline?.statuses ?? [])
      .filter((s) => conn.waitingStatusIds.includes(s.id))
      .map((s) => s.name);
    return {
      connected: true as const,
      status: conn.status,
      lastSyncAt: conn.lastSyncAt?.toISOString() ?? null,
      lastSyncError: conn.lastSyncError,
      pipelineName: pipeline?.name ?? null,
      waitingStageNames,
      waitingCount: waiting._count._all,
      waitingSum: (waiting._sum.price ?? new Prisma.Decimal(0)).toFixed(2),
      linkedCount: linked,
      openCount: total,
    };
  }

  async list(workspaceId: string, q: ListCrmDealsQuery) {
    const conn = await this.connection(workspaceId);
    if (!conn) return { items: [], nextCursor: null };

    const where: Prisma.CrmDealWhereInput = { AND: [this.tabWhere(conn, q.tab)] };
    const and = where.AND as Prisma.CrmDealWhereInput[];
    if (q.statusId) and.push({ statusId: q.statusId });
    if (q.search) and.push(this.searchWhere(q.search));
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      and.push({
        OR: [
          { remoteUpdatedAt: { lt: cursor.at } },
          { remoteUpdatedAt: cursor.at, id: { lt: cursor.id } },
        ],
      });
    }
    const rows = await this.prisma.crmDeal.findMany({
      where,
      include: { order: { select: ORDER_SELECT } },
      orderBy: [{ remoteUpdatedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const suggestions = await this.suggestions(workspaceId, page);
    const last = page[page.length - 1];
    return {
      items: page.map((d) => this.serialize(d, conn, suggestions.get(d.id) ?? [])),
      nextCursor: hasMore && last ? encodeCursor(last.remoteUpdatedAt, last.id) : null,
    };
  }

  /** Привязать сделку к существующему заказу. */
  async link(workspaceId: string, userId: string, dealId: string, orderId: string) {
    const deal = await this.assertDeal(workspaceId, dealId);
    if (deal.orderId)
      throw new ConflictException('Сделка уже привязана к заказу — сначала отвяжите');
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, workspaceId, deletedAt: null },
      select: { id: true, number: true },
    });
    if (!order) throw new NotFoundException('Заказ не найден');
    await this.prisma.crmDeal.update({
      where: { id: deal.id },
      data: { orderId: order.id, linkedAt: new Date(), dismissedAt: null },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.link',
      entityType: 'CrmDeal',
      entityId: deal.id,
      diff: { externalId: deal.externalId, orderId: order.id, orderNumber: order.number },
    });
    return this.one(workspaceId, deal.id);
  }

  async unlink(workspaceId: string, userId: string, dealId: string) {
    const deal = await this.assertDeal(workspaceId, dealId);
    if (!deal.orderId) throw new BadRequestException('Сделка не привязана к заказу');
    await this.prisma.crmDeal.update({
      where: { id: deal.id },
      data: { orderId: null, linkedAt: null },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.unlink',
      entityType: 'CrmDeal',
      entityId: deal.id,
      diff: { externalId: deal.externalId, orderId: deal.orderId },
    });
    return this.one(workspaceId, deal.id);
  }

  /** «Не учитывать» / «Вернуть»: обратимо, как у строк выписки. */
  async setDismissed(workspaceId: string, userId: string, dealId: string, dismissed: boolean) {
    const deal = await this.assertDeal(workspaceId, dealId);
    if (dismissed && deal.orderId)
      throw new ConflictException('Сделка привязана к заказу — сначала отвяжите');
    await this.prisma.crmDeal.update({
      where: { id: deal.id },
      data: { dismissedAt: dismissed ? new Date() : null },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.dismiss',
      entityType: 'CrmDeal',
      entityId: deal.id,
      diff: { externalId: deal.externalId, dismissed },
    });
    return this.one(workspaceId, deal.id);
  }

  /**
   * Завести заказ из сделки одной кнопкой: клиент по телефону (или новый),
   * заказ с телефоном, названием сделки, пожеланиями и одной позицией на
   * бюджет сделки. Позиции по спецификации человек уточнит в карточке.
   */
  async createOrder(workspaceId: string, userId: string, dealId: string) {
    const deal = await this.assertDeal(workspaceId, dealId);
    if (deal.orderId) throw new ConflictException('Сделка уже привязана к заказу');
    if (!deal.phone) {
      throw new BadRequestException(
        'У сделки нет телефона контакта — добавьте его в amoCRM или заведите заказ вручную и привяжите',
      );
    }
    const clients = await this.prisma.counterparty.findMany({
      where: { workspaceId, role: 'CLIENT', deletedAt: null, isArchived: false },
      select: { id: true, name: true, contact: true },
    });
    const clientName = deal.contactName ?? deal.name;
    const found = findClient(clients, clientName, deal.phone);
    const client =
      found ??
      (await this.counterparties.create(workspaceId, {
        name: clientName,
        role: 'CLIENT',
        contact: deal.phone,
        source: 'amoCRM',
      }));

    const price = deal.price.toFixed(2);
    const description = [deal.wishes, `amoCRM: сделка #${deal.externalId}`]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 2000);
    const order = await this.orders.create(workspaceId, {
      clientId: client.id,
      phone: deal.phone,
      title: deal.name.slice(0, 200),
      description,
      items:
        Number(price) > 0
          ? [{ name: 'Сборка ПК (по сделке amoCRM)', qty: '1', unitPrice: price, unitCost: null }]
          : [],
    });
    await this.prisma.crmDeal.update({
      where: { id: deal.id },
      data: { orderId: order.id, linkedAt: new Date(), dismissedAt: null },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.create-order',
      entityType: 'CrmDeal',
      entityId: deal.id,
      diff: {
        externalId: deal.externalId,
        orderId: order.id,
        orderNumber: order.number,
        clientId: client.id,
      },
    });
    return {
      orderId: order.id,
      orderNumber: order.number,
      deal: await this.one(workspaceId, deal.id),
    };
  }

  /** Счётчик «ждут заказа» для бейджа в меню — один лёгкий запрос. */
  async waitingCount(workspaceId: string): Promise<{ count: number }> {
    const conn = await this.connection(workspaceId);
    if (!conn) return { count: 0 };
    return { count: await this.prisma.crmDeal.count({ where: this.waitingWhere(conn) }) };
  }

  /**
   * Предложения «сделка ↔ существующий заказ»: сводит непривязанные сделки со
   * свободными заказами учёта. Считается на сервере целиком — человеку остаётся
   * снять лишние галочки, а не искать пары руками по 2 267 сделкам.
   *
   * Охват НАМЕРЕННО шире вкладки «Ждут заказа»: сюда входят и закрытые сделки, и
   * этапы вне набора «ждут заказа», потому что сопоставлять надо в первую
   * очередь старые, уже проведённые заказы (на проде их 63 из 94). Поэтому пар
   * в окне бывает больше, чем число на бейдже, — так и задумано.
   */
  async matchSuggestions(workspaceId: string) {
    const conn = await this.connection(workspaceId);
    if (!conn) return { items: [], confidentCount: 0 };

    const [deals, orders] = await Promise.all([
      this.prisma.crmDeal.findMany({
        where: {
          workspaceId,
          connectionId: conn.id,
          orderId: null,
          dismissedAt: null,
          // Сделка без телефона и без суммы не сопоставима ни одним правилом.
          OR: [{ phone: { not: null } }, { price: { gt: 0 } }],
        },
        select: {
          id: true,
          externalId: true,
          name: true,
          price: true,
          phone: true,
          contactName: true,
          statusName: true,
          isClosed: true,
          remoteCreatedAt: true,
        },
      }),
      this.prisma.order.findMany({
        // Заказ, на котором уже сидит сделка, во второй паре не участвует.
        where: { workspaceId, deletedAt: null, crmDeals: { none: {} } },
        select: { ...ORDER_SELECT, clientId: true, client: { select: { id: true, name: true } } },
      }),
    ]);

    const pairs = matchDealsToOrders(
      deals.map((d) => ({
        id: d.id,
        price: d.price.toFixed(2),
        phone: d.phone,
        contactName: d.contactName,
        name: d.name,
        remoteCreatedAt: d.remoteCreatedAt,
      })),
      orders.map((o) => ({
        id: o.id,
        phone: o.phone,
        totalAmount: o.totalAmount.toFixed(2),
        clientName: o.client?.name ?? null,
        createdAt: o.createdAt,
      })),
    );

    const dealById = new Map(deals.map((d) => [d.id, d]));
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const items = pairs.flatMap((pair: MatchPair) => {
      const d = dealById.get(pair.dealId);
      const o = orderById.get(pair.orderId);
      if (!d || !o) return [];
      return [
        {
          reason: pair.reason as MatchReason,
          confident: pair.confident,
          daysApart: pair.daysApart,
          deal: {
            id: d.id,
            externalId: d.externalId,
            url: `https://${conn.subdomain}.amocrm.ru/leads/detail/${d.externalId}`,
            name: d.name,
            price: d.price.toFixed(2),
            statusName: d.statusName,
            isClosed: d.isClosed,
            contactName: d.contactName,
            phone: d.phone,
            remoteCreatedAt: d.remoteCreatedAt.toISOString(),
          },
          order: {
            ...serializeOrder(o),
            clientName: o.client?.name ?? null,
          },
        },
      ];
    });
    return { items, confidentCount: items.filter((i) => i.confident).length };
  }

  /**
   * Массовая привязка отмеченных пар. Пара пропускается (а не роняет весь
   * разбор), если сделку или заказ уже заняли: список собран до нажатия, за это
   * время состояние могло измениться.
   *
   * Заодно дозаполняет карточку клиента из контакта amo (решение владельца
   * 20.09.2026: телефон заполнен у 46 клиентов из 161). Заполненное НЕ
   * перезаписывается, каждое изменение — в аудит.
   */
  async linkBulk(
    workspaceId: string,
    userId: string,
    pairs: { dealId: string; orderId: string }[],
  ) {
    let linked = 0;
    let skipped = 0;
    let clientsPatched = 0;

    for (const pair of pairs) {
      const deal = await this.prisma.crmDeal.findFirst({
        where: { id: pair.dealId, workspaceId, orderId: null },
      });
      if (!deal) {
        skipped += 1;
        continue;
      }
      const order = await this.prisma.order.findFirst({
        where: { id: pair.orderId, workspaceId, deletedAt: null, crmDeals: { none: {} } },
        select: { id: true, number: true, clientId: true },
      });
      if (!order) {
        skipped += 1;
        continue;
      }

      // Привязка — одним условным UPDATE (`orderId: null` в where), а не
      // «прочитали и записали»: два человека, нажавшие «Привязать отмеченные»
      // на одном списке, иначе перезаписали бы привязку друг друга. Кто успел
      // второй — получает skipped, как и на устаревшей паре.
      const claimed = await this.prisma.crmDeal.updateMany({
        where: { id: deal.id, workspaceId, orderId: null },
        data: { orderId: order.id, linkedAt: new Date(), dismissedAt: null },
      });
      if (claimed.count === 0) {
        skipped += 1;
        continue;
      }
      const patched = await this.patchClientFromDeal(workspaceId, userId, order.clientId, deal);
      if (patched) clientsPatched += 1;
      linked += 1;

      await this.audit.record(undefined, {
        workspaceId,
        actorId: userId,
        action: 'crm.link',
        entityType: 'CrmDeal',
        entityId: deal.id,
        diff: {
          externalId: deal.externalId,
          orderId: order.id,
          orderNumber: order.number,
          bulk: true,
          clientPatched: patched,
        },
      });
    }
    return { linked, skipped, clientsPatched };
  }

  /**
   * Телефон и источник клиенту из сделки — только в пустые поля. Возвращает
   * true, если карточка действительно изменилась.
   */
  private async patchClientFromDeal(
    workspaceId: string,
    userId: string,
    clientId: string | null,
    deal: { phone: string | null; externalId: number },
  ): Promise<boolean> {
    if (!clientId) return false;
    const client = await this.prisma.counterparty.findFirst({
      where: { id: clientId, workspaceId, deletedAt: null },
      select: { id: true, contact: true, source: true },
    });
    if (!client) return false;
    const data: { contact?: string; source?: string } = {};
    if (deal.phone && !client.contact?.trim()) data.contact = deal.phone;
    if (!client.source?.trim()) data.source = 'amoCRM';
    if (Object.keys(data).length === 0) return false;

    await this.prisma.counterparty.update({ where: { id: client.id }, data });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.client-enrich',
      entityType: 'Counterparty',
      entityId: client.id,
      diff: { ...data, fromDeal: deal.externalId },
    });
    return true;
  }

  /**
   * Этапы наблюдаемой воронки в порядке доски с числом открытых сделок — для окна
   * настроек: выбирать этапы «ждут заказа» глядя на цифры, а не по памяти.
   */
  async stages(workspaceId: string) {
    const conn = await this.connection(workspaceId);
    if (!conn) return [];
    const pipeline = this.pipelineOf(conn);
    if (!pipeline) return [];
    const counts = await this.prisma.crmDeal.groupBy({
      by: ['statusId'],
      where: { workspaceId, connectionId: conn.id, pipelineId: pipeline.id, isClosed: false },
      _count: { _all: true },
    });
    const byStatus = new Map(counts.map((c) => [c.statusId, c._count._all]));
    return pipeline.statuses
      .filter((s) => s.type === 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        sort: s.sort,
        openCount: byStatus.get(s.id) ?? 0,
        waiting: conn.waitingStatusIds.includes(s.id),
      }));
  }

  // ───────────────────────── внутреннее ─────────────────────────

  /** Наблюдаемая воронка из снимка; воронка не выбрана — первая в снимке. */
  private pipelineOf(conn: CrmConnection): PipelineSnapshot | null {
    const pipelines = (conn.pipelines as unknown as PipelineSnapshot[] | null) ?? [];
    if (conn.pipelineId == null) return pipelines[0] ?? null;
    return pipelines.find((p) => p.id === conn.pipelineId) ?? null;
  }

  private connection(workspaceId: string) {
    return this.prisma.crmConnection.findFirst({ where: { workspaceId, deletedAt: null } });
  }

  private async assertDeal(workspaceId: string, dealId: string) {
    const deal = await this.prisma.crmDeal.findFirst({ where: { id: dealId, workspaceId } });
    if (!deal) throw new NotFoundException('Сделка не найдена');
    return deal;
  }

  private async one(workspaceId: string, dealId: string) {
    const conn = await this.connection(workspaceId);
    const row = await this.prisma.crmDeal.findFirstOrThrow({
      where: { id: dealId, workspaceId },
      include: { order: { select: ORDER_SELECT } },
    });
    const suggestions = await this.suggestions(workspaceId, [row]);
    return this.serialize(row, conn, suggestions.get(row.id) ?? []);
  }

  private pipelineFilter(conn: CrmConnection): Prisma.CrmDealWhereInput {
    return conn.pipelineId != null ? { pipelineId: conn.pipelineId } : {};
  }

  private waitingWhere(conn: CrmConnection): Prisma.CrmDealWhereInput {
    return {
      workspaceId: conn.workspaceId,
      connectionId: conn.id,
      isClosed: false,
      orderId: null,
      dismissedAt: null,
      ...this.pipelineFilter(conn),
      ...(conn.waitingStatusIds.length > 0 ? { statusId: { in: conn.waitingStatusIds } } : {}),
    };
  }

  private tabWhere(conn: CrmConnection, tab: ListCrmDealsQuery['tab']): Prisma.CrmDealWhereInput {
    const base = { workspaceId: conn.workspaceId, connectionId: conn.id };
    switch (tab) {
      case 'waiting':
        return this.waitingWhere(conn);
      case 'linked':
        return { ...base, orderId: { not: null } };
      case 'dismissed':
        return { ...base, dismissedAt: { not: null } };
      case 'all':
        return { ...base, ...this.pipelineFilter(conn) };
    }
  }

  /** Имя сделки, контакт, телефон (по цифрам) или бюджет (число). */
  private searchWhere(search: string): Prisma.CrmDealWhereInput {
    const or: Prisma.CrmDealWhereInput[] = [
      { name: { contains: search, mode: 'insensitive' } },
      { contactName: { contains: search, mode: 'insensitive' } },
      { responsibleName: { contains: search, mode: 'insensitive' } },
    ];
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 4) or.push({ phone: { contains: digits } });
    const amount = Number(search.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(amount) && amount > 0) or.push({ price: new Prisma.Decimal(amount) });
    return { OR: or };
  }

  /** Открытые заказы с тем же телефоном — кандидаты на «Привязать» одним кликом. */
  private async suggestions(
    workspaceId: string,
    deals: DealRow[],
  ): Promise<Map<string, OrderRow[]>> {
    const result = new Map<string, OrderRow[]>();
    const phones = [
      ...new Set(deals.filter((d) => !d.orderId && d.phone).map((d) => d.phone as string)),
    ];
    if (phones.length === 0) return result;
    const orders = await this.prisma.order.findMany({
      where: { workspaceId, deletedAt: null, status: 'OPEN', phone: { in: phones } },
      select: ORDER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    const byPhone = new Map<string, OrderRow[]>();
    for (const o of orders) {
      const list = byPhone.get(o.phone as string) ?? [];
      if (list.length < SUGGESTIONS_PER_DEAL) list.push(o);
      byPhone.set(o.phone as string, list);
    }
    for (const d of deals) {
      if (!d.orderId && d.phone) result.set(d.id, byPhone.get(d.phone) ?? []);
    }
    return result;
  }

  private serialize(d: DealRow, conn: CrmConnection | null, suggestedOrders: OrderRow[]) {
    return {
      id: d.id,
      externalId: d.externalId,
      url: conn ? `https://${conn.subdomain}.amocrm.ru/leads/detail/${d.externalId}` : null,
      name: d.name,
      price: d.price.toFixed(2),
      pipelineId: d.pipelineId,
      pipelineName: d.pipelineName,
      statusId: d.statusId,
      statusName: d.statusName,
      statusSort: d.statusSort,
      isClosed: d.isClosed,
      isWon: d.isWon,
      responsibleName: d.responsibleName,
      contactName: d.contactName,
      phone: d.phone,
      wishes: d.wishes,
      remoteCreatedAt: d.remoteCreatedAt.toISOString(),
      remoteUpdatedAt: d.remoteUpdatedAt.toISOString(),
      remoteClosedAt: d.remoteClosedAt?.toISOString() ?? null,
      linkedAt: d.linkedAt?.toISOString() ?? null,
      dismissedAt: d.dismissedAt?.toISOString() ?? null,
      order: d.order ? serializeOrder(d.order) : null,
      suggestedOrders: suggestedOrders.map(serializeOrder),
    };
  }
}

function serializeOrder(o: OrderRow) {
  return {
    id: o.id,
    number: o.number,
    phone: o.phone,
    status: o.status,
    paymentStatus: o.paymentStatus,
    totalAmount: o.totalAmount.toFixed(2),
    paidAmount: o.paidAmount.toFixed(2),
    createdAt: o.createdAt.toISOString(),
  };
}

function encodeCursor(at: Date, id: string): string {
  return `${at.getTime()}_${id}`;
}

function decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf('_');
  if (idx <= 0) return null;
  const ms = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { at: new Date(ms), id };
}
