import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigSchema } from '../config';

/**
 * L5 (наблюдаемость, хвост): алерт владельцу в Telegram о 5xx на проде.
 *
 * Выключен, пока не задан `ALERT_TELEGRAM_CHAT_ID` (локалка/CI/тесты — no-op).
 * На проде: chat_id = telegramId владельца (личный чат с ботом уже открыт —
 * бот и есть вход в Mini App), токен — тот же TELEGRAM_BOT_TOKEN.
 *
 * Антиспам: не чаще 1 сообщения на маршрут (method + путь без query) в
 * KEY_COOLDOWN, плюс глобальный потолок HOURLY_CAP сообщений в час — шторм
 * 5xx не превращается в шторм уведомлений (окно «тихих» ошибок всё равно
 * покрыто форензик-логом фильтра). Состояние in-memory: перезапуск контейнера
 * сбрасывает троттлинг — приемлемо (после рестарта уведомить и правильно).
 *
 * Отправка fire-and-forget: таймаут 3с, любая ошибка Telegram API — warn в лог,
 * НИКОГДА не пробрасывается (алертинг не должен ронять обработку запросов).
 */
@Injectable()
export class TelegramAlertService {
  private readonly logger = new Logger(TelegramAlertService.name);
  private readonly lastSentByKey = new Map<string, number>();
  private sentThisHour: number[] = [];

  /** Пауза между алертами по одному и тому же маршруту. */
  static readonly KEY_COOLDOWN_MS = 10 * 60_000;
  /** Глобальный потолок сообщений в скользящий час. */
  static readonly HOURLY_CAP = 20;

  constructor(private readonly config: ConfigService<ConfigSchema, true>) {}

  /** Алерт о 5xx. Синхронно решает «слать ли» (троттлинг), шлёт в фоне. */
  alert5xx(opts: { status: number; method: string; url: string; reqId: string }): void {
    const chatId = this.config.get('ALERT_TELEGRAM_CHAT_ID', { infer: true });
    if (!chatId) return;

    // Нормализация маршрута: cuid/длинные id-сегменты → :id, иначе каждый
    // workspace/заказ давал бы уникальный ключ — троттлинг «по маршруту»
    // не работал бы, а карта ключей росла бы бесконечно (находка ревью).
    const path = (opts.url.split('?')[0] ?? opts.url).replace(
      /\/[a-z0-9]{16,}(?=\/|$)/g,
      '/:id',
    );
    const key = `${opts.method} ${path}`;
    const now = Date.now();

    const last = this.lastSentByKey.get(key);
    if (last !== undefined && now - last < TelegramAlertService.KEY_COOLDOWN_MS) return;

    // Предохранитель памяти: карта ключей не может расти бесконечно даже при
    // непредвиденных формах URL. Полный сброс деградирует троттлинг, не память.
    if (this.lastSentByKey.size >= 500) this.lastSentByKey.clear();

    this.sentThisHour = this.sentThisHour.filter((t) => now - t < 3_600_000);
    if (this.sentThisHour.length >= TelegramAlertService.HOURLY_CAP) return;

    this.lastSentByKey.set(key, now);
    this.sentThisHour.push(now);

    const text = `🔴 construct-fin 5xx: ${opts.method} ${path} → ${opts.status}\nreqId: ${opts.reqId}\n(подробности в форензик-логе api по reqId)`;
    void this.send(chatId, text);
  }

  /**
   * Ф5: произвольное уведомление владельцу в тот же чат (напоминания о платежах).
   * No-op без `ALERT_TELEGRAM_CHAT_ID` — TG-канал включается, когда владелец даст
   * chat id (решение блица «логика + в аппе сейчас, TG потом»). Возвращает true,
   * если отправка инициирована. Ошибки Telegram API не пробрасываются.
   */
  async notify(text: string): Promise<boolean> {
    const chatId = this.config.get('ALERT_TELEGRAM_CHAT_ID', { infer: true });
    if (!chatId) return false;
    await this.send(chatId, text);
    return true;
  }

  private async send(chatId: string, text: string): Promise<void> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) {
        this.logger.warn(`Telegram alert не доставлен: HTTP ${res.status}`);
      }
    } catch (e) {
      this.logger.warn(`Telegram alert не доставлен: ${e instanceof Error ? e.message : e}`);
    }
  }
}
