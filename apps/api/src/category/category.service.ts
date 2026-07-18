import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CategoryBucket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  ListCategoriesQuery,
} from './category.dto';

export interface CategoryRow {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
  bucket: CategoryBucket;
  parentId: string | null;
  isFixedCost: boolean;
  isArchived: boolean;
}

// M13: допустимые bucket'ы по kind. Без этой проверки можно было завести
// kind=EXPENSE с bucket=REVENUE (расход попал бы в выручку P&L) или
// kind=INCOME с bucket=COGS — искажение отчётов. REVENUE — только доход;
// COGS/PURCHASES/FIXED/VARIABLE/TAX — только расход; CAPITAL/OTHER —
// нейтральны (вложения/изъятия и прочее встречаются в обоих видах).
const ALLOWED_BUCKETS: Record<'INCOME' | 'EXPENSE', ReadonlySet<CategoryBucket>> = {
  INCOME: new Set<CategoryBucket>(['REVENUE', 'CAPITAL', 'OTHER']),
  EXPENSE: new Set<CategoryBucket>([
    'COGS',
    'PURCHASES',
    'FIXED',
    'VARIABLE',
    'TAX',
    'CAPITAL',
    'OTHER',
  ]),
};

function assertBucketMatchesKind(
  kind: 'INCOME' | 'EXPENSE',
  bucket: CategoryBucket | undefined,
): void {
  if (bucket === undefined) return; // не задан → БД-дефолт OTHER (валиден для обоих)
  if (!ALLOWED_BUCKETS[kind].has(bucket)) {
    throw new BadRequestException(
      `Группа отчёта (bucket=${bucket}) недопустима для категории kind=${kind}`,
    );
  }
}

export interface CategoryTreeNode extends CategoryRow {
  children: CategoryTreeNode[];
}

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, query: ListCategoriesQuery): Promise<CategoryRow[]> {
    return this.prisma.category.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, kind: true, bucket: true, parentId: true, isFixedCost: true, isArchived: true },
    });
  }

  async tree(workspaceId: string, query: ListCategoriesQuery): Promise<CategoryTreeNode[]> {
    const flat = await this.list(workspaceId, query);
    const byId = new Map<string, CategoryTreeNode>();
    for (const c of flat) byId.set(c.id, { ...c, children: [] });
    const roots: CategoryTreeNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId) {
        const parent = byId.get(node.parentId);
        if (parent) parent.children.push(node);
        else roots.push(node); // parent выкинут фильтрами — оставляем как root
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async create(workspaceId: string, input: CreateCategoryDto): Promise<CategoryRow> {
    if (input.parentId) {
      // ограничение: ровно 2 уровня. parent должен быть корнем.
      const parent = await this.prisma.category.findFirst({
        where: { id: input.parentId, workspaceId, deletedAt: null },
        select: { kind: true, parentId: true },
      });
      if (!parent) throw new BadRequestException('Parent category not found');
      if (parent.parentId !== null) {
        throw new BadRequestException('Категории поддерживают только 2 уровня');
      }
      if (parent.kind !== input.kind) {
        throw new BadRequestException('Подкатегория должна совпадать по kind с родителем');
      }
    }
    assertBucketMatchesKind(input.kind, input.bucket); // M13
    const created = await this.prisma.category.create({
      data: {
        workspaceId,
        name: input.name,
        kind: input.kind,
        bucket: input.bucket ?? undefined, // undefined → БД-дефолт OTHER
        parentId: input.parentId ?? null,
        isFixedCost: input.isFixedCost ?? false,
      },
      select: { id: true, name: true, kind: true, bucket: true, parentId: true, isFixedCost: true, isArchived: true },
    });
    return created;
  }

  async update(workspaceId: string, id: string, input: UpdateCategoryDto): Promise<CategoryRow> {
    const existing = await this.prisma.category.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Category not found');

    if (input.parentId !== undefined && input.parentId !== existing.parentId) {
      if (input.parentId === id) throw new BadRequestException('Категория не может быть родителем самой себя');
      if (input.parentId !== null) {
        const parent = await this.prisma.category.findFirst({
          where: { id: input.parentId, workspaceId, deletedAt: null },
          select: { kind: true, parentId: true },
        });
        if (!parent) throw new BadRequestException('Parent category not found');
        if (parent.parentId !== null) throw new BadRequestException('Категории поддерживают только 2 уровня');
        if (parent.kind !== existing.kind)
          throw new BadRequestException('Тип (доход/расход) родителя должен совпадать');
        // нельзя сделать родителем категорию, у которой есть свои дети
        const hasChildren = await this.prisma.category.count({
          where: { workspaceId, parentId: id, deletedAt: null },
        });
        if (hasChildren > 0) throw new BadRequestException('У категории есть подкатегории — нельзя сделать её дочерней');
      }
    }

    // M13: kind у категории неизменяем (нет в UpdateCategoryDto) — сверяем новый
    // bucket с уже сохранённым kind.
    assertBucketMatchesKind(existing.kind, input.bucket);

    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        bucket: input.bucket ?? undefined,
        parentId: input.parentId === undefined ? undefined : input.parentId,
        isFixedCost: input.isFixedCost ?? undefined,
        isArchived: input.isArchived ?? undefined,
      },
      select: { id: true, name: true, kind: true, bucket: true, parentId: true, isFixedCost: true, isArchived: true },
    });
    return updated;
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.category.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Category not found');
    const hasChildren = await this.prisma.category.count({
      where: { workspaceId, parentId: id, deletedAt: null },
    });
    if (hasChildren > 0) {
      throw new BadRequestException(
        'Нельзя удалить категорию с активными подкатегориями. Сначала удалите или перенесите дочерние.',
      );
    }
    await this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
