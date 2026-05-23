import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateAccountDto,
  UpdateAccountDto,
  ListAccountsQuery,
} from './account.dto';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, query: ListAccountsQuery) {
    const items = await this.prisma.account.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
    });
    return items.map(this.serialize);
  }

  async create(workspaceId: string, input: CreateAccountDto) {
    const created = await this.prisma.account.create({
      data: {
        workspaceId,
        name: input.name,
        type: input.type,
        openingBalance: new Prisma.Decimal(input.openingBalance),
        note: input.note ?? null,
      },
    });
    return this.serialize(created);
  }

  async update(workspaceId: string, id: string, input: UpdateAccountDto) {
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Account not found');
    const updated = await this.prisma.account.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        type: input.type ?? undefined,
        openingBalance:
          input.openingBalance !== undefined ? new Prisma.Decimal(input.openingBalance) : undefined,
        note: input.note === undefined ? undefined : input.note,
        isArchived: input.isArchived ?? undefined,
      },
    });
    return this.serialize(updated);
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Account not found');
    await this.prisma.account.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private serialize(a: {
    id: string;
    name: string;
    type: 'CASH' | 'BANK' | 'CARD' | 'OTHER';
    openingBalance: Prisma.Decimal;
    note: string | null;
    isArchived: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      openingBalance: a.openingBalance.toFixed(2),
      note: a.note,
      isArchived: a.isArchived,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
}
