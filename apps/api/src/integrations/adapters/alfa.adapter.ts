import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { ConfigSchema } from '../../config';
import { money } from '../../common/money';
import { businessDayParts, businessInstant } from '../../reports/period';
import type {
  BankProviderAdapter,
  FetchStatementInput,
  FetchStatementResult,
  RawBankLine,
} from '../provider-adapter';
import { ALFA_HTTP, type AlfaHttp } from './alfa-transport';
import { assertHeaderSafe, type TlsMaterial } from './bank-http';
import { AdapterRegistry } from '../adapter-registry';

/**
 * Адаптер выписки Альфа-Бизнеса (Ф2 генплана «Полный автомат»).
 *
 * Метод: `GET {base}/v1/statement/transactions?accountNumber=&statementDate=&page=`
 * (scope `transactions`). Авторизация — `Authorization: ApiKey {key}`: ключ
 * выпускается один раз на Портале разработчика и не требует интерактивного входа
 * пользователя, поэтому ежечасный крон работает без участия владельца. Второй
 * вариант того же метода (Bearer по Authorization Code Flow) требовал бы
 * браузерного входа и обновления refresh-токена — для фонового синка не годится.
 *
 * Ключевое ограничение банка: **выписка отдаётся ровно за один календарный день**
 * (`statementDate`), поэтому синк идёт циклом по дням от курсора до сегодня.
 * Курсор — последний ПОЛНОСТЬЮ закрытый день (вчера и раньше): текущий день
 * перезапрашивается на каждом синке, потому что операции по нему ещё доезжают.
 * Повторные строки отсекаются идемпотентностью по (connectionId, externalId).
 *
 * Ф4 (сверка АУСН): в ответе банка признака АУСН нет — `ausnMark` остаётся null,
 * сверка «мы считаем расходом / банк не учёл» работает по fallback-пути из
 * генплана (импорт реестра), а не по этому API.
 */

/** Сколько календарных дней максимум догоняем за один синк (защита от долбёжки). */
export const MAX_DAYS_PER_SYNC = 31;
/** Потолок страниц на день: банк отдаёт до 1000 операций на страницу. */
const MAX_PAGES_PER_DAY = 25;
/** Глубина истории у банка: не ранее 5 лет от 1 января текущего года. */
const MAX_HISTORY_YEARS = 5;

/** Одна операция в ответе Альфы (только поля, которые реально читаем). */
interface AlfaTransaction {
  transactionId?: string;
  uuid?: string;
  direction?: string;
  operationDate?: string;
  documentDate?: string;
  paymentPurpose?: string;
  amount?: { amount?: number | string; currencyName?: string };
  amountRub?: { amount?: number | string; currencyName?: string };
  rurTransfer?: {
    payerName?: string;
    payerInn?: string;
    payeeName?: string;
    payeeInn?: string;
  };
  curTransfer?: { payerName?: string; payerInn?: string; payeeName?: string; payeeInn?: string };
  swiftTransfer?: { orderingCustomerName?: string; beneficiaryCustomerName?: string };
}

interface AlfaStatementResponse {
  transactions?: AlfaTransaction[];
  _links?: { rel?: string; href?: string }[];
}

@Injectable()
export class AlfaAdapter implements BankProviderAdapter, OnModuleInit {
  readonly provider = 'ALFA' as const;
  private readonly logger = new Logger(AlfaAdapter.name);

  constructor(
    @Inject(ALFA_HTTP) private readonly http: AlfaHttp,
    private readonly config: ConfigService<ConfigSchema, true>,
    private readonly registry: AdapterRegistry,
  ) {}

  /**
   * На проде адаптер включается всегда: сертификат mTLS принадлежит подключению
   * (у разных ИП — разные сертификаты от банка), и есть ли он, выясняется в
   * момент синка — тогда же владелец получит понятное сообщение.
   *
   * Вне прода реальный адаптер вытеснил бы FakeBankAdapter, на котором держится
   * демо и интеграционные тесты полного цикла «выписка → Inbox». Поэтому в
   * dev/test он включается, только если сертификат задан в env явно — то есть
   * когда локальную работу с банком настроили осознанно.
   */
  onModuleInit(): void {
    const isProd = this.config.get('NODE_ENV', { infer: true }) === 'production';
    const envCert =
      !!this.config.get('ALFA_TLS_CERT_PATH', { infer: true }) &&
      !!this.config.get('ALFA_TLS_KEY_PATH', { infer: true });
    if (!isProd && !envCert) {
      this.logger.warn('Alfa API вне прода не включён (нет ALFA_TLS_*) — работает FakeBank');
      return;
    }
    this.registry.register('ALFA', this);
    this.logger.log(`Alfa API подключён: ${this.baseUrl()}`);
  }

  /**
   * База API: своя из env либо пром по умолчанию.
   *
   * Через `||`, а НЕ через `??`: docker-compose с `VAR: ${VAR:-}` подставляет
   * пустую строку, когда переменной нет в .env, и ConfigService отдаёт именно
   * пустую строку. С `??` дефолт не подхватился бы, база стала бы пустой, а
   * запрос ушёл бы по относительному пути в никуда. Тот же класс, что прод-
   * инцидент 2026-07-26 с INTEGRATION_MASTER_KEY.
   */
  private baseUrl(): string {
    const base = this.config.get('ALFA_API_BASE_URL', { infer: true })?.trim() || DEFAULT_BASE_URL;
    return base.replace(/\/$/, '');
  }

  async fetchStatement(input: FetchStatementInput): Promise<FetchStatementResult> {
    const accountNumber = input.accountNumber?.trim();
    if (!accountNumber) {
      throw new Error(
        'Подключение Альфы без номера расчётного счёта: укажите счёт в настройках интеграции',
      );
    }
    // API Key уходит в заголовок Authorization — он обязан быть latin1.
    assertHeaderSafe(input.token);

    const today = dayKey(new Date());
    const days = this.daysToFetch(
      input.cursor,
      input.backfillFrom ?? input.connectedAt,
      today,
    );
    if (days.length === 0) return { lines: [], nextCursor: input.cursor };

    const lines: RawBankLine[] = [];
    for (const day of days) {
      const dayLines = await this.fetchDay(input.token, accountNumber, day, input.tls ?? null);
      lines.push(...dayLines);
    }

    // Курсор двигаем только до последнего ЗАКРЫТОГО дня: текущий день ещё
    // пополняется, его надо перезапросить на следующем синке.
    const lastDay = days[days.length - 1]!;
    const nextCursor = lastDay === today ? prevDay(today) : lastDay;
    return { lines, nextCursor };
  }

  /**
   * Календарные дни, которые нужно запросить: от дня после курсора (или от даты
   * старта — подключения либо явной backfillFrom) до сегодня включительно, но не
   * больше MAX_DAYS_PER_SYNC за раз.
   */
  private daysToFetch(cursor: string | null, startFrom: Date, today: string): string[] {
    const floor = this.historyFloor();
    let from = cursor ? nextDay(cursor) : dayKey(startFrom);
    if (from < floor) from = floor;

    const out: string[] = [];
    for (let d = from; d <= today && out.length < MAX_DAYS_PER_SYNC; d = nextDay(d)) {
      out.push(d);
    }
    if (out.length === MAX_DAYS_PER_SYNC && out[out.length - 1] !== today) {
      this.logger.log(
        `Alfa: за синк берём ${MAX_DAYS_PER_SYNC} дн. (${out[0]}…${out[out.length - 1]}), остаток догоним следующим проходом`,
      );
    }
    return out;
  }

  /** Самая ранняя дата, которую примет банк: 1 января (текущий год − 5). */
  private historyFloor(): string {
    const { y } = businessDayParts(new Date());
    return `${y - MAX_HISTORY_YEARS}-01-01`;
  }

  /** Все страницы выписки за один календарный день. */
  private async fetchDay(
    apiKey: string,
    accountNumber: string,
    day: string,
    tls: TlsMaterial | null,
  ): Promise<RawBankLine[]> {
    const base = this.baseUrl();
    const out: RawBankLine[] = [];

    for (let page = 1; page <= MAX_PAGES_PER_DAY; page++) {
      const url = `${base}/v1/statement/transactions?accountNumber=${encodeURIComponent(
        accountNumber,
      )}&statementDate=${day}&page=${page}`;

      const res = await this.http.getJson(
        url,
        {
          Authorization: `ApiKey ${apiKey}`,
          Accept: 'application/json',
          // Корреляция запроса на стороне банка — пригодится в разборе инцидентов.
          'x-fapi-interaction-id': randomUUID(),
        },
        tls ?? undefined,
      );

      if (res.status !== 200) throw httpError(res.status, res.body, day);

      const parsed = parseBody(res.body, day);
      const txs = parsed.transactions ?? [];
      for (const tx of txs) {
        const line = mapTransaction(tx, day);
        if (line) out.push(line);
      }

      const hasNext = (parsed._links ?? []).some((l) => l.rel === 'next' && !!l.href);
      if (!hasNext) break;
      if (page === MAX_PAGES_PER_DAY) {
        // Молча обрезать выписку нельзя: это тихая потеря операций дня.
        throw new Error(
          `Alfa: за ${day} больше ${MAX_PAGES_PER_DAY} страниц выписки — синк остановлен, чтобы не потерять операции`,
        );
      }
    }
    return out;
  }
}

const DEFAULT_BASE_URL = 'https://baas.alfabank.ru/api/jp';

/** Ошибка провайдера с человеческим текстом: он доезжает до UI интеграций. */
function httpError(status: number, body: string, day: string): Error {
  const known: Record<number, string> = {
    400: 'банк отклонил запрос выписки (проверьте номер счёта)',
    401: 'API-ключ не принят банком (истёк, отозван или скопирован с ошибкой)',
    403: 'у ключа нет доступа к выписке по этому счёту',
    404: 'счёт не найден в Альфа-Банке',
    429: 'банк временно ограничил частоту запросов — синк повторится позже',
  };
  const reason = known[status] ?? `банк ответил HTTP ${status}`;
  // Тело ответа наружу не тащим: у банка там бывает эхо запроса с реквизитами.
  // Полный текст остаётся в форензик-логе через общий обработчик ошибок синка.
  return new Error(`Alfa (${day}): ${reason}`);
}

function parseBody(body: string, day: string): AlfaStatementResponse {
  try {
    return JSON.parse(body) as AlfaStatementResponse;
  } catch {
    throw new Error(`Alfa (${day}): ответ банка не является JSON`);
  }
}

/**
 * Операция банка → нормализованная строка выписки. Возвращает null для строк,
 * которые нельзя учесть (нет идентификатора, суммы или направления) — такие
 * пропускаем, а не роняем весь день.
 */
export function mapTransaction(tx: AlfaTransaction, day: string): RawBankLine | null {
  const externalId = tx.transactionId ?? tx.uuid;
  if (!externalId) return null;

  const direction = tx.direction?.toUpperCase();
  if (direction !== 'DEBIT' && direction !== 'CREDIT') return null;
  // Выписка по НАШЕМУ счёту: DEBIT — списание, CREDIT — поступление.
  const type = direction === 'DEBIT' ? ('EXPENSE' as const) : ('INCOME' as const);

  const amount = pickAmount(tx);
  if (amount === null) return null;

  // Контрагент — «другая сторона» операции: по расходу это получатель,
  // по приходу — плательщик.
  const party = tx.rurTransfer ?? tx.curTransfer;
  const counterpartyName =
    (type === 'EXPENSE' ? party?.payeeName : party?.payerName) ??
    (type === 'EXPENSE'
      ? tx.swiftTransfer?.beneficiaryCustomerName
      : tx.swiftTransfer?.orderingCustomerName) ??
    null;
  const counterpartyInn = (type === 'EXPENSE' ? party?.payeeInn : party?.payerInn) ?? null;

  return {
    externalId,
    date: parseDate(tx.operationDate ?? tx.documentDate, day),
    amount,
    direction: type,
    counterpartyName: counterpartyName?.trim() || null,
    counterpartyInn: counterpartyInn?.trim() || null,
    description: tx.paymentPurpose?.trim() || null,
    // Признака АУСН в этом методе банк не отдаёт (см. шапку файла).
    ausnMark: null,
    raw: tx,
  };
}

/**
 * Сумма операции в рублях, модулем, строкой с 2 знаками.
 *
 * Банк отдаёт сумму числом (JSON number), а деньги в проекте — только Decimal:
 * прогоняем через money(), а не через toFixed на float. Для валютного счёта
 * берём рублёвый эквивалент amountRub — учёт моновалютный (₽).
 */
function pickAmount(tx: AlfaTransaction): string | null {
  const currency = tx.amount?.currencyName?.toUpperCase();
  const isRub = currency === 'RUB' || currency === 'RUR' || currency === undefined;
  const raw = isRub ? tx.amount?.amount : (tx.amountRub?.amount ?? tx.amount?.amount);
  if (raw === undefined || raw === null || raw === '') return null;

  try {
    const value = money(raw).abs();
    return value.toFixed(2);
  } catch {
    return null;
  }
}

/** Дата операции; при отсутствии/битом значении — полдень бизнес-дня выписки. */
function parseDate(value: string | undefined, day: string): Date {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const [y, mo, d] = day.split('-').map(Number);
  return businessInstant(y!, mo! - 1, d!);
}

/** Календарный день бизнес-пояса (UTC+5) в виде YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const { y, mo, d } = businessDayParts(date);
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shiftDay(day: string, delta: number): string {
  const [y, mo, d] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(y!, mo! - 1, d! + delta));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

export const nextDay = (day: string): string => shiftDay(day, 1);
export const prevDay = (day: string): string => shiftDay(day, -1);
