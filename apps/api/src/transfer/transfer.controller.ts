import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { TransferService } from './transfer.service';
import { CreateTransferSchema, type CreateTransferDto } from './transfer.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId/transfers')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class TransferController {
  constructor(private readonly service: TransferService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.list(ws.workspaceId);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateTransferSchema)) body: CreateTransferDto,
  ) {
    return this.service.create(ws.workspaceId, ws.userId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.softDelete(ws.workspaceId, id);
  }
}
