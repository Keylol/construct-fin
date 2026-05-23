import { Module } from '@nestjs/common';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [CategoryController],
  providers: [CategoryService, WorkspaceGuard],
})
export class CategoryModule {}
