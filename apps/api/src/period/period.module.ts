import { Module, Global } from '@nestjs/common';
import { PeriodController } from './period.controller';
import { PeriodService } from './period.service';
import { WorkspaceGuard } from '../common/workspace.guard';

/**
 * Global — чтобы PeriodService можно было инжектить в любые сервисы
 * (Transaction/Order/Purchase) без явного импорта PeriodModule.
 */
@Global()
@Module({
  controllers: [PeriodController],
  providers: [PeriodService, WorkspaceGuard],
  exports: [PeriodService],
})
export class PeriodModule {}
