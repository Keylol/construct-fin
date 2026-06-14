import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard, type WorkspaceContext } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { MarginService } from './margin.service';

@Controller('workspaces/:wsId/trade-reports')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class TradeReportsController {
  constructor(private readonly margin: MarginService) {}

  @Get('margin/by-product')
  async marginByProduct(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.margin.byProduct(ws.workspaceId);
  }

  @Get('margin/by-client')
  async marginByClient(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.margin.byClient(ws.workspaceId);
  }
}
