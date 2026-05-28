import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, WorkspaceGuard],
  exports: [AuditService],
})
export class AuditModule {}
