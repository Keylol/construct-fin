import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import type { ConfigSchema } from '../config';

interface UploadInput {
  workspaceId: string;
  transactionId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

@Injectable()
export class AttachmentService {
  private readonly uploadDir: string;
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<ConfigSchema, true>,
  ) {
    this.uploadDir = path.resolve(config.get('UPLOAD_DIR', { infer: true }));
    this.maxBytes = config.get('MAX_UPLOAD_SIZE_MB', { infer: true }) * 1024 * 1024;
  }

  async list(workspaceId: string, transactionId: string) {
    await this.ensureTxBelongs(workspaceId, transactionId);
    return this.prisma.attachment.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, filename: true, mimeType: true, size: true, createdAt: true },
    });
  }

  async upload(input: UploadInput) {
    await this.ensureTxBelongs(input.workspaceId, input.transactionId);

    if (input.buffer.byteLength === 0) {
      throw new BadRequestException('Empty file');
    }
    if (input.buffer.byteLength > this.maxBytes) {
      throw new BadRequestException(
        `File too large: ${input.buffer.byteLength} bytes (max ${this.maxBytes})`,
      );
    }

    const hash = createHash('sha256').update(input.buffer).digest('hex');
    // dedup: ищем уже загруженный файл с тем же hash в этом ws
    const existingFile = await this.prisma.attachment.findFirst({
      where: {
        hash,
        transaction: { workspaceId: input.workspaceId, deletedAt: null },
      },
      select: { storagePath: true },
    });

    let storagePath: string;
    if (existingFile && existsSync(existingFile.storagePath)) {
      storagePath = existingFile.storagePath;
    } else {
      // храним по хешу: data/uploads/<workspaceId>/<hash[:2]>/<hash>
      const dir = path.join(this.uploadDir, input.workspaceId, hash.slice(0, 2));
      await fs.mkdir(dir, { recursive: true });
      storagePath = path.join(dir, hash);
      await fs.writeFile(storagePath, input.buffer);
    }

    const record = await this.prisma.attachment.create({
      data: {
        transactionId: input.transactionId,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.buffer.byteLength,
        storagePath,
        hash,
      },
      select: { id: true, filename: true, mimeType: true, size: true, createdAt: true },
    });
    return record;
  }

  async download(workspaceId: string, attachmentId: string) {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, transaction: { workspaceId, deletedAt: null } },
    });
    if (!att) throw new NotFoundException('Attachment not found');
    if (!existsSync(att.storagePath)) {
      throw new NotFoundException('File missing on disk');
    }
    const buffer = await fs.readFile(att.storagePath);
    return { buffer, filename: att.filename, mimeType: att.mimeType };
  }

  async remove(workspaceId: string, attachmentId: string) {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, transaction: { workspaceId, deletedAt: null } },
      select: { id: true, hash: true, storagePath: true },
    });
    if (!att) throw new NotFoundException('Attachment not found');

    await this.prisma.attachment.delete({ where: { id: att.id } });

    // удаляем файл с диска только если больше нет ссылок на тот же hash
    const stillUsed = await this.prisma.attachment.count({ where: { hash: att.hash } });
    if (stillUsed === 0 && existsSync(att.storagePath)) {
      await fs.unlink(att.storagePath).catch(() => undefined);
    }
  }

  private async ensureTxBelongs(workspaceId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
  }
}
