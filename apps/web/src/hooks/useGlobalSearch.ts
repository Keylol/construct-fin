'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type {
  BankLineStatus,
  CategoryKind,
  CounterpartyRole,
  OrderStatus,
  TransactionKind,
  TxType,
} from '@/lib/types';

// Ответ GET /workspaces/:wsId/search — зеркало apps/api/src/search/search.service.ts.

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
  query: string;
  groups: GlobalSearchGroup[];
}

/** Короче двух символов не ищем: «а» находит полбазы и только мешает. */
export const GLOBAL_SEARCH_MIN_LENGTH = 2;

/** Общий поиск по всем разделам: заказы, клиенты, операции, выписка, закупки, склад. */
export function useGlobalSearch(wsId: string | null, query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ['global-search', wsId, q],
    queryFn: async (): Promise<GlobalSearchResponse | null> => {
      try {
        return await api.get<GlobalSearchResponse>(
          `/workspaces/${wsId}/search?q=${encodeURIComponent(q)}&limit=5`,
        );
      } catch (e) {
        // Сервер ещё без общего поиска (веб выехал раньше API): палитра остаётся
        // с разделами и командами, без тоста об ошибке на каждую букву.
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!wsId && q.length >= GLOBAL_SEARCH_MIN_LENGTH,
    // Пока летит новый запрос, в окне остаются прошлые результаты, а не пустота.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
}
