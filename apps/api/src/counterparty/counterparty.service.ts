import { Injectable, NotFoundException } from '@nestjs/common';
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
        contact: input.contact ?? null,
        note: input.note ?? null,
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
        contact: input.contact === undefined ? undefined : input.contact,
        note: input.note === undefined ? undefined : input.note,
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
