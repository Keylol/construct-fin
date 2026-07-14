import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramAlertService } from './telegram-alert.service';

/**
 * Юнит-тесты Telegram-алертинга 5xx (L5-хвост). ConfigService и fetch мокаются;
 * проверяем контракты: выключен без chat_id, троттлинг по маршруту, часовой
 * потолок, устойчивость к ошибкам Telegram API (никогда не бросает).
 */

function build(env: { chatId?: string } = {}) {
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'ALERT_TELEGRAM_CHAT_ID') return env.chatId;
      if (key === 'TELEGRAM_BOT_TOKEN') return 'test-token';
      return undefined;
    }),
  };
  return new TelegramAlertService(config as never);
}

const A5XX = { status: 500, method: 'GET', url: '/api/x?a=1', reqId: 'r-1' };

describe('TelegramAlertService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('без ALERT_TELEGRAM_CHAT_ID — полный no-op (fetch не зовётся)', () => {
    const svc = build({});
    svc.alert5xx(A5XX);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('с chat_id шлёт sendMessage; query из ключа/текста отрезан', () => {
    const svc = build({ chatId: '42' });
    svc.alert5xx(A5XX);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('bottest-token/sendMessage');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe('42');
    expect(body.text).toContain('GET /api/x → 500');
    expect(body.text).not.toContain('a=1'); // query не светим в алерте
    expect(body.text).toContain('r-1');
  });

  it('троттлинг маршрута: повтор в пределах KEY_COOLDOWN не шлётся, после — шлётся', () => {
    const svc = build({ chatId: '42' });
    svc.alert5xx(A5XX);
    svc.alert5xx(A5XX);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TelegramAlertService.KEY_COOLDOWN_MS + 1);
    svc.alert5xx(A5XX);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('разные маршруты троттлятся независимо', () => {
    const svc = build({ chatId: '42' });
    svc.alert5xx(A5XX);
    svc.alert5xx({ ...A5XX, url: '/api/y' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('часовой потолок: не больше HOURLY_CAP сообщений в скользящий час', () => {
    const svc = build({ chatId: '42' });
    for (let i = 0; i < TelegramAlertService.HOURLY_CAP + 5; i++) {
      svc.alert5xx({ ...A5XX, url: `/api/route-${i}` }); // разные ключи
    }
    expect(fetchMock).toHaveBeenCalledTimes(TelegramAlertService.HOURLY_CAP);

    // Спустя час окно очистилось — снова можно.
    vi.advanceTimersByTime(3_600_001);
    svc.alert5xx({ ...A5XX, url: '/api/after-hour' });
    expect(fetchMock).toHaveBeenCalledTimes(TelegramAlertService.HOURLY_CAP + 1);
  });

  it('ошибка Telegram API не пробрасывается (rejected fetch)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const svc = build({ chatId: '42' });
    expect(() => svc.alert5xx(A5XX)).not.toThrow();
    await vi.runAllTimersAsync(); // дождаться фоновой отправки
  });
});

describe('TelegramAlertService — нормализация маршрута', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cuid-сегменты сведены к :id — разные ws/заказы = один ключ троттлинга', () => {
    const svc = build({ chatId: '42' });
    svc.alert5xx({
      status: 500,
      method: 'GET',
      url: '/api/v1/workspaces/cmptgzym2000211t46ddz82zo/orders/cmptgzykh0000hos5ic1m2lbm',
      reqId: 'r1',
    });
    svc.alert5xx({
      status: 500,
      method: 'GET',
      url: '/api/v1/workspaces/cmp000another000workspace/orders/cmp000another000000order0',
      reqId: 'r2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // второй затроттлен тем же ключом
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.text).toContain('/api/v1/workspaces/:id/orders/:id');
  });
});
