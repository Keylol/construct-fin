import { Module } from '@nestjs/common';
import { CategoryRuleController } from './category-rule.controller';
import { CategoryRuleService } from './category-rule.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [CategoryRuleController],
  providers: [CategoryRuleService, WorkspaceGuard],
  exports: [CategoryRuleService],
})
export class CategoryRuleModule {}
