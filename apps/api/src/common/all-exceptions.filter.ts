import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

/**
 * Глобальный фильтр исключений.
 *
 * Цели (Фаза 3 п.13):
 *   • не отдавать наружу стектрейсы и 500 на ожидаемых ошибках БД;
 *   • маппить известные ошибки Prisma (unique / FK / not-found) в 4xx;
 *   • ZodError (если где-то прорвался мимо ZodPipe) → 400, а не 500.
 *
 * Контракт ответов СОХРАНЯЕТСЯ: любое `HttpException` (включая
 * Bad/NotFound/Forbidden из сервисов и `{message, issues}` из ZodPipe)
 * отдаётся с его собственным статусом и телом без изменений. Трансформируются
 * только НЕ-HttpException (ошибки Prisma, Zod, прочее).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();

    const { status, body } = this.resolve(exception);

    // L5 (наблюдаемость): любой 5xx — форензик-лог с контекстом запроса
    // (метод, путь, request-id) и полным стеком на сервере. Наружу стек не уходит
    // (см. resolve). request-id берём из уже проставленного заголовка ответа —
    // это тот же id, что вернётся клиенту и связывает лог с request-логом.
    if (status >= 500) {
      const method = req?.method ?? '?';
      const url = req?.url ?? req?.raw?.url ?? '?';
      const reqId = res?.getHeader?.('x-request-id') ?? req?.id ?? '?';
      this.logger.error(
        `${method} ${url} → ${status} [reqId=${reqId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    httpAdapter.reply(res, body, status);
  }

  private resolve(exception: unknown): { status: number; body: unknown } {
    // 1. Штатные HttpException — отдаём как есть, контракт не трогаем.
    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), body: exception.getResponse() };
    }

    // 2. Известные ошибки Prisma → осмысленные 4xx без утечки деталей схемы.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }
    // 2a. Ошибка инициализации клиента / подключения к БД (P1001 — сервер
    //     недоступен, P1002 — таймаут соединения). Это НЕ вина запроса, а
    //     транзиентная серверная проблема: 503 Service Unavailable, чтобы
    //     клиент/прокси понимали, что запрос можно повторить. Деталей не светим.
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      // 503 залогируется в catch() с контекстом запроса (как любой 5xx).
      return this.error(HttpStatus.SERVICE_UNAVAILABLE, 'База данных временно недоступна');
    }
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return this.error(HttpStatus.BAD_REQUEST, 'Некорректные данные запроса');
    }

    // 3. ZodError мимо ZodPipe (например, из сервисного слоя) → 400.
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Validation failed',
          error: 'Bad Request',
          issues: exception.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      };
    }

    // 4. Ошибки с готовым клиентским statusCode (например FastifyError при
    //    разборе запроса: FST_ERR_CTP_EMPTY_JSON_BODY — пустое тело при
    //    content-type: application/json — несёт statusCode 400). Это вина
    //    запроса, а не сервера: отдаём её код, а не маскируем дженерик-500.
    const sc = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof sc === 'number' && sc >= 400 && sc < 500) {
      const msg = (exception as { message?: string })?.message;
      return this.error(sc, msg && typeof msg === 'string' ? msg : 'Некорректный запрос');
    }

    // 5. Всё остальное — внутренняя ошибка. Полный стек с контекстом запроса
    //    логируется в catch() (L5), наружу отдаём дженерик без стектрейса.
    return this.error(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error');
  }

  private fromPrisma(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    body: unknown;
  } {
    switch (e.code) {
      // Нарушение уникального ограничения.
      case 'P2002': {
        const target = e.meta?.target;
        const fields = Array.isArray(target) ? target.join(', ') : undefined;
        return this.error(
          HttpStatus.CONFLICT,
          fields ? `Запись с такими значениями уже существует: ${fields}` : 'Запись уже существует',
        );
      }
      // Запись не найдена (например, update/delete по несуществующему id).
      case 'P2025':
        return this.error(HttpStatus.NOT_FOUND, 'Запись не найдена');
      // Нарушение внешнего ключа / связанная запись отсутствует.
      case 'P2003':
      case 'P2014':
        return this.error(HttpStatus.BAD_REQUEST, 'Ссылка на несуществующую связанную запись');
      // Конфликт записи на уровне транзакции: write conflict / deadlock
      // (READ COMMITTED + ручные SELECT FOR UPDATE — deadlock реален). Это НЕ
      // плохой запрос, а конкурентная коллизия: 409 Conflict (retryable), чтобы
      // клиент мог безопасно повторить операцию, а не считал её невалидной.
      case 'P2034':
        return this.error(HttpStatus.CONFLICT, 'Конфликт параллельного доступа, повторите операцию');
      // Транзиентные серверные проблемы доступа к БД:
      //   P2024 — таймаут получения соединения из пула;
      //   P1001 — сервер БД недоступен; P1002 — таймаут соединения
      //           (обычно приходят как InitializationError, но обрабатываем и
      //            здесь на случай прихода как known-request error).
      // Все — 503 Service Unavailable (retryable), а не 400.
      case 'P2024':
      case 'P1001':
      case 'P1002':
        return this.error(HttpStatus.SERVICE_UNAVAILABLE, 'База данных временно недоступна');
      default:
        // Прочие известные коды Prisma — не светим внутренности, но это 4xx,
        // т.к. как правило вызвано данными запроса. Логируем код для разбора.
        this.logger.warn(`Unmapped Prisma error ${e.code}`);
        return this.error(HttpStatus.BAD_REQUEST, 'Ошибка обработки запроса к базе данных');
    }
  }

  private error(status: number, message: string): { status: number; body: unknown } {
    return {
      status,
      body: { statusCode: status, message, error: STATUS_NAMES[status] ?? 'Error' },
    };
  }
}

const STATUS_NAMES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};
