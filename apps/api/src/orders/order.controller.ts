import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentWorkspace } from '../common/current-workspace.decorator';
import { ZodPipe } from '../common/zod-pipe';
import { OrderService } from './order.service';
import { parseOrderSpecDocx } from './spec-parser';
import { detectAndParseReceipt } from '../wb-receipt/receipt-detect';
import {
  CreateOrderSchema,
  UpdateOrderSchema,
  ListOrdersQuerySchema,
  AddPaymentSchema,
  FinalizeOrderSchema,
  InstallmentPaymentSchema,
  ReturnItemSchema,
  SetScheduleSchema,
  ShipItemSchema,
  type CreateOrderDto,
  type UpdateOrderDto,
  type ListOrdersQuery,
  type AddPaymentDto,
  type FinalizeOrderDto,
  type InstallmentPaymentDto,
  type ReturnItemDto,
  type SetScheduleDto,
  type ShipItemDto,
} from './order.dto';
import type { WorkspaceContext } from '../common/workspace.guard';

/** Спецификации — это Word на 300–400 КБ; мегабайта хватает с запасом. */
const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/** Чеки бывают на пару мегабайт: скан ДНС на 810 КБ, счета ОТ крупнее. */
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

@Controller('workspaces/:wsId/orders')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Get()
  list(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodPipe(ListOrdersQuerySchema)) query: ListOrdersQuery,
  ) {
    return this.service.list(ws.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ws.workspaceId, id);
  }

  /** F5: трассировка строк заказа до партий (поставщик/счёт закупки). */
  @Get(':id/trace')
  trace(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.trace(ws.workspaceId, id);
  }

  /**
   * Спецификация CONSTRUCTPC (.docx) → черновик заказа. Ничего не сохраняет:
   * человек правит разобранное в форме и создаёт заказ обычным POST. Разбор
   * отдельным шагом — как preview у чеков закупки.
   */
  @Post('spec-preview')
  @HttpCode(200)
  async specPreview(@Req() req: FastifyRequest) {
    const reqAny = req as FastifyRequest & {
      isMultipart?: () => boolean;
      file?: () => Promise<unknown>;
    };
    if (!reqAny.isMultipart?.()) {
      throw new BadRequestException('Ожидается multipart/form-data');
    }
    const part = (await reqAny.file?.()) as
      | { filename: string; toBuffer: () => Promise<Buffer> }
      | undefined;
    if (!part) throw new BadRequestException('В запросе нет файла');

    const buffer = await part.toBuffer();
    if (buffer.byteLength === 0) throw new BadRequestException('Пустой файл');
    if (buffer.byteLength > MAX_SPEC_BYTES) {
      throw new BadRequestException(
        `Файл больше ${Math.round(MAX_SPEC_BYTES / 1024 / 1024)} МБ`,
      );
    }

    try {
      return await parseOrderSpecDocx(buffer);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Не удалось прочитать файл',
      );
    }
  }

  /**
   * Чек закупки (PDF ДНС / Wildberries / Онлайн Трейд) → строки с ценами.
   * Ничего не сохраняет и не спрашивает счёт: это второй шаг заведения заказа
   * из архива — цены нужны, чтобы проставить себестоимость позиций, а
   * проведение закупки идёт своим путём («Разобрать чек» в карточке).
   *
   * По файлу за запрос: @fastify/multipart настроен на files: 1, и менять
   * глобальный лимит ради одной ручки не стоит — фронт шлёт чеки по очереди.
   */
  @Post('costs-preview')
  @HttpCode(200)
  async costsPreview(@Req() req: FastifyRequest) {
    const reqAny = req as FastifyRequest & {
      isMultipart?: () => boolean;
      file?: () => Promise<unknown>;
    };
    if (!reqAny.isMultipart?.()) {
      throw new BadRequestException('Ожидается multipart/form-data');
    }
    const part = (await reqAny.file?.()) as
      | { filename: string; toBuffer: () => Promise<Buffer> }
      | undefined;
    if (!part) throw new BadRequestException('В запросе нет файла');

    const buffer = await part.toBuffer();
    if (buffer.byteLength === 0) throw new BadRequestException('Пустой файл');
    if (buffer.byteLength > MAX_RECEIPT_BYTES) {
      throw new BadRequestException(
        `Файл больше ${Math.round(MAX_RECEIPT_BYTES / 1024 / 1024)} МБ`,
      );
    }

    const parsed = await detectAndParseReceipt(buffer);
    return {
      filename: part.filename,
      source: parsed.source,
      receiptDate: parsed.receiptDate ? parsed.receiptDate.toISOString() : null,
      totalAmount: parsed.totalAmount,
      items: parsed.items.map((i) => ({
        name: i.name,
        qty: i.qty,
        unitPrice: i.unitPrice,
      })),
      warnings: parsed.warnings,
    };
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodPipe(CreateOrderSchema)) body: CreateOrderDto,
  ) {
    return this.service.create(ws.workspaceId, body);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateOrderSchema)) body: UpdateOrderDto,
  ) {
    return this.service.update(ws.workspaceId, id, body);
  }

  @Post(':id/payments')
  @HttpCode(200)
  addPayment(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(AddPaymentSchema)) body: AddPaymentDto,
  ) {
    return this.service.addPayment(ws.workspaceId, id, ws.userId, body);
  }

  /** F3: оплата сторонней рассрочкой — gross (полная сумма + комиссия отдельно). */
  @Post(':id/installment-payment')
  @HttpCode(200)
  addInstallmentPayment(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(InstallmentPaymentSchema)) body: InstallmentPaymentDto,
  ) {
    return this.service.addInstallmentPayment(ws.workspaceId, id, ws.userId, body);
  }

  /** C2: доменное удаление ошибочной оплаты/возврата/комиссии заказа. */
  @Delete(':id/payments/:txId')
  @HttpCode(200)
  deletePayment(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Param('txId') txId: string,
  ) {
    return this.service.deletePayment(ws.workspaceId, id, txId, ws.userId);
  }

  @Put(':id/schedule')
  setSchedule(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(SetScheduleSchema)) body: SetScheduleDto,
  ) {
    return this.service.setSchedule(ws.workspaceId, id, ws.userId, body);
  }

  @Post(':id/ship')
  @HttpCode(200)
  ship(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ShipItemSchema)) body: ShipItemDto,
  ) {
    return this.service.ship(ws.workspaceId, id, ws.userId, body);
  }

  @Post(':id/returns')
  @HttpCode(200)
  returnItem(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ReturnItemSchema)) body: ReturnItemDto,
  ) {
    return this.service.returnItem(ws.workspaceId, id, ws.userId, body);
  }

  @Post(':id/finalize')
  @HttpCode(200)
  finalize(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodPipe(FinalizeOrderSchema)) body: FinalizeOrderDto,
  ) {
    return this.service.finalize(
      ws.workspaceId,
      id,
      ws.userId,
      body.closedOn ? new Date(body.closedOn) : undefined,
    );
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.reopen(ws.workspaceId, id, ws.userId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.cancel(ws.workspaceId, id, ws.userId);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ws.workspaceId, id, ws.userId);
  }
}
