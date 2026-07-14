import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { SyncService, type SyncResult } from './sync.service';
import type { CreateIntegrationDto, UpdateIntegrationDto } from './integrations.dto';

/**
 * CRUD банковских подключений + ручной запуск синка (Ф1-C). Секрет
 * (токен) наружу никогда не отдаётся — только маска keyLast4. Доступ
 * гейтится OwnerGuard на контроллере (только владелец пространства).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly sync: SyncService,
  ) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { workspaceId, deletedAt: null },
      include: { account: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async create(workspaceId: string, userId: string, dto: CreateIntegrationDto) {
    await this.assertAccount(workspaceId, dto.accountId);
    // encrypt бросит 503, если INTEGRATION_MASTER_KEY не задан — фича выключена.
    const credentialEnc = this.crypto.encrypt(dto.token);
    const created = await this.prisma.integrationConnection.create({
      data: {
        workspaceId,
        provider: dto.provider,
        accountId: dto.accountId,
        credentialEnc,
        keyLast4: CryptoService.mask(dto.token),
        createdById: userId,
      },
      include: { account: { select: { id: true, name: true } } },
    });
    return this.serialize(created);
  }

  async update(workspaceId: string, id: string, dto: UpdateIntegrationDto) {
    await this.assertOwned(workspaceId, id);
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: {
        ...(dto.token
          ? {
              credentialEnc: this.crypto.encrypt(dto.token),
              keyLast4: CryptoService.mask(dto.token),
              // Ротация токена сбрасывает прошлую ошибку — даём синку шанс.
              status: 'ACTIVE',
              lastSyncError: null,
            }
          : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      include: { account: { select: { id: true, name: true } } },
    });
    return this.serialize(updated);
  }

  async softDelete(workspaceId: string, id: string) {
    await this.assertOwned(workspaceId, id);
    await this.prisma.integrationConnection.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'DISABLED' },
    });
  }

  /** Ручной синк «обновить сейчас» (решение №12). */
  async syncNow(workspaceId: string, id: string): Promise<SyncResult> {
    await this.assertOwned(workspaceId, id);
    return this.sync.syncConnection(id);
  }

  private async assertAccount(workspaceId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new BadRequestException('Счёт не найден в этом пространстве');
  }

  private async assertOwned(workspaceId: string, id: string) {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!conn) throw new NotFoundException('Подключение не найдено');
  }

  /** Публичная форма — БЕЗ credentialEnc (секрет наружу не уходит). */
  private serialize(r: {
    id: string;
    provider: string;
    status: string;
    keyLast4: string;
    syncCursor: string | null;
    lastSyncAt: Date | null;
    lastSyncError: string | null;
    createdAt: Date;
    account: { id: string; name: string };
  }) {
    return {
      id: r.id,
      provider: r.provider,
      status: r.status,
      keyLast4: r.keyLast4,
      account: r.account,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      lastSyncError: r.lastSyncError,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
