import { Module } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  controllers: [AttachmentController],
  providers: [AttachmentService, WorkspaceGuard],
})
export class AttachmentModule {}
