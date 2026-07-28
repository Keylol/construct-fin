import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { ConfigSchema } from '../../config';
import { money } from '../../common/money';
import type {
  BankProviderAdapter,
  FetchStatementInput,
  FetchStatementResult,
  RawBankLine,
} from '../provider-adapter';
import { assertHeaderSafe, type BankHttp } from './bank-http';
import { TBANK_HTTP } from './tbank-transport';
import { AdapterRegistry } from '../adapter-registry';

/**
 * Адаптер выписки Т-Бизнеса (Ф3 генплана «Полный автомат»).
 *
 * Метод: `GET {base}/v1/statement?accountNumber=&from=&to=&cursor=&limit=`
 * (T-API, scope «Счета и выписки»). Авторизация — `Bearer {token}`: токен
 * выпускается в ЛК Т-Бизнеса, сертификат не нужен (в отличие от Альфы).
 *
 * Три особенности банка, вокруг которых построена логика:
 *
 * 1. **Холды не проводим.** Операция бывает в статусе `Authorization`
 *    (средства заморожены, баланс счёта не изменён) — банк прямо пишет, что в
 *    бухгалтерскую отчётность их отдавать нельзя. Запрашиваем только
 *    `operationStatus=Transaction` и перепроверяем статус при разборе.
 * 2. **Операция доходит до финального статуса 3–4 дня**, и дата проведения
 *    (`operationDate`) при этом оказывается в прошлом. Поэтому курсор — это не
 *    «граница, дальше которой не смотрим»: каждый синк перезапрашивает окно
 *    LOOKBACK_DAYS назад от курсора, иначе операции, доехавшие задним числом,
 *    были бы потеряны навсегда. Дубли отсекает идемпотентность по externalId.
 * 3. **Пагинация курсорная**: `nextCursor` в ответе → `cursor` в следующем
 *    запросе. Это внутренний курсор одной выборки, он не сохраняется между
 *    синками (в syncCursor лежит дата последней операции).
 *
 * Признака АУСН банк не отдаёт — `ausnMark` остаётся null (как и у Альфы).
 *
 * Известный риск: `operationId` может измениться у операций, проведённых с
 * 22:00 до 03:00 (документация банка). Идемпотентность держится на нём, значит
 * теоретически одна операция способна прийти дважды под разными id. Вторая
 * линия дедупа (дата + сумма + назначение) в этот адаптер не заложена —
 * см. docs/tbank-api.md.
 */

/** Насколько назад от курсора перезапрашиваем операции (см. п.2 в шапке). */
export const LOOKBACK_DAYS = 7;
/** Размер порции: банк допускает до 5000, берём с запасом по памяти. */
const PAGE_LIMIT = 1000;
/** Потолок страниц за синк: 20 × 1000 операций — заведомо больше любого месяца. */
const MAX_PAGES = 20;

const DEFAULT_BASE_URL = 'https://business.tbank.ru/openapi/api';

/** Операция в ответе Т-API (только читаемые нами поля). */
interface TbankOperation {
  operationId?: string;
  operationStatus?: string;
  operationDate?: string;
  typeOfOperation?: string;
  payPurpose?: string;
  description?: string;
  operationAmount?: number | string;
  accountAmount?: number | string;
  accountCurrencyDigitalCode?: string;
  rubleAmount?: number | string;
  counterParty?: { name?: string; inn?: string };
  payer?: { name?: string; inn?: string };
  receiver?: { name?: string; inn?: string };
}

interface TbankStatementResponse {
  operations?: TbankOperation[];
  nextCursor?: string | null;
}

@Injectable()
export class TbankAdapter implements BankProviderAdapter, OnModuleInit {
  readonly provider = 'TBANK' as const;
  private readonly logger = new Logger(TbankAdapter.name);

  constructor(
    @Inject(TBANK_HTTP) private readonly http: BankHttp,
    private readonly config: ConfigService<ConfigSchema, true>,
    private readonly registry: AdapterRegistry,
  ) {}

  /**
   * Т-Банку нечего настраивать на сервере (весь секрет — в подключении),
   * поэтому адаптер доступен всегда и вытесняет фейк для TBANK.
   */
  onModuleInit(): void {
    this.registry.register('TBANK', this);
    this.logger.log(`T-API подключён: ${this.baseUrl()}`);
  }

  async fetchStatement(input: FetchStatementInput): Promise<FetchStatementResult> {
    const accountNumber = input.accountNumber?.trim();
    if (!accountNumber) {
      throw new Error(
        'Подключение Т-Банка без номера расчётного счёта: укажите счёт в настройках интеграции',
      );
    }

    assertHeaderSafe(input.token);

    const from = this.windowStart(input.cursor, input.connectedAt);
    const lines: RawBankLine[] = [];
    // Одна операция может прийти дважды в пределах синка: окно перекрытия и
    // курсорная пагинация допускают пересечение порций. Дальше по конвейеру
    // дубли всё равно отсеклись бы идемпотентностью, но лучше не гонять их
    // через БД и не завышать счётчик «загружено».
    const seen = new Set<string>();
    let maxDate: string | null = null;
    let cursor: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.fetchPage(input.token, accountNumber, from, cursor);
      const operations = res.operations ?? [];
      for (const op of operations) {
        const line = mapOperation(op);
        if (!line || seen.has(line.externalId)) continue;
        seen.add(line.externalId);
        lines.push(line);
        const iso = line.date.toISOString();
        if (maxDate === null || iso > maxDate) maxDate = iso;
      }

      const next = res.nextCursor ?? null;
      // Три условия остановки. Последние два — защита от бесконечного цикла:
      // банк может отдавать nextCursor даже когда добирать нечего (так ведёт
      // себя песочница, отвечающая фиксированным телом), и без этой проверки
      // синк крутился бы до потолка страниц на ровном месте.
      if (!next || operations.length === 0 || next === cursor) break;
      cursor = next;

      if (page === MAX_PAGES) {
        // Не бросаем: курсор уже сдвинулся на дату последней операции, значит
        // остаток догоним следующим проходом. Но в тишине это оставлять нельзя.
        this.logger.warn(
          `Т-Банк: за синк взято ${lines.length} операций (потолок ${MAX_PAGES}×${PAGE_LIMIT}), остаток догоним следующим проходом`,
        );
      }
    }

    // Курсор двигаем только вперёд и только по факту операций: пустой ответ не
    // должен сдвигать окно (иначе потеряем то, что доедет задним числом).
    const nextCursor = maxDate && (!input.cursor || maxDate > input.cursor) ? maxDate : input.cursor;
    return { lines, nextCursor };
  }

  /** Начало запрашиваемого периода: курсор минус окно перекрытия. */
  private windowStart(cursor: string | null, connectedAt: Date): string {
    if (!cursor) return connectedAt.toISOString();
    const parsed = Date.parse(cursor);
    // Битый курсор (ручная правка в БД) не должен ронять синк — начинаем заново
    // с даты подключения, дубли отсечёт идемпотентность.
    if (Number.isNaN(parsed)) return connectedAt.toISOString();
    return new Date(parsed - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * База API: своя из env либо пром по умолчанию.
   *
   * Через `||`, а НЕ через `??`: docker-compose с `VAR: ${VAR:-}` подставляет
   * пустую строку, когда переменной нет в .env, и ConfigService отдаёт именно
   * пустую строку. С `??` дефолт не подхватился бы, база стала бы пустой, а
   * запрос ушёл бы по относительному пути в никуда.
   */
  private baseUrl(): string {
    const base = this.config.get('TBANK_API_BASE_URL', { infer: true })?.trim() || DEFAULT_BASE_URL;
    return base.replace(/\/$/, '');
  }

  private async fetchPage(
    token: string,
    accountNumber: string,
    from: string,
    cursor: string | null,
  ): Promise<TbankStatementResponse> {
    const params = new URLSearchParams({
      accountNumber,
      from,
      // Только подтверждённые операции: авторизации (холды) в учёт не идут.
      operationStatus: 'Transaction',
      limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set('cursor', cursor);

    const res = await this.http.getJson(`${this.baseUrl()}/v1/statement?${params.toString()}`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Request-Id': randomUUID(),
    });

    if (res.status !== 200) throw httpError(res.status, res.body);
    try {
      return JSON.parse(res.body) as TbankStatementResponse;
    } catch {
      throw new Error('Т-Банк: ответ банка не является JSON');
    }
  }
}

/**
 * Ошибка банка человеческим языком. Текст доезжает до UI интеграций, поэтому
 * тело ответа целиком не тащим — только `errorId`, который банк специально
 * просит логировать для обращений в поддержку.
 */
function httpError(status: number, body: string): Error {
  const known: Record<number, string> = {
    400: 'банк отклонил запрос выписки (проверьте номер счёта)',
    401: 'токен не принят банком (истёк, отозван или скопирован с ошибкой)',
    403: 'у токена нет доступа к выписке — нужны права «Счета и выписки»',
    422: 'банк не смог обработать запрос выписки',
    429: 'банк временно ограничил частоту запросов — синк повторится позже',
  };
  const reason = known[status] ?? `банк ответил HTTP ${status}`;
  const errorId = extractErrorId(body);
  return new Error(`Т-Банк: ${reason}${errorId ? ` (код обращения ${errorId})` : ''}`);
}

function extractErrorId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { errorId?: unknown };
    return typeof parsed.errorId === 'string' ? parsed.errorId.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/**
 * Операция банка → нормализованная строка выписки. null для того, что нельзя
 * учесть: холды, операции без идентификатора, суммы или направления.
 */
export function mapOperation(op: TbankOperation): RawBankLine | null {
  // Перепроверяем статус, даже несмотря на фильтр в запросе: холд, попавший в
  // учёт как проведённая операция, — это ложное движение денег.
  if (op.operationStatus && op.operationStatus !== 'Transaction') return null;

  const externalId = op.operationId;
  if (!externalId) return null;

  // Credit — зачисление на наш счёт, Debit — списание (банк: credit ↔ income,
  // debit ↔ outcome старого API).
  const kind = op.typeOfOperation?.toLowerCase();
  if (kind !== 'credit' && kind !== 'debit') return null;
  const direction = kind === 'credit' ? ('INCOME' as const) : ('EXPENSE' as const);

  const amount = pickAmount(op);
  if (amount === null) return null;

  const date = op.operationDate ? new Date(op.operationDate) : null;
  if (!date || Number.isNaN(date.getTime())) return null;

  // У банка есть готовый блок контрагента; payer/receiver — запасной путь
  // (в некоторых операциях контрагент не заполнен).
  const fallback = direction === 'INCOME' ? op.payer : op.receiver;
  const name = op.counterParty?.name ?? fallback?.name ?? null;
  const inn = op.counterParty?.inn ?? fallback?.inn ?? null;

  return {
    externalId,
    date,
    amount,
    direction,
    counterpartyName: name?.trim() || null,
    counterpartyInn: inn?.trim() || null,
    // payPurpose — назначение платежа из платёжного документа, description —
    // человеческое описание операции; для учёта первое информативнее.
    description: op.payPurpose?.trim() || op.description?.trim() || null,
    ausnMark: null,
    raw: op,
  };
}

/**
 * Сумма в рублях, модулем, строкой с 2 знаками. Для рублёвого счёта берём
 * сумму в валюте счёта, для валютного — рублёвый эквивалент (учёт моновалютный).
 */
function pickAmount(op: TbankOperation): string | null {
  const isRub = op.accountCurrencyDigitalCode === undefined || op.accountCurrencyDigitalCode === '643';
  const raw = isRub
    ? (op.accountAmount ?? op.operationAmount)
    : (op.rubleAmount ?? op.accountAmount ?? op.operationAmount);
  if (raw === undefined || raw === null || raw === '') return null;

  try {
    return money(raw).abs().toFixed(2);
  } catch {
    return null;
  }
}
