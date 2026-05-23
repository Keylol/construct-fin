import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { CounterpartyService } from './counterparty.service';
import {
  CreateCounterpartySchema,
  UpdateCounterpartySchema,
  ListCounterpartiesQuerySchema,
  type CreateCounterpartyDto,
  type UpdateCounterpartyDto,
  type ListCounterpartiesQuery,
} from './counterparty.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/counterparties')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class CounterpartyController {
  constructor(private readonly service: CounterpartyService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListCounterpartiesQuerySchema)) query: ListCounterpartiesQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateCounterpartySchema)) body: CreateCounterpartyDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateCounterpartySchema)) body: UpdateCounterpartyDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }
}
