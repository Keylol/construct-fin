import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { AttachmentService } from './attachment.service';
import type { WorkspaceContext } from '../common/workspace.guard';

@Controller('workspaces/:wsId')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class AttachmentController {
  constructor(private readonly service: AttachmentService) {}

  @Get('transactions/:txId/attachments')
  list(@CurrentWorkspace() ws: WorkspaceContext, @Param('txId') txId: string) {
    return this.service.list(ws.workspaceId, txId);
  }

  @Post('transactions/:txId/attachments')
  async upload(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('txId') txId: string,
    @Req() req: FastifyRequest,
  ) {
    const reqAny = req as FastifyRequest & { isMultipart?: () => boolean; file?: () => Promise<unknown> };
    if (!reqAny.isMultipart?.()) {
      throw new BadRequestException('Request must be multipart/form-data');
    }
    const part = (await reqAny.file?.()) as
      | { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }
      | undefined;
    if (!part) throw new BadRequestException('No file in request');
    const buffer = await part.toBuffer();
    return this.service.upload({
      workspaceId: ws.workspaceId,
      transactionId: txId,
      filename: part.filename,
      mimeType: part.mimetype,
      buffer,
    });
  }

  @Get('orders/:orderId/attachments')
  listForOrder(@CurrentWorkspace() ws: WorkspaceContext, @Param('orderId') orderId: string) {
    return this.service.listForOrder(ws.workspaceId, orderId);
  }

  @Post('orders/:orderId/attachments')
  async uploadForOrder(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('orderId') orderId: string,
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
    return this.service.uploadForOrder({
      workspaceId: ws.workspaceId,
      orderId,
      filename: part.filename,
      mimeType: part.mimetype,
      buffer,
    });
  }

  @Get('attachments/:id/download')
  async download(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const { buffer, filename, mimeType } = await this.service.download(ws.workspaceId, id);
    reply
      .header('content-type', mimeType)
      .header('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      .send(buffer);
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  async remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    await this.service.remove(ws.workspaceId, id);
  }
}
