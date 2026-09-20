import { ApiError } from './api';

/**
 * Человеческие сообщения формы входа. Сырой ответ показывать нельзя: на
 * /auth/* висит ThrottlerGuard (10 запросов в минуту, общий на всех — за
 * прокси req.ip = loopback), и при превышении владелец видел «HTTP 429»
 * вместо объяснения, что надо просто подождать.
 */

export const LOGIN_LIMIT_MESSAGE =
  'Слишком много попыток входа. Подождите минуту и введите пароль ещё раз.';
export const LOGIN_OFFLINE_MESSAGE =
  'Нет связи с сервером. Проверьте подключение и попробуйте снова.';
export const LOGIN_SERVER_MESSAGE = 'Сервер не отвечает. Попробуйте через минуту.';

/** Текст ошибки от API — только если это осмысленная строка, а не заглушка ApiError. */
function serverMessage(error: ApiError): string | undefined {
  const message = (error.body as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

export function describeLoginFailure(error: unknown): string {
  // Не ApiError — значит до сервера не дошли: сеть, VPN, домен.
  if (!(error instanceof ApiError)) return LOGIN_OFFLINE_MESSAGE;
  if (error.status === 429) return LOGIN_LIMIT_MESSAGE;
  if (error.status === 401) return serverMessage(error) ?? 'Неверный пароль.';
  if (error.status >= 500) return LOGIN_SERVER_MESSAGE;
  return serverMessage(error) ?? `Не удалось войти (код ${error.status}).`;
}
