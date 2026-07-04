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
import { ImportService } from './import.service';
import {
  CommitBodySchema,
  ColumnMappingSchema,
  ImportSourceSchema,
  PreviewQuerySchema,
  type CommitBody,
  type PreviewQuery,
} from './import.dto';
import type { JwtPayload } from '../auth/auth.service';
import type { WorkspaceContext } from '../common/workspace.guard';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

@Controller('workspaces/:wsId/import')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class ImportController {
  constructor(private readonly service: ImportService) {}

  @Post('preview')
  async preview(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(PreviewQuerySchema)) query: PreviewQuery,
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
      | {
          filename: string;
          mimetype: string;
          toBuffer: () => Promise<Buffer>;
        }
      | undefined;
    if (!part) throw new BadRequestException('No file in request');

    const buffer = await part.toBuffer();
    if (buffer.byteLength === 0) throw new BadRequestException('Empty file');
    if (buffer.byteLength > MAX_IMPORT_BYTES) {
      throw new BadRequestException(
        `File too large: ${buffer.byteLength} bytes (max ${MAX_IMPORT_BYTES})`,
      );
    }

    const source = query.source
      ? ImportSourceSchema.parse(query.source)
      : undefined;
    const mapping = query.mapping
      ? ColumnMappingSchema.parse(JSON.parse(query.mapping))
      : undefined;

    return this.service.preview({
      workspaceId: ws.workspaceId,
      accountId: query.accountId,
      buffer,
      filename: part.filename,
      mimeType: part.mimetype,
      source,
      mapping,
    });
  }

  @Post('commit')
  commit(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodPipe(CommitBodySchema)) body: CommitBody,
  ) {
    return this.service.commit({
      workspaceId: ws.workspaceId,
      userId: user.sub,
      body,
    });
  }

  @Get('batches')
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.service.listBatches(ws.workspaceId);
  }

  /** GH8: откат импортированной выписки (soft-delete батча + проводок + пересчёт оплат). */
  @Delete('batches/:id')
  @HttpCode(200)
  revert(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.service.revertBatch(ws.workspaceId, id, user.sub);
  }
}
