'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  ColumnMapping,
  ImportBatch,
  ImportSource,
  PreviewResult,
  PreviewRow,
} from '@/lib/types';

export interface CommitRow {
  date: string;
  amount: string;
  type: 'INCOME' | 'EXPENSE';
  description: string | null;
  counterpartyName: string | null;
  categoryId: string | null;
  importHash: string;
  isDuplicate: boolean;
}

export interface CommitInput {
  filename: string;
  fileHash: string;
  source: ImportSource;
  accountId: string;
  skipDuplicates: boolean;
  rows: CommitRow[];
}

export interface PreviewInput {
  file: File;
  accountId: string;
  source?: ImportSource;
  mapping?: ColumnMapping;
}

export function rowToCommitRow(r: PreviewRow, categoryId: string | null): CommitRow {
  return {
    date: r.date,
    amount: r.amount,
    type: r.type,
    description: r.description,
    counterpartyName: r.counterpartyName,
    categoryId,
    importHash: r.importHash,
    isDuplicate: r.isDuplicate,
  };
}

export function useImportPreview(wsId: string) {
  return useMutation({
    mutationFn: async (input: PreviewInput): Promise<PreviewResult> => {
      const params = new URLSearchParams({ accountId: input.accountId });
      if (input.source) params.set('source', input.source);
      if (input.mapping) params.set('mapping', JSON.stringify(input.mapping));
      const fd = new FormData();
      fd.append('file', input.file);
      const res = await fetch(
        `/api/v1/workspaces/${wsId}/import/preview?${params.toString()}`,
        {
          method: 'POST',
          credentials: 'include',
          body: fd,
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Preview failed: ${res.status} ${body}`);
      }
      return (await res.json()) as PreviewResult;
    },
  });
}

export function useImportCommit(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommitInput) =>
      api.post<{ batchId: string; imported: number; skipped: number }>(
        `/workspaces/${wsId}/import/commit`,
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['import-batches', wsId] });
    },
  });
}

export function useImportBatches(wsId: string | null) {
  return useQuery({
    queryKey: ['import-batches', wsId],
    queryFn: () => api.get<ImportBatch[]>(`/workspaces/${wsId}/import/batches`),
    enabled: !!wsId,
  });
}

export function useRollbackImport(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) =>
      api.post<{ rolledBack: number }>(
        `/workspaces/${wsId}/import/batches/${batchId}/rollback`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['import-batches', wsId] });
    },
  });
}
