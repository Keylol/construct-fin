import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../integrations/crypto.service';
import { sanitizeSecrets } from '../common/sanitize-secrets';
import { AmoClient, AMO_PAGE_LIMIT, type AmoCredentials } from './amo.client';
import { mapLead, statusIndex } from './amo-map';
import { resolveTriggerSort } from './crm-connection.service';

/**
 * Первый синк тянет сделки, изменённые за этот срок. Открытые сделки живут
 * недолго (недели), закрытые старше полугода учёту не нужны — их заказы давно
 * заведены руками.
 */
const FIRST_SYNC_DAYS = 180;
/** Перекрытие курсора: сделка, обновлённая в ту же секунду, не должна потеряться. */
const CURSOR_OVERLAP_MS = 60_000;
/** Предохранитель от бесконечного листания: 40 × 250 = 10 000 сделок за проход. */
const MAX_PAGES = 40;

export interface CrmSyncResult {
  fetched: number;
  created: number;
  updated: number;
}

/**
 * Опрос amoCRM: раз в 10 минут (решение владельца 20.09.2026) и по кнопке
 * «Обновить». Тянем сделки по updated_at, кладём снимок в CrmDeal. Поля,
 * которые принадлежат учёту (orderId, linkedAt, dismissedAt), синк не трогает.
 */
@Injectable()
export class CrmSyncService {
  private readonly logger = new Logger(CrmSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly amo: AmoClient,
  ) {}

  @Cron('*/10 * * * *')
  async syncAllActive(): Promise<void> {
    const connections = await this.prisma.crmConnection.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    for (const c of connections) {
      // Падение одного подключения не должно останавливать остальные.
      try {
        await this.syncConnection(c.id);
      } catch (e) {
        this.logger.error(
          `Плановый синк amoCRM ${c.id} упал: ${sanitizeSecrets(e instanceof Error ? e.message : String(e))}`,
        );
      }
    }
  }

  async syncConnection(connectionId: string): Promise<CrmSyncResult> {
    const conn = await this.prisma.crmConnection.findFirst({
      where: { id: connectionId, deletedAt: null },
    });
    if (!conn) throw new NotFoundException('amoCRM не подключён');
    if (conn.status === 'DISABLED') return { fetched: 0, created: 0, updated: 0 };

    const cred: AmoCredentials = {
      subdomain: conn.subdomain,
      token: this.crypto.decrypt(conn.credentialEnc),
    };
    const result: CrmSyncResult = { fetched: 0, created: 0, updated: 0 };
    try {
      const pipelines = await this.amo.pipelines(cred);
      const statuses = statusIndex(pipelines);
      const users = await this.amo.users(cred);
      const since = conn.syncCursor
        ? new Date(conn.syncCursor.getTime() - CURSOR_OVERLAP_MS)
        : new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000);
      let maxUpdated: Date | null = conn.syncCursor;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const leads = await this.amo.leadsPage(cred, { since, page });
        if (leads.length === 0) break;
        result.fetched += leads.length;

        const contactIds = leads
          .map(
            (l) =>
              l._embedded?.contacts?.find((c) => c.is_main)?.id ?? l._embedded?.contacts?.[0]?.id,
          )
          .filter((id): id is number => id != null);
        const contacts = await this.amo.contactsByIds(cred, contactIds);

        const known = new Set(
          (
            await this.prisma.crmDeal.findMany({
              where: { connectionId: conn.id, externalId: { in: leads.map((l) => l.id) } },
              select: { externalId: true },
            })
          ).map((d) => d.externalId),
        );

        for (const lead of leads) {
          const mapped = mapLead(lead, statuses, contacts, users);
          const data = { ...mapped, price: new Prisma.Decimal(mapped.price) };
          await this.prisma.crmDeal.upsert({
            where: { connectionId_externalId: { connectionId: conn.id, externalId: lead.id } },
            create: { ...data, workspaceId: conn.workspaceId, connectionId: conn.id },
            update: data,
          });
          if (known.has(lead.id)) result.updated += 1;
          else result.created += 1;
          if (!maxUpdated || mapped.remoteUpdatedAt > maxUpdated)
            maxUpdated = mapped.remoteUpdatedAt;
        }
        if (leads.length < AMO_PAGE_LIMIT) break;
      }

      await this.prisma.crmConnection.update({
        where: { id: conn.id },
        data: {
          syncCursor: maxUpdated,
          lastSyncAt: new Date(),
          lastSyncError: null,
          status: 'ACTIVE',
          pipelines: pipelines as unknown as Prisma.InputJsonValue,
          triggerStatusSort: resolveTriggerSort(pipelines, conn.triggerStatusId),
        },
      });
      return result;
    } catch (e) {
      const message = sanitizeSecrets(e instanceof Error ? e.message : String(e));
      await this.prisma.crmConnection.update({
        where: { id: conn.id },
        data: { status: 'ERROR', lastSyncError: message },
      });
      throw e;
    }
  }
}
