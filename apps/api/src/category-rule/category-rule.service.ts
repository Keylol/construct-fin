import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCategoryRuleDto,
  UpdateCategoryRuleDto,
  ListCategoryRulesQuery,
} from './category-rule.dto';

@Injectable()
export class CategoryRuleService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string, query: ListCategoryRulesQuery) {
    return this.prisma.categoryRule.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ priority: 'desc' }, { keyword: 'asc' }],
      include: { category: { select: { id: true, name: true, kind: true } } },
      take: 500,
    });
  }

  async create(workspaceId: string, input: CreateCategoryRuleDto) {
    await this.assertCategoryBelongs(workspaceId, input.categoryId);
    return this.prisma.categoryRule.create({
      data: {
        workspaceId,
        keyword: input.keyword,
        categoryId: input.categoryId,
        priority: input.priority ?? 0,
        isActive: input.isActive ?? true,
      },
      include: { category: { select: { id: true, name: true, kind: true } } },
    });
  }

  async update(workspaceId: string, id: string, input: UpdateCategoryRuleDto) {
    const existing = await this.prisma.categoryRule.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('CategoryRule not found');
    if (input.categoryId) await this.assertCategoryBelongs(workspaceId, input.categoryId);
    return this.prisma.categoryRule.update({
      where: { id },
      data: {
        keyword: input.keyword ?? undefined,
        categoryId: input.categoryId ?? undefined,
        priority: input.priority ?? undefined,
        isActive: input.isActive ?? undefined,
      },
      include: { category: { select: { id: true, name: true, kind: true } } },
    });
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.categoryRule.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('CategoryRule not found');
    await this.prisma.categoryRule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async assertCategoryBelongs(workspaceId: string, categoryId: string) {
    const cat = await this.prisma.category.findFirst({
      where: { id: categoryId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!cat) throw new BadRequestException('Category does not belong to workspace');
  }
}
