import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TxClient } from '../common/unit-of-work';

@Injectable()
export class WarehouseRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: TxClient): TxClient | PrismaService {
    return tx ?? this.prisma;
  }

  list(workspaceId: string, opts: { search?: string; includeArchived?: boolean }) {
    return this.prisma.warehouseItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(opts.includeArchived ? {} : { isArchived: false }),
        ...(opts.search
          ? {
              OR: [
                { name: { contains: opts.search, mode: 'insensitive' } },
                { sku: { contains: opts.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: 300,
    });
  }

  findById(workspaceId: string, id: string, tx?: TxClient) {
    return this.db(tx).warehouseItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
  }

  create(data: Prisma.WarehouseItemCreateInput, tx?: TxClient) {
    return this.db(tx).warehouseItem.create({ data });
  }

  update(id: string, data: Prisma.WarehouseItemUpdateInput, tx?: TxClient) {
    return this.db(tx).warehouseItem.update({ where: { id }, data });
  }

  softDelete(id: string, tx?: TxClient) {
    return this.db(tx).warehouseItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
