'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Account, AccountType, CashflowReport } from '@/lib/types';

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  openingBalance?: string;
  note?: string;
}

export interface UpdateAccountInput {
  name?: string;
  type?: AccountType;
  openingBalance?: string;
  note?: string | null;
  isArchived?: boolean;
}

export function useAccounts(wsId: string | null, includeArchived = false) {
  return useQuery({
    queryKey: ['accounts', wsId, { includeArchived }],
    queryFn: () =>
      api.get<Account[]>(`/workspaces/${wsId}/accounts?includeArchived=${includeArchived}`),
    enabled: !!wsId,
  });
}

/**
 * Текущие остатки по счетам: id → баланс (Decimal-строка). Считается бэкендом
 * через ОДДС mode=byAccount (prior-история включена в серию, последний бакет =
 * баланс на сегодня). Отдельного эндпоинта балансов нет — переиспользуем отчёт.
 */
export function useAccountBalances(wsId: string | null) {
  return useQuery({
    // Ключ под префиксом ['reports'] — мутации операций/переводов/закупок уже
    // инвалидируют его, остатки обновятся сами.
    queryKey: ['reports', 'account-balances', wsId],
    queryFn: () =>
      api.get<CashflowReport>(
        `/workspaces/${wsId}/reports/cashflow?preset=this-month&mode=byAccount`,
      ),
    enabled: !!wsId,
    select: (report) => {
      const byId = new Map<string, string>();
      for (const s of report.series) {
        if (!s.accountId) continue;
        const last = s.points[s.points.length - 1];
        byId.set(s.accountId, last ? last.balance : s.openingBalance);
      }
      return byId;
    },
  });
}

export function useCreateAccount(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) =>
      api.post<Account>(`/workspaces/${wsId}/accounts`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts', wsId] }),
  });
}

export function useUpdateAccount(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAccountInput & { id: string }) =>
      api.patch<Account>(`/workspaces/${wsId}/accounts/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts', wsId] }),
  });
}

export function useDeleteAccount(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/accounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts', wsId] }),
  });
}
