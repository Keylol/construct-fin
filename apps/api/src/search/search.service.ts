import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type BankLineStatus,
  type CategoryKind,
  type CounterpartyRole,
  type OrderStatus,
  type TransactionKind,
  type TxType,
} from '@prisma/client';
import { parseSearchQuery, type ParsedSearch } from '@construct/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../common/workspace.guard';
import { findSearchIds, type SearchSpec } from '../common/text-search';
import { orderSearchSpec } from '../orders/order.search';
import { counterpartySearchSpec } from '../counterparty/counterparty.search';
import { transactionSearchSpec } from '../transaction/transaction.search';
import { inboxSearchSpec } from '../integrations/inbox.search';
import { purchaseSearchSpec } from '../purchase/purchase.search';
import { warehouseSearchSpec } from '../warehouse/warehouse.search';
import type { GlobalSearchQuery } from './search.dto';

export interface OrderHit {
  id: string;
  number: string;
  title: string | null;
  phone: string | null;
  clientName: string | null;
  totalAmount: string;
  paidAmount: string;
  status: OrderStatus;
  createdAt: string;
}

export interface CounterpartyHit {
  id: string;
  name: string;
  role: CounterpartyRole;
  contact: string | null;
  inn: string | null;
  isArchived: boolean;
}

export interface TransactionHit {
  id: string;
  date: string;
  amount: string;
  type: TxType;
  kind: TransactionKind;
  description: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  categoryName: string | null;
  accountName: string;
  orderId: string | null;
  purchaseId: string | null;
}

export interface InboxHit {
  id: string;
  date: string;
  amount: string;
  direction: TxType;
  description: string | null;
  counterpartyName: string | null;
  status: BankLineStatus;
  accountName: string | null;
}

export interface PurchaseHit {
  id: string;
  date: string;
  amount: string;
  supplierName: string | null;
  note: string | null;
  linesCount: number;
}

export interface WarehouseHit {
  id: string;
  name: string;
  sku: string | null;
  qty: string;
  unit: string;
  isArchived: boolean;
}

export interface AccountHit {
  id: string;
  name: string;
  isArchived: boolean;
}

export interface CategoryHit {
  id: string;
  name: string;
  kind: CategoryKind;
  isArchived: boolean;
}

interface Group<K extends string, T> {
  key: K;
  /** Сколько всего нашлось в разделе; в `items` — первые `limit`. */
  total: number;
  items: T[];
}

export type GlobalSearchGroup =
  | Group<'orders', OrderHit>
  | Group<'clients' | 'suppliers' | 'employees' | 'counterparties', CounterpartyHit>
  | Group<'transactions', TransactionHit>
  | (Group<'inbox', InboxHit> & { byStatus: Partial<Record<BankLineStatus, number>> })
  | Group<'purchases', PurchaseHit>
  | Group<'warehouse', WarehouseHit>
  | Group<'accounts', AccountHit>
  | Group<'categories', CategoryHit>;

export interface GlobalSearchResponse {
  /** Запрос, как его понял сервер (после чистки пробелов); пустой — искать нечего. */
  query: string;
  /** Непустые группы в постоянном порядке разделов. */
  groups: GlobalSearchGroup[];
}

const COUNTERPARTY_GROUPS: ReadonlyArray<[CounterpartyRole, 'clients' | 'suppliers' | 'employees' | 'counterparties']> = [
  ['CLIENT', 'clients'],
  ['SUPPLIER', 'suppliers'],
  ['EMPLOYEE', 'employees'],
  ['OTHER', 'counterparties'],
];

function accountSearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"Account" a`,
    id: Prisma.sql`a.id`,
    where: Prisma.sql`a."workspaceId" = ${workspaceId} AND a."deletedAt" IS NULL`,
    fields: [{ text: Prisma.sql`a.name` }, { text: Prisma.sql`a.note` }],
  };
}

function categorySearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"Category" c`,
    id: Prisma.sql`c.id`,
    where: Prisma.sql`c."workspaceId" = ${workspaceId} AND c."deletedAt" IS NULL`,
    fields: [{ text: Prisma.sql`c.name` }],
  };
}

/**
 * Общий поиск по разделам. Каждый раздел ищет по той же спецификации, что и его
 * список, поэтому «Показать все» на экране раздела находит те же записи.
 *
 * Роли: оператору не показываем то, что закрыто ему в меню (docs/roles.md) —
 * счета, статьи и прочих контрагентов. Это согласованность с меню, а не граница
 * безопасности: GET-эндпоинты этих справочников ролью не закрыты.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(ws: WorkspaceContext, query: GlobalSearchQuery): Promise<GlobalSearchResponse> {
    const search = parseSearchQuery(query.q);
    if (!search) return { query: '', groups: [] };

    const owner = ws.role === 'OWNER' || ws.role === 'ADMIN';
    const { workspaceId } = ws;
    const { limit } = query;

    const found = await Promise.all([
      this.orders(workspaceId, search, limit),
      this.counterparties(workspaceId, search, limit, owner),
      this.transactions(workspaceId, search, limit),
      this.inbox(workspaceId, search, limit),
      this.purchases(workspaceId, search, limit),
      this.warehouse(workspaceId, search, limit),
      owner ? this.accounts(workspaceId, search, limit) : null,
      owner ? this.categories(workspaceId, search, limit) : null,
    ]);

    const groups = found
      .flat()
      .filter((g): g is GlobalSearchGroup => g !== null && g.total > 0);
    return { query: search.raw, groups };
  }

  private async orders(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, orderSearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    const rows = await this.prisma.order.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        number: true,
        title: true,
        phone: true,
        totalAmount: true,
        paidAmount: true,
        status: true,
        createdAt: true,
        client: { select: { name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return {
      key: 'orders',
      total: ids.length,
      items: rows.map((o) => ({
        id: o.id,
        number: o.number,
        title: o.title,
        phone: o.phone,
        clientName: o.client?.name ?? null,
        totalAmount: o.totalAmount.toFixed(2),
        paidAmount: o.paidAmount.toFixed(2),
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  /** Один поиск по справочнику, разложенный по разделам: клиенты, поставщики, сотрудники, прочие. */
  private async counterparties(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
    owner: boolean,
  ): Promise<GlobalSearchGroup[]> {
    const ids = await findSearchIds(this.prisma, counterpartySearchSpec(workspaceId), search);
    if (ids.length === 0) return [];
    const rows = await this.prisma.counterparty.findMany({
      where: { id: { in: ids }, ...(owner ? {} : { role: { not: 'OTHER' } }) },
      select: { id: true, name: true, role: true, contact: true, inn: true, isArchived: true },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
    });
    return COUNTERPARTY_GROUPS.map(([role, key]) => {
      const inRole = rows.filter((r) => r.role === role);
      return { key, total: inRole.length, items: inRole.slice(0, limit) };
    });
  }

  private async transactions(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, transactionSearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    // Себестоимость проводит система, а у перевода две половины — хватит исходящей.
    const where: Prisma.TransactionWhereInput = {
      id: { in: ids },
      kind: { notIn: ['COGS', 'TRANSFER_IN'] },
    };
    const [total, rows] = await Promise.all([
      this.prisma.transaction.count({ where }),
      this.prisma.transaction.findMany({
        where,
        select: {
          id: true,
          date: true,
          amount: true,
          type: true,
          kind: true,
          description: true,
          orderId: true,
          counterpartyId: true,
          account: { select: { name: true } },
          category: { select: { name: true } },
          counterparty: { select: { name: true } },
          purchase: { select: { id: true } },
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);
    if (total === 0) return null;
    return {
      key: 'transactions',
      total,
      items: rows.map((t) => ({
        id: t.id,
        date: t.date.toISOString(),
        amount: t.amount.toFixed(2),
        type: t.type,
        kind: t.kind,
        description: t.description,
        counterpartyId: t.counterpartyId,
        counterpartyName: t.counterparty?.name ?? null,
        categoryName: t.category?.name ?? null,
        accountName: t.account.name,
        orderId: t.orderId,
        purchaseId: t.purchase?.id ?? null,
      })),
    };
  }

  private async inbox(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, inboxSearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    // Отклонённые строки «Входящие» не показывают — и здесь они не нужны.
    const where: Prisma.BankStatementLineWhereInput = { id: { in: ids }, status: { not: 'DISMISSED' } };
    const [byStatus, rows] = await Promise.all([
      this.prisma.bankStatementLine.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.bankStatementLine.findMany({
        where,
        select: {
          id: true,
          date: true,
          amount: true,
          direction: true,
          description: true,
          counterpartyName: true,
          status: true,
          connection: { select: { account: { select: { name: true } } } },
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);
    const total = byStatus.reduce((sum, g) => sum + g._count._all, 0);
    if (total === 0) return null;
    return {
      key: 'inbox',
      total,
      byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
      items: rows.map((l) => ({
        id: l.id,
        date: l.date.toISOString(),
        amount: l.amount.toFixed(2),
        direction: l.direction,
        description: l.description,
        counterpartyName: l.counterpartyName,
        status: l.status,
        accountName: l.connection?.account?.name ?? null,
      })),
    };
  }

  private async purchases(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, purchaseSearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    const rows = await this.prisma.purchase.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        note: true,
        supplier: { select: { name: true } },
        transaction: { select: { date: true, amount: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ transaction: { date: 'desc' } }, { id: 'desc' }],
      take: limit,
    });
    return {
      key: 'purchases',
      total: ids.length,
      items: rows.map((p) => ({
        id: p.id,
        date: p.transaction.date.toISOString(),
        amount: p.transaction.amount.toFixed(2),
        supplierName: p.supplier?.name ?? null,
        note: p.note,
        linesCount: p._count.lines,
      })),
    };
  }

  private async warehouse(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, warehouseSearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    const rows = await this.prisma.warehouseItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, sku: true, qty: true, unit: true, isArchived: true },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: limit,
    });
    return {
      key: 'warehouse',
      total: ids.length,
      items: rows.map((w) => ({ ...w, qty: w.qty.toString() })),
    };
  }

  private async accounts(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, accountSearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    const rows = await this.prisma.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, isArchived: true },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: limit,
    });
    return { key: 'accounts', total: ids.length, items: rows };
  }

  private async categories(
    workspaceId: string,
    search: ParsedSearch,
    limit: number,
  ): Promise<GlobalSearchGroup | null> {
    const ids = await findSearchIds(this.prisma, categorySearchSpec(workspaceId), search);
    if (ids.length === 0) return null;
    const rows = await this.prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, kind: true, isArchived: true },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: limit,
    });
    return { key: 'categories', total: ids.length, items: rows };
  }
}
