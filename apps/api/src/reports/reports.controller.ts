import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard, type WorkspaceContext } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import {
  BreakdownQuerySchema,
  CashflowQuerySchema,
  ExportFormatSchema,
  PnlQuerySchema,
  type BreakdownQuery,
  type CashflowQuery,
  type ExportFormat,
  type PnlQuery,
} from './reports.dto';
import { resolveComparison, resolvePeriod } from './period';
import { PnlService } from './pnl.service';
import { CashflowService } from './cashflow.service';
import { BreakdownService } from './breakdown.service';
import { renderReport } from './export';
import {
  breakdownToTable,
  cashflowToTable,
  pnlToTable,
} from './export/builders';

@Controller('workspaces/:wsId/reports')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class ReportsController {
  constructor(
    private readonly pnl: PnlService,
    private readonly cashflow: CashflowService,
    private readonly breakdown: BreakdownService,
  ) {}

  @Get('pnl')
  async getPnl(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(PnlQuerySchema)) q: PnlQuery,
  ) {
    const primary = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
    const comparison = resolveComparison(primary, {
      mode: q.compareWith,
      from: q.compareFrom,
      to: q.compareTo,
    });
    return this.pnl.build({
      workspaceId: ws.workspaceId,
      primary,
      comparison,
      groupBy: q.groupBy,
    });
  }

  @Get('cashflow')
  async getCashflow(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(CashflowQuerySchema)) q: CashflowQuery,
  ) {
    const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
    return this.cashflow.build({
      workspaceId: ws.workspaceId,
      period,
      accountId: q.accountId ?? null,
    });
  }

  @Get('by-category')
  async getByCategory(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(BreakdownQuerySchema)) q: BreakdownQuery,
  ) {
    const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
    return this.breakdown.byCategory({ workspaceId: ws.workspaceId, period, type: q.type });
  }

  @Get('by-counterparty')
  async getByCounterparty(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(BreakdownQuerySchema)) q: BreakdownQuery,
  ) {
    const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
    return this.breakdown.byCounterparty({ workspaceId: ws.workspaceId, period, type: q.type });
  }

  @Get(':kind/export')
  async export(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('kind') kind: string,
    @Query('format') formatRaw: string,
    @Query() rawQuery: Record<string, string>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const format: ExportFormat = ExportFormatSchema.parse(formatRaw);
    let table;
    if (kind === 'pnl') {
      const q = PnlQuerySchema.parse(rawQuery);
      const primary = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.pnl.build({
        workspaceId: ws.workspaceId,
        primary,
        comparison: null,
        groupBy: q.groupBy,
      });
      table = pnlToTable(report);
    } else if (kind === 'cashflow') {
      const q = CashflowQuerySchema.parse(rawQuery);
      const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.cashflow.build({
        workspaceId: ws.workspaceId,
        period,
        accountId: q.accountId ?? null,
      });
      table = cashflowToTable(report);
    } else if (kind === 'by-category') {
      const q = BreakdownQuerySchema.parse(rawQuery);
      const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.breakdown.byCategory({
        workspaceId: ws.workspaceId,
        period,
        type: q.type,
      });
      table = breakdownToTable(report, 'category');
    } else if (kind === 'by-counterparty') {
      const q = BreakdownQuerySchema.parse(rawQuery);
      const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.breakdown.byCounterparty({
        workspaceId: ws.workspaceId,
        period,
        type: q.type,
      });
      table = breakdownToTable(report, 'counterparty');
    } else {
      throw new BadRequestException(`Unknown report kind: ${kind}`);
    }

    const file = await renderReport(table, format);
    const safeTitle = table.title.toLowerCase().replace(/[^a-zа-я0-9]+/giu, '-').replace(/^-+|-+$/g, '');
    const filename = `${safeTitle}.${file.extension}`;
    reply.header('Content-Type', file.mimeType);
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    reply.header('Content-Length', file.buffer.length);
    return new StreamableFile(Readable.from(file.buffer));
  }
}
