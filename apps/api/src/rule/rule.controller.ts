import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { RuleService } from './rule.service';
import {
  CreateRuleSchema,
  UpdateRuleSchema,
  SuggestSchema,
  PreviewRuleSchema,
  type CreateRuleDto,
  type UpdateRuleDto,
  type SuggestDto,
  type PreviewRuleDto,
} from './rule.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/rules')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class RuleController {
  constructor(private readonly service: RuleService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.list(ws.workspaceId);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateRuleSchema)) body: CreateRuleDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  /** Подсказки для формы/импорта — движок только предлагает, деньги не двигает. */
  @Post('suggest')
  @HttpCode(200)
  suggest(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(SuggestSchema)) body: SuggestDto,
  ) {
    return this.service.suggest(ws.workspaceId, body);
  }

  /** «Зацепит N строк из M, вот примеры» — до сохранения правила. */
  @Post('preview')
  @HttpCode(200)
  preview(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(PreviewRuleSchema)) body: PreviewRuleDto,
  ) {
    return this.service.preview(ws.workspaceId, body.conditions);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateRuleSchema)) body: UpdateRuleDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }
}
