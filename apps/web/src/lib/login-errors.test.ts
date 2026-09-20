import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import {
  describeLoginFailure,
  LOGIN_LIMIT_MESSAGE,
  LOGIN_OFFLINE_MESSAGE,
  LOGIN_SERVER_MESSAGE,
} from './login-errors';

const apiError = (status: number, message?: string) =>
  new ApiError(status, message ? { message } : null, message ?? `HTTP ${status}`);

describe('describeLoginFailure', () => {
  it('429 объясняет лимит, а не показывает код', () => {
    expect(describeLoginFailure(apiError(429, 'ThrottlerException: Too many requests'))).toBe(
      LOGIN_LIMIT_MESSAGE,
    );
  });

  it('401 показывает причину от сервера', () => {
    expect(describeLoginFailure(apiError(401, 'Неверный пароль'))).toBe('Неверный пароль');
    expect(describeLoginFailure(apiError(401, 'Вход по паролю не настроен'))).toBe(
      'Вход по паролю не настроен',
    );
  });

  it('401 без тела не показывает «HTTP 401»', () => {
    expect(describeLoginFailure(apiError(401))).toBe('Неверный пароль.');
  });

  it('5xx — про сервер, прочие коды — с кодом', () => {
    expect(describeLoginFailure(apiError(502))).toBe(LOGIN_SERVER_MESSAGE);
    expect(describeLoginFailure(apiError(400))).toBe('Не удалось войти (код 400).');
  });

  it('обрыв связи (не ApiError) — про подключение', () => {
    expect(describeLoginFailure(new TypeError('Failed to fetch'))).toBe(LOGIN_OFFLINE_MESSAGE);
    expect(describeLoginFailure(undefined)).toBe(LOGIN_OFFLINE_MESSAGE);
  });
});
