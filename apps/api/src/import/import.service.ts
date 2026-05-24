import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { ImportSource } from '@construct/db';
import { applyRules } from '../category-rule/matcher';
import {
  detectSourceByFilename,
  parseAlfaXlsx,
  parseGenericCsv,
  parseGenericXlsx,
  parseWbPdf,
} from './parsers';
import type { ColumnMapping, ParseResult } from './parsers/types';
import type {
  CommitResult,
  PreviewResult,
  PreviewRow,
  RollbackResult,
} from './import.types';
import type { CommitBody } from './import.dto';

@Injectable()
export class ImportService {
  constructor(private readonly prisma: PrismaService) {}

  computeFileHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private computeRowHash(input: {
    workspaceId: string;
    accountId: string;
    date: Date;
    amount: string;
    type: 'INCOME' | 'EXPENSE';
    counterpartyName: string | null;
    description: string | null;
  }): string {
    const canonical = [
      input.workspaceId,
      input.accountId,
      input.date.toISOString().slice(0, 10),
      input.amount,
      input.type,
      (input.counterpartyName ?? '').trim().toLowerCase(),
      (input.description ?? '').trim().toLowerCase().slice(0, 80),
    ].join('|');
    return createHash('sha256').update(canonical).digest('hex');
  }

  private async runParser(opts: {
    buffer: Buffer;
    filename: string;
    mimeType?: string;
    source?: ImportSource;
    mapping?: ColumnMapping;
  }): Promise<ParseResult> {
    const source =
      opts.source ?? detectSourceByFilename(opts.filename, opts.mimeType);
    switch (source) {
      case 'ALFA_XLSX':
        return parseAlfaXlsx(opts.buffer);
      case 'WB_PDF':
        return parseWbPdf(opts.buffer);
      case 'GENERIC_XLSX':
        return parseGenericXlsx(opts.buffer, opts.mapping);
      case 'GENERIC_CSV':
        return parseGenericCsv(opts.buffer, opts.mapping);
      case 'TINKOFF_PDF':
        throw new BadRequestException(
          'Тинькофф PDF парсер ещё не реализован — нет фикстуры',
        );
    }
  }

  async preview(opts: {
    workspaceId: string;
    accountId: string;
    buffer: Buffer;
    filename: string;
    mimeType?: string;
    source?: ImportSource;
    mapping?: ColumnMapping;
  }): Promise<PreviewResult> {
    const account = await this.prisma.account.findFirst({
      where: { id: opts.accountId, workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const parsed = await this.runParser(opts);

    const cpNames = Array.from(
      new Set(
        parsed.rows
          .map((r) => r.counterpartyName?.trim())
          .filter((n): n is string => !!n)
          .map((n) => n.toLowerCase()),
      ),
    );
    const existingCps =
      cpNames.length > 0
        ? await this.prisma.counterparty.findMany({
            where: {
              workspaceId: opts.workspaceId,
              deletedAt: null,
              name: { in: cpNames, mode: 'insensitive' },
            },
            select: { id: true, name: true },
          })
        : [];
    const cpByLcName = new Map<string, string>();
    for (const cp of existingCps) cpByLcName.set(cp.name.toLowerCase(), cp.id);

    const rules = await this.prisma.categoryRule.findMany({
      where: { workspaceId: opts.workspaceId, isActive: true, deletedAt: null },
      select: { keyword: true, categoryId: true, priority: true },
    });

    const previewRows: PreviewRow[] = [];
    let invalidCount = 0;
    for (const r of parsed.rows) {
      if (!r.date || !r.amount || !r.type) {
        invalidCount++;
        continue;
      }
      const importHash = this.computeRowHash({
        workspaceId: opts.workspaceId,
        accountId: opts.accountId,
        date: r.date,
        amount: r.amount,
        type: r.type,
        counterpartyName: r.counterpartyName,
        description: r.description,
      });
      const suggestedCategoryId = applyRules(rules, {
        description: r.description,
        counterpartyName: r.counterpartyName,
      });
      previewRows.push({
        rawIndex: r.rawIndex,
        date: r.date.toISOString(),
        amount: r.amount,
        type: r.type,
        description: r.description,
        counterpartyName: r.counterpartyName,
        resolvedCounterpartyId: r.counterpartyName
          ? cpByLcName.get(r.counterpartyName.trim().toLowerCase()) ?? null
          : null,
        suggestedCategoryId,
        importHash,
        isDuplicate: false,
        errors: r.errors,
        raw: r.raw,
      });
    }

    if (previewRows.length > 0) {
      const dupTxs = await this.prisma.transaction.findMany({
        where: {
          workspaceId: opts.workspaceId,
          importHash: { in: previewRows.map((r) => r.importHash) },
          deletedAt: null,
        },
        select: { importHash: true },
      });
      const dupSet = new Set(
        dupTxs.map((t) => t.importHash).filter((h): h is string => !!h),
      );
      for (const r of previewRows) {
        if (dupSet.has(r.importHash)) r.isDuplicate = true;
      }
    }

    return {
      source: parsed.source,
      headers: parsed.headers,
      suggestedMapping: parsed.suggestedMapping,
      encoding: parsed.encoding,
      filename: opts.filename,
      fileHash: this.computeFileHash(opts.buffer),
      rows: previewRows,
      stats: {
        total: parsed.rows.length,
        valid: previewRows.length,
        invalid: invalidCount,
        duplicates: previewRows.filter((r) => r.isDuplicate).length,
      },
    };
  }

  async commit(opts: {
    workspaceId: string;
    userId: string;
    body: CommitBody;
  }): Promise<CommitResult> {
    const { body, workspaceId, userId } = opts;

    const account = await this.prisma.account.findFirst({
      where: { id: body.accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const rowsToImport = body.skipDuplicates
      ? body.rows.filter((r) => !r.isDuplicate)
      : body.rows;
    const skipped = body.rows.length - rowsToImport.length;

    if (rowsToImport.length === 0) {
      throw new BadRequestException('Nothing to import — all rows are duplicates');
    }

    const namesNeeded = Array.from(
      new Set(
        rowsToImport
          .map((r) => r.counterpartyName?.trim())
          .filter((n): n is string => !!n),
      ),
    );
    const existing =
      namesNeeded.length > 0
        ? await this.prisma.counterparty.findMany({
            where: {
              workspaceId,
              deletedAt: null,
              name: {
                in: namesNeeded.map((n) => n.toLowerCase()),
                mode: 'insensitive',
              },
            },
            select: { id: true, name: true },
          })
        : [];
    const cpByLcName = new Map<string, string>();
    for (const cp of existing) cpByLcName.set(cp.name.toLowerCase(), cp.id);

    return this.prisma.$transaction(async (tx) => {
      for (const name of namesNeeded) {
        if (!cpByLcName.has(name.toLowerCase())) {
          const cp = await tx.counterparty.create({
            data: { workspaceId, name },
            select: { id: true, name: true },
          });
          cpByLcName.set(cp.name.toLowerCase(), cp.id);
        }
      }

      const batch = await tx.importBatch.create({
        data: {
          workspaceId,
          userId,
          source: body.source,
          filename: body.filename,
          fileHash: body.fileHash,
          rowsTotal: body.rows.length,
          rowsImported: rowsToImport.length,
          rowsSkipped: skipped,
        },
      });

      for (const r of rowsToImport) {
        await tx.transaction.create({
          data: {
            workspaceId,
            accountId: body.accountId,
            date: new Date(r.date),
            amount: r.amount,
            type: r.type,
            description: r.description,
            counterpartyId: r.counterpartyName
              ? cpByLcName.get(r.counterpartyName.trim().toLowerCase()) ?? null
              : null,
            categoryId: r.categoryId,
            importBatchId: batch.id,
            importHash: r.importHash,
            createdById: userId,
          },
        });
      }

      return {
        batchId: batch.id,
        imported: rowsToImport.length,
        skipped,
      };
    });
  }

  async rollback(opts: {
    workspaceId: string;
    batchId: string;
  }): Promise<RollbackResult> {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: opts.batchId, workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!batch) throw new NotFoundException('Import batch not found');

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.transaction.updateMany({
        where: {
          importBatchId: opts.batchId,
          workspaceId: opts.workspaceId,
          deletedAt: null,
        },
        data: { deletedAt: now },
      });
      await tx.importBatch.update({
        where: { id: opts.batchId },
        data: { deletedAt: now },
      });
      return { rolledBack: result.count };
    });
  }

  async listBatches(workspaceId: string) {
    return this.prisma.importBatch.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        source: true,
        filename: true,
        rowsTotal: true,
        rowsImported: true,
        rowsSkipped: true,
        createdAt: true,
        deletedAt: true,
        user: { select: { firstName: true, username: true } },
      },
    });
  }
}
