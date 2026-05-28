import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { AuditService } from './audit.service';
import type { WorkspaceContext } from '../common/workspace.guard';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

@Controller('workspaces/:wsId/audit')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListQuerySchema)) query: ListQuery,
  ) {
    return this.service.list(ws.workspaceId, query.limit, query.cursor);
  }
}
