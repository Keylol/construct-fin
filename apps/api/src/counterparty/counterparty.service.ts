import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCounterpartyDto,
  UpdateCounterpartyDto,
  ListCounterpartiesQuery,
} from './counterparty.dto';

@Injectable()
export class CounterpartyService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string, query: ListCounterpartiesQuery) {
    return this.prisma.counterparty.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.includeArchived ? {} : { isArchived: false }),
        ...(query.role ? { role: query.role } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { contact: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: 200,
    });
  }

  create(workspaceId: string, input: CreateCounterpartyDto) {
    return this.prisma.counterparty.create({
      data: {
        workspaceId,
        name: input.name,
        role: input.role ?? 'OTHER',
        contact: input.contact ?? null,
        note: input.note ?? null,
        inn: input.inn ?? null,
        source: input.source ?? null,
        position: input.position ?? null,
        payRate: input.payRate != null ? new Prisma.Decimal(input.payRate) : null,
      },
    });
  }

  async update(workspaceId: string, id: string, input: UpdateCounterpartyDto) {
    const existing = await this.prisma.counterparty.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Counterparty not found');
    return this.prisma.counterparty.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        role: input.role ?? undefined,
        contact: input.contact === undefined ? undefined : input.contact,
        note: input.note === undefined ? undefined : input.note,
        inn: input.inn === undefined ? undefined : input.inn,
        source: input.source === undefined ? undefined : input.source,
        position: input.position === undefined ? undefined : input.position,
        payRate:
          input.payRate === undefined
            ? undefined
            : input.payRate === null
              ? null
              : new Prisma.Decimal(input.payRate),
        isArchived: input.isArchived ?? undefined,
      },
    });
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.counterparty.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Counterparty not found');
    await this.prisma.counterparty.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
