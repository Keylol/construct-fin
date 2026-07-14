import { describe, expect, it, vi } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { ZodError, z } from 'zod';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Гоняет фильтр без подъёма приложения: подменяем httpAdapter.reply стабом,
 * который перехватывает (status, body), и фейковый ArgumentsHost.
 */
function run(exception: unknown): { status: number; body: any } {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const reply = vi.fn((_res: unknown, body: unknown, status: number) => {
    captured.status = status;
    captured.body = body;
  });
  const adapterHost = { httpAdapter: { reply } } as unknown as HttpAdapterHost;
  const host = {
    switchToHttp: () => ({ getResponse: () => ({}), getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter(adapterHost).catch(exception, host);
  return captured;
}

function prismaKnown(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('AllExceptionsFilter', () => {
  it('passes through HttpException status and body unchanged', () => {
    const { status, body } = run(new NotFoundException('Transaction not found'));
    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      message: 'Transaction not found',
      error: 'Not Found',
    });
  });

  it('preserves the ZodPipe-style validation body verbatim', () => {
    const payload = {
      message: 'Validation failed',
      issues: [{ path: ['amount'], message: 'must be a decimal' }],
    };
    const { status, body } = run(new BadRequestException(payload));
    expect(status).toBe(400);
    expect(body).toEqual(payload);
  });

  it('maps Prisma unique violation (P2002) to 409', () => {
    const { status, body } = run(prismaKnown('P2002', { target: ['workspaceId', 'number'] }));
    expect(status).toBe(409);
    expect(body.error).toBe('Conflict');
    expect(body.message).toContain('workspaceId, number');
  });

  it('maps Prisma record-not-found (P2025) to 404', () => {
    expect(run(prismaKnown('P2025')).status).toBe(404);
  });

  it('maps Prisma FK violation (P2003) to 400', () => {
    expect(run(prismaKnown('P2003')).status).toBe(400);
  });

  it('maps unknown Prisma code to 400', () => {
    expect(run(prismaKnown('P2099')).status).toBe(400);
  });

  it('maps Prisma write conflict / deadlock (P2034) to 409 (retryable, not 400)', () => {
    const { status, body } = run(prismaKnown('P2034'));
    expect(status).toBe(409);
    expect(body.error).toBe('Conflict');
  });

  it('maps Prisma pool timeout (P2024) to 503, not 400', () => {
    const { status, body } = run(prismaKnown('P2024'));
    expect(status).toBe(503);
    expect(body.error).toBe('Service Unavailable');
  });

  it('maps Prisma connection codes (P1001/P1002) as known-request error to 503', () => {
    expect(run(prismaKnown('P1001')).status).toBe(503);
    expect(run(prismaKnown('P1002')).status).toBe(503);
  });

  it('maps PrismaClientInitializationError (P1001 — db unreachable) to 503 without leaking detail', () => {
    const err = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at localhost:5433",
      'test',
      'P1001',
    );
    const { status, body } = run(err);
    expect(status).toBe(503);
    expect(body.error).toBe('Service Unavailable');
    expect(JSON.stringify(body)).not.toContain('localhost');
  });

  it('maps a stray ZodError to 400 with issues', () => {
    let zerr: ZodError;
    try {
      z.object({ a: z.string() }).parse({ a: 1 });
      throw new Error('should have thrown');
    } catch (e) {
      zerr = e as ZodError;
    }
    const { status, body } = run(zerr!);
    expect(status).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.issues).toHaveLength(1);
  });

  it('maps unknown errors to a generic 500 without leaking the message', () => {
    const { status, body } = run(new Error('secret stacktrace detail'));
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('AllExceptionsFilter → TelegramAlertService (L5-хвост)', () => {
  function runWithAlerts(exception: unknown) {
    const alert5xx = vi.fn();
    const reply = vi.fn();
    const adapterHost = { httpAdapter: { reply } } as unknown as HttpAdapterHost;
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ getHeader: () => 'req-123' }),
        getRequest: () => ({ method: 'POST', url: '/api/orders?x=1' }),
      }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter(adapterHost, { alert5xx } as never).catch(exception, host);
    return alert5xx;
  }

  it('5xx зовёт alert5xx с методом/URL/reqId', () => {
    const alert5xx = runWithAlerts(new Error('boom'));
    expect(alert5xx).toHaveBeenCalledOnce();
    expect(alert5xx).toHaveBeenCalledWith({
      status: 500,
      method: 'POST',
      url: '/api/orders?x=1',
      reqId: 'req-123',
    });
  });

  it('4xx алерт НЕ зовёт', () => {
    const alert5xx = runWithAlerts(new NotFoundException('нет'));
    expect(alert5xx).not.toHaveBeenCalled();
  });
});
