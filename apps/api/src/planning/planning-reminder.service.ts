import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { PlanningService } from './planning.service';
import { buildPlanningDigest } from './planning-reminder';

/**
 * Ф5-D. Ежедневное напоминание о платежах. Крон в 04:00 UTC = 09:00 бизнес-часа
 * (UTC+5): по каждому пространству материализует регулярку (план держится
 * заполненным даже без открытия экрана) и, если есть просроченные/горящие
 * позиции, шлёт дайджест владельцу в Telegram.
 *
 * TG-канал включается только при заданном `ALERT_TELEGRAM_CHAT_ID` (решение
 * блица «логика + в аппе сейчас, TG потом»): без chat id — no-op, но
 * материализация и in-app бейдж/список работают в любом случае.
 */
@Injectable()
export class PlanningReminderService {
  private readonly logger = new Logger(PlanningReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planning: PlanningService,
    private readonly telegram: TelegramAlertService,
  ) {}

  @Cron('0 4 * * *')
  async runDailyReminders(): Promise<void> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
    });

    let notifiedWorkspaces = 0;
    let tgDelivered = false;

    for (const ws of workspaces) {
      // Падение одного пространства не должно останавливать остальные.
      try {
        // upcoming() сам материализует регулярку на горизонт (≥45 дн).
        const up = await this.planning.upcoming(ws.id, 14);
        const digest = buildPlanningDigest(ws.name, up.items);
        if (!digest) continue;
        notifiedWorkspaces++;
        const sent = await this.telegram.notify(digest);
        if (sent) tgDelivered = true;
      } catch (e) {
        this.logger.error(
          `Напоминание о платежах для ${ws.id} упало: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (notifiedWorkspaces > 0 && !tgDelivered) {
      // Есть что напомнить, но TG-канал выключен — фиксируем в лог (in-app бейдж
      // всё равно показывает «горящее»). Включится, когда владелец даст chat id.
      this.logger.log(
        `Платежи требуют внимания в ${notifiedWorkspaces} простр.; TG выключен (нет ALERT_TELEGRAM_CHAT_ID)`,
      );
    }
  }
}
