import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
import { PlanningReminderService } from './planning-reminder.service';
import { ForecastService } from './forecast.service';
import { ReportsModule } from '../reports/reports.module';

// Ф5: регулярные и плановые платежи (регулярка/зарплата/разовые) — надстройка
// над транзакционной шиной, всё настраивается в приложении. PlanningReminderService
// — ежедневный крон-дайджест в Telegram (no-op без ALERT_TELEGRAM_CHAT_ID).
// ForecastService — прогноз остатка на горизонте (кассовый разрыв заранее);
// стартовый остаток берёт из BalanceService (ReportsModule).
@Module({
  imports: [ReportsModule],
  providers: [
    PlanningService,
    PlanningReminderService,
    ForecastService,
    TelegramAlertService,
    WorkspaceGuard,
  ],
  controllers: [PlanningController],
  exports: [PlanningService],
})
export class PlanningModule {}
