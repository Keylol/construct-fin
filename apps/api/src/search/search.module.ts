import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, WorkspaceGuard],
})
export class SearchModule {}
