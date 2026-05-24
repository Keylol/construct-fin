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
import { CategoryRuleService } from './category-rule.service';
import {
  CreateCategoryRuleSchema,
  UpdateCategoryRuleSchema,
  ListCategoryRulesQuerySchema,
  type CreateCategoryRuleDto,
  type UpdateCategoryRuleDto,
  type ListCategoryRulesQuery,
} from './category-rule.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/category-rules')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class CategoryRuleController {
  constructor(private readonly service: CategoryRuleService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListCategoryRulesQuerySchema)) query: ListCategoryRulesQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateCategoryRuleSchema)) body: CreateCategoryRuleDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateCategoryRuleSchema)) body: UpdateCategoryRuleDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }
}
