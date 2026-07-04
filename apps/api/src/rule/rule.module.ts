import { Module } from '@nestjs/common';
import { RuleController } from './rule.controller';
import { RuleService } from './rule.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [RuleController],
  providers: [RuleService, WorkspaceGuard],
  exports: [RuleService],
})
export class RuleModule {}
