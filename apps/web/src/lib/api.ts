/**
 * Тонкая обёртка fetch. Авторизация передаётся через cookie (credentials: 'include').
 * Все методы возвращают распарсенный JSON или бросают ApiError.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

export interface RequestOptions {
  /** Опциональный заголовок Idempotency-Key: повтор запроса вернёт тот же ответ. */
  idempotencyKey?: string;
}

async function request<T>(
  path: string,
  init?: RequestInit & RequestOptions,
): Promise<T> {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const { idempotencyKey, headers, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(headers ?? {}),
    },
    ...rest,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body,
      (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),
  del: <T = void>(path: string, opts?: RequestOptions) =>
    request<T>(path, { method: 'DELETE', ...opts }),
};

/**
 * Сгенерировать одноразовый Idempotency-Key. Используй в useMutation, чтобы
 * retry не задвоил операцию (платёж, закупка, finalize).
 *
 * crypto.randomUUID() есть везде в современных браузерах + Node 16+.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback на простой random.
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}
