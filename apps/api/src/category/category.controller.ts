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
import { CategoryService } from './category.service';
import {
  CreateCategorySchema,
  UpdateCategorySchema,
  ListCategoriesQuerySchema,
  type CreateCategoryDto,
  type UpdateCategoryDto,
  type ListCategoriesQuery,
} from './category.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/categories')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListCategoriesQuerySchema)) query: ListCategoriesQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Get('tree')
  tree(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListCategoriesQuerySchema)) query: ListCategoriesQuery,
  ) {
    return this.service.tree(ws.workspaceId, query);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateCategorySchema)) body: CreateCategoryDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateCategorySchema)) body: UpdateCategoryDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }
}
