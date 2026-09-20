import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../integrations/crypto.service';
import { AuditService } from '../audit/audit.service';
import { AmoApiError, AmoClient } from './amo.client';
import type { PipelineSnapshot } from './amo-map';
import type { CreateCrmConnectionDto, UpdateCrmConnectionDto } from './crm.dto';

/** Публичная форма подключения — БЕЗ credentialEnc (секрет наружу не уходит). */
const PUBLIC_SELECT = {
  id: true,
  provider: true,
  subdomain: true,
  keyLast4: true,
  accountName: true,
  pipelineId: true,
  waitingStatusIds: true,
  pipelines: true,
  status: true,
  lastSyncAt: true,
  lastSyncError: true,
  createdAt: true,
} satisfies Prisma.CrmConnectionSelect;

type PublicRow = Prisma.CrmConnectionGetPayload<{ select: typeof PUBLIC_SELECT }>;

export type CrmConnectionPublic = ReturnType<CrmConnectionService['serialize']>;

/**
 * Подключение amoCRM пространства: одно на пространство, токен зашифрован
 * мастер-ключом интеграций (тем же, что у банков), настройки — воронка и
 * этап-порог. Только владелец (OwnerGuard на контроллере).
 */
@Injectable()
export class CrmConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly amo: AmoClient,
    private readonly audit: AuditService,
  ) {}

  async get(workspaceId: string): Promise<CrmConnectionPublic | null> {
    const row = await this.prisma.crmConnection.findFirst({
      where: { workspaceId, deletedAt: null },
      select: PUBLIC_SELECT,
    });
    return row ? this.serialize(row) : null;
  }

  async create(workspaceId: string, userId: string, dto: CreateCrmConnectionDto) {
    const existing = await this.prisma.crmConnection.findFirst({
      where: { workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'amoCRM уже подключён — замените токен в настройках или удалите подключение',
      );
    }
    // Токен проверяем до записи: владелец сразу узнаёт, что скопировал не то,
    // а не через 10 минут по статусу «Ошибка» у крона.
    const account = await this.verify(dto.subdomain, dto.token);
    // encrypt бросит 503, если INTEGRATION_MASTER_KEY не задан — фича выключена.
    const credentialEnc = this.crypto.encrypt(dto.token);
    const pipelines = await this.safePipelines(dto.subdomain, dto.token);
    const created = await this.prisma.crmConnection.create({
      data: {
        workspaceId,
        subdomain: dto.subdomain,
        credentialEnc,
        keyLast4: CryptoService.mask(dto.token),
        accountName: account.name,
        pipelineId: dto.pipelineId ?? null,
        waitingStatusIds: dto.waitingStatusIds ?? [],
        pipelines: pipelines ? (pipelines as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        createdById: userId,
      },
      select: PUBLIC_SELECT,
    });
    // Аудит: значение токена НЕ пишем — только поддомен и маска.
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.connect',
      entityType: 'CrmConnection',
      entityId: created.id,
      diff: { subdomain: dto.subdomain, keyLast4: created.keyLast4, accountName: account.name },
    });
    return this.serialize(created);
  }

  async update(workspaceId: string, userId: string, dto: UpdateCrmConnectionDto) {
    const existing = await this.assertOwned(workspaceId);
    const data: Prisma.CrmConnectionUpdateInput = {};
    const diff: Record<string, unknown> = {};
    let action: 'crm.token-rotate' | 'crm.settings' | 'crm.disable' = 'crm.settings';

    if (dto.token !== undefined) {
      const account = await this.verify(existing.subdomain, dto.token);
      data.credentialEnc = this.crypto.encrypt(dto.token);
      data.keyLast4 = CryptoService.mask(dto.token);
      data.accountName = account.name;
      // Новый токен снимает ошибку прошлого: синк пойдёт заново.
      data.status = 'ACTIVE';
      data.lastSyncError = null;
      diff.keyLast4 = data.keyLast4;
      action = 'crm.token-rotate';
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === 'ACTIVE') data.lastSyncError = null;
      diff.status = dto.status;
      if (dto.status === 'DISABLED') action = 'crm.disable';
    }
    if (dto.pipelineId !== undefined) {
      data.pipelineId = dto.pipelineId;
      diff.pipelineId = dto.pipelineId;
    }
    if (dto.waitingStatusIds !== undefined) {
      data.waitingStatusIds = dto.waitingStatusIds;
      diff.waitingStatusIds = dto.waitingStatusIds;
    }
    const updated = await this.prisma.crmConnection.update({
      where: { id: existing.id },
      data,
      select: PUBLIC_SELECT,
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action,
      entityType: 'CrmConnection',
      entityId: existing.id,
      diff: diff as Prisma.InputJsonValue,
    });
    return this.serialize(updated);
  }

  async softDelete(workspaceId: string, userId: string): Promise<void> {
    const existing = await this.assertOwned(workspaceId);
    await this.prisma.crmConnection.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: 'DISABLED' },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'crm.delete',
      entityType: 'CrmConnection',
      entityId: existing.id,
      diff: { subdomain: existing.subdomain },
    });
  }

  /** Живой список воронок из amo — для окна настроек, когда снимка ещё нет. */
  async livePipelines(workspaceId: string): Promise<PipelineSnapshot[]> {
    const existing = await this.assertOwned(workspaceId);
    const token = this.crypto.decrypt(existing.credentialEnc);
    try {
      const pipelines = await this.amo.pipelines({ subdomain: existing.subdomain, token });
      await this.prisma.crmConnection.update({
        where: { id: existing.id },
        data: { pipelines: pipelines as unknown as Prisma.InputJsonValue },
      });
      return pipelines;
    } catch (e) {
      throw new BadRequestException(
        e instanceof AmoApiError ? e.message : 'Не удалось получить воронки из amoCRM',
      );
    }
  }

  /** Подключение пространства с секретом — для синка. */
  async assertOwned(workspaceId: string) {
    const row = await this.prisma.crmConnection.findFirst({
      where: { workspaceId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('amoCRM не подключён');
    return row;
  }

  private async verify(subdomain: string, token: string) {
    try {
      return await this.amo.account({ subdomain, token });
    } catch (e) {
      throw new BadRequestException(
        e instanceof AmoApiError ? e.message : 'Не удалось проверить токен в amoCRM',
      );
    }
  }

  private async safePipelines(
    subdomain: string,
    token: string,
  ): Promise<PipelineSnapshot[] | null> {
    try {
      return await this.amo.pipelines({ subdomain, token });
    } catch {
      // Воронки подтянет первый синк; подключение из-за них не откладываем.
      return null;
    }
  }

  private serialize(r: PublicRow) {
    return {
      id: r.id,
      provider: r.provider,
      subdomain: r.subdomain,
      url: `https://${r.subdomain}.amocrm.ru`,
      keyLast4: r.keyLast4,
      accountName: r.accountName,
      pipelineId: r.pipelineId,
      waitingStatusIds: r.waitingStatusIds,
      pipelines: (r.pipelines as unknown as PipelineSnapshot[] | null) ?? [],
      status: r.status,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      lastSyncError: r.lastSyncError,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
