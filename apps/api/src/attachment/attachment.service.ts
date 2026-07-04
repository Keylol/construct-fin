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
  transactionId?: string;
  orderId?: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

const SELECT = { id: true, filename: true, mimeType: true, size: true, createdAt: true } as const;

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

  // ─────────── Transactions ───────────

  async list(workspaceId: string, transactionId: string) {
    await this.ensureTxBelongs(workspaceId, transactionId);
    return this.prisma.attachment.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
      select: SELECT,
    });
  }

  async upload(input: UploadInput & { transactionId: string }) {
    await this.ensureTxBelongs(input.workspaceId, input.transactionId);
    return this.store(input);
  }

  // ─────────── Orders ───────────

  async listForOrder(workspaceId: string, orderId: string) {
    await this.ensureOrderBelongs(workspaceId, orderId);
    return this.prisma.attachment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: SELECT,
    });
  }

  async uploadForOrder(input: UploadInput & { orderId: string }) {
    await this.ensureOrderBelongs(input.workspaceId, input.orderId);
    return this.store(input);
  }

  // ─────────── Shared ───────────

  async download(workspaceId: string, attachmentId: string) {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, workspaceId },
    });
    if (!att) throw new NotFoundException('Attachment not found');
    // DE6: вложение недоступно, если его родитель soft-удалён (заказ отменён/удалён
    // или операция удалена). FK-cascade при soft-delete не срабатывает, поэтому
    // строка висит — проверяем живость родителя явно, иначе чек можно скачать по
    // прямой ссылке после удаления заказа/операции.
    if (att.orderId) {
      const alive = await this.prisma.order.findFirst({
        where: { id: att.orderId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!alive) throw new NotFoundException('Attachment not found');
    }
    if (att.transactionId) {
      const alive = await this.prisma.transaction.findFirst({
        where: { id: att.transactionId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!alive) throw new NotFoundException('Attachment not found');
    }
    if (!existsSync(att.storagePath)) throw new NotFoundException('File missing on disk');
    const buffer = await fs.readFile(att.storagePath);
    return { buffer, filename: att.filename, mimeType: att.mimeType };
  }

  async remove(workspaceId: string, attachmentId: string) {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, workspaceId },
      select: { id: true, hash: true, storagePath: true },
    });
    if (!att) throw new NotFoundException('Attachment not found');

    await this.prisma.attachment.delete({ where: { id: att.id } });

    // Дедуп в store() — per-workspace (hash + workspaceId), и файл лежит под
    // каталогом workspace. Поэтому «ещё используется» тоже считаем per-workspace,
    // иначе можно удалить с диска файл, который ещё нужен другому workspace.
    const stillUsed = await this.prisma.attachment.count({
      where: { hash: att.hash, workspaceId },
    });
    if (stillUsed === 0 && existsSync(att.storagePath)) {
      await fs.unlink(att.storagePath).catch(() => undefined);
    }
  }

  // ─────────── Internal ───────────

  private async store(input: UploadInput) {
    if (input.buffer.byteLength === 0) throw new BadRequestException('Empty file');
    if (input.buffer.byteLength > this.maxBytes) {
      throw new BadRequestException(
        `File too large: ${input.buffer.byteLength} bytes (max ${this.maxBytes})`,
      );
    }

    const hash = createHash('sha256').update(input.buffer).digest('hex');
    const existingFile = await this.prisma.attachment.findFirst({
      where: { hash, workspaceId: input.workspaceId },
      select: { storagePath: true },
    });

    let storagePath: string;
    if (existingFile && existsSync(existingFile.storagePath)) {
      storagePath = existingFile.storagePath;
    } else {
      const dir = path.join(this.uploadDir, input.workspaceId, hash.slice(0, 2));
      await fs.mkdir(dir, { recursive: true });
      storagePath = path.join(dir, hash);
      await fs.writeFile(storagePath, input.buffer);
    }

    return this.prisma.attachment.create({
      data: {
        workspaceId: input.workspaceId,
        transactionId: input.transactionId ?? null,
        orderId: input.orderId ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.buffer.byteLength,
        storagePath,
        hash,
      },
      select: SELECT,
    });
  }

  private async ensureTxBelongs(workspaceId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
  }

  private async ensureOrderBelongs(workspaceId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
  }
}
