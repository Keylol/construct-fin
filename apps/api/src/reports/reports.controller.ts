import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';
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
import {
  TaxAusnBodySchema,
  TaxPayBodySchema,
  TaxYearQuerySchema,
  type TaxAusnBody,
  type TaxPayBody,
  type TaxYearQuery,
} from './tax.dto';
import { resolveComparison, resolvePeriod } from './period';
import { PnlService } from './pnl.service';
import { CashflowService } from './cashflow.service';
import { BreakdownService } from './breakdown.service';
import { TaxService } from './tax.service';
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
    private readonly tax: TaxService,
  ) {}

  // ── Ф4: Налог АУСН Д−Р ──
  @Get('tax')
  getTax(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(TaxYearQuerySchema)) q: TaxYearQuery,
  ) {
    return this.tax.yearReport(ws.workspaceId, q.year);
  }

  @Post('tax/pay')
  payTax(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(TaxPayBodySchema)) body: TaxPayBody,
  ) {
    return this.tax.markPaid(ws.workspaceId, user.sub, body);
  }

  @Post('tax/ausn')
  setAusn(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(TaxAusnBodySchema)) body: TaxAusnBody,
  ) {
    return this.tax.setAusnMark(ws.workspaceId, body.transactionId, body.ausnMark);
  }

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
      preset: q.preset, // M1: календарный prev для пресетов this-month/quarter/year
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
      mode: q.mode,
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
    // `format` — чисто экспортный query-параметр, его нет в схемах отчётов.
    // Схемы объявлены .strict() (защита обычных эндпоинтов от опечаток в
    // параметрах), поэтому передавать его в .parse() нельзя — иначе Zod бросит
    // unrecognized_keys и экспорт ломается. Вырезаем точечно на пути экспорта,
    // strict со схем НЕ снимаем.
    const { format: _format, ...query } = rawQuery;
    let table;
    if (kind === 'pnl') {
      const q = PnlQuerySchema.parse(query);
      const primary = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.pnl.build({
        workspaceId: ws.workspaceId,
        primary,
        comparison: null,
        groupBy: q.groupBy,
      });
      table = pnlToTable(report);
    } else if (kind === 'cashflow') {
      const q = CashflowQuerySchema.parse(query);
      const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.cashflow.build({
        workspaceId: ws.workspaceId,
        period,
        accountId: q.accountId ?? null,
        mode: q.mode,
      });
      table = cashflowToTable(report);
    } else if (kind === 'by-category') {
      const q = BreakdownQuerySchema.parse(query);
      const period = resolvePeriod({ preset: q.preset, from: q.from, to: q.to });
      const report = await this.breakdown.byCategory({
        workspaceId: ws.workspaceId,
        period,
        type: q.type,
      });
      table = breakdownToTable(report, 'category');
    } else if (kind === 'by-counterparty') {
      const q = BreakdownQuerySchema.parse(query);
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
