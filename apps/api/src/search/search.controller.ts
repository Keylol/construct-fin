import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import type { WorkspaceContext } from '../common/workspace.guard';
import { SearchService } from './search.service';
import { GlobalSearchQuerySchema, type GlobalSearchQuery } from './search.dto';

/**
 * Общий поиск: «Поиск ⌘K» и поле на Главной находят записи во всех разделах
 * сразу — заказ, клиента, операцию, строку выписки, закупку, товар.
 */
@Controller('workspaces/:wsId/search')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  search(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(GlobalSearchQuerySchema)) query: GlobalSearchQuery,
  ) {
    return this.service.search(ws, query);
  }
}
