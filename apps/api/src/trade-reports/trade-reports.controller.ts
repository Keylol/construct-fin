import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard, type WorkspaceContext } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { MarginService } from './margin.service';
import { ReceivablesService } from './receivables.service';
import {
  MarginQuerySchema,
  type MarginQuery,
  ReceivablesQuerySchema,
  type ReceivablesQuery,
} from './trade-reports.dto';
import { resolvePeriod, type Period } from '../reports/period';

/** Период из query маржи — только если задан preset либо обе границы (иначе вся история). */
function marginPeriod(q: MarginQuery): Period | undefined {
  if (q.preset || (q.from && q.to)) return resolvePeriod(q);
  return undefined;
}

@Controller('workspaces/:wsId/trade-reports')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class TradeReportsController {
  constructor(
    private readonly margin: MarginService,
    private readonly receivables: ReceivablesService,
  ) {}

  @Get('margin/by-product')
  async marginByProduct(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(MarginQuerySchema)) q: MarginQuery,
  ) {
    return this.margin.byProduct(ws.workspaceId, marginPeriod(q));
  }

  @Get('margin/by-client')
  async marginByClient(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(MarginQuerySchema)) q: MarginQuery,
  ) {
    return this.margin.byClient(ws.workspaceId, marginPeriod(q));
  }

  @Get('receivables')
  async getReceivables(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ReceivablesQuerySchema)) q: ReceivablesQuery,
  ) {
    const asOf = q.asOf ? new Date(q.asOf) : new Date();
    return this.receivables.build(ws.workspaceId, asOf);
  }
}
