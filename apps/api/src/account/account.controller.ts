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
import { AccountService } from './account.service';
import {
  CreateAccountSchema,
  UpdateAccountSchema,
  ListAccountsQuerySchema,
  type CreateAccountDto,
  type UpdateAccountDto,
  type ListAccountsQuery,
} from './account.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/accounts')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class AccountController {
  constructor(private readonly service: AccountService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListAccountsQuerySchema)) query: ListAccountsQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  /** Остатки по счетам: по учёту / по банку / не разобрано / расхождение. */
  @Get('balances')
  balances(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.balances(ws.workspaceId);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateAccountSchema)) body: CreateAccountDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateAccountSchema)) body: UpdateAccountDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }
}
