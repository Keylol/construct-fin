import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { WbReceiptService } from './wb-receipt.service';
import {
  CommitWbReceiptSchema,
  WbPreviewQuerySchema,
  type CommitWbReceiptDto,
  type WbPreviewQuery,
} from './wb-receipt.dto';
import type { JwtPayload } from '../auth/auth.service';
import type { WorkspaceContext } from '../common/workspace.guard';

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

// Разбор доступен оператору (не только владельцу) — плоская модель доступа,
// как импорт/Inbox: секретов здесь нет, только учётные действия.
@Controller('workspaces/:wsId/wb-receipts')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class WbReceiptController {
  constructor(private readonly service: WbReceiptService) {}

  @Post('preview')
  async preview(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(WbPreviewQuerySchema)) query: WbPreviewQuery,
    @Req() req: FastifyRequest,
  ) {
    const reqAny = req as FastifyRequest & {
      isMultipart?: () => boolean;
      file?: () => Promise<unknown>;
    };
    if (!reqAny.isMultipart?.()) {
      throw new BadRequestException('Request must be multipart/form-data');
    }
    const part = (await reqAny.file?.()) as
      | { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }
      | undefined;
    if (!part) throw new BadRequestException('No file in request');

    const buffer = await part.toBuffer();
    if (buffer.byteLength === 0) throw new BadRequestException('Empty file');
    if (buffer.byteLength > MAX_RECEIPT_BYTES) {
      throw new BadRequestException(
        `File too large: ${buffer.byteLength} bytes (max ${MAX_RECEIPT_BYTES})`,
      );
    }

    return this.service.preview({
      workspaceId: ws.workspaceId,
      accountId: query.accountId,
      buffer,
    });
  }

  @Post()
  commit(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CommitWbReceiptSchema)) body: CommitWbReceiptDto,
  ) {
    return this.service.commit(ws.workspaceId, user.sub, body);
  }

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.list(ws.workspaceId);
  }

  /** Откат разбора целиком (партии + позиции заказов + деньги). */
  @Delete(':id')
  @HttpCode(200)
  revert(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.service.revert(ws.workspaceId, id, user.sub);
  }
}
