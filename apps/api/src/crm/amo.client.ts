import { Inject, Injectable } from '@nestjs/common';
import { AMO_HTTP, type AmoHttp } from './amo-http';
import { assertHeaderSafe } from '../integrations/adapters/bank-http';
import { pipelineSnapshot, type AmoContact, type AmoLead, type PipelineSnapshot } from './amo-map';

/** Ошибка amo с человеческим текстом — уходит в статус подключения и в тост. */
export class AmoApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AmoApiError';
  }
}

export interface AmoAccount {
  id: number;
  name: string;
  subdomain: string;
}

export interface AmoCredentials {
  subdomain: string;
  token: string;
}

/** Максимум сущностей на страницу у amo. */
export const AMO_PAGE_LIMIT = 250;
/** Сколько id за один запрос контактов: amo принимает до 50 фильтров. */
const CONTACTS_BATCH = 50;

/**
 * Клиент amoCRM API v4 для долгосрочного токена частной интеграции. Один
 * аккаунт — один токен, OAuth-флоу не нужен (факты API проверены 05.09.2026).
 * Секрет никогда не попадает в сообщения об ошибках.
 */
@Injectable()
export class AmoClient {
  constructor(@Inject(AMO_HTTP) private readonly http: AmoHttp) {}

  async account(cred: AmoCredentials): Promise<AmoAccount> {
    const data = await this.get<{ id: number; name: string; subdomain: string }>(cred, '/account');
    if (!data) throw new AmoApiError(0, 'amoCRM не вернул данные аккаунта');
    return { id: data.id, name: data.name, subdomain: data.subdomain };
  }

  async pipelines(cred: AmoCredentials): Promise<PipelineSnapshot[]> {
    const data = await this.get<{
      _embedded?: { pipelines?: Parameters<typeof pipelineSnapshot>[0] };
    }>(cred, '/leads/pipelines');
    return pipelineSnapshot(data?._embedded?.pipelines ?? []);
  }

  /** Имена пользователей по id — для колонки «ответственный». Без прав на users — пусто. */
  async users(cred: AmoCredentials): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const data = await this.get<{ _embedded?: { users?: { id: number; name?: string }[] } }>(
        cred,
        '/users',
        { limit: '250' },
      );
      for (const u of data?._embedded?.users ?? []) map.set(u.id, (u.name ?? '').trim());
    } catch (e) {
      // Права интеграции могут не включать пользователей — это не повод ронять синк.
      if (!(e instanceof AmoApiError && (e.status === 403 || e.status === 401))) throw e;
    }
    return map;
  }

  /** Страница сделок, изменённых с `since` (по возрастанию updated_at). */
  async leadsPage(
    cred: AmoCredentials,
    opts: { since: Date | null; page: number; limit?: number },
  ): Promise<AmoLead[]> {
    const query: Record<string, string> = {
      with: 'contacts',
      limit: String(opts.limit ?? AMO_PAGE_LIMIT),
      page: String(opts.page),
      'order[updated_at]': 'asc',
    };
    if (opts.since)
      query['filter[updated_at][from]'] = String(Math.floor(opts.since.getTime() / 1000));
    const data = await this.get<{ _embedded?: { leads?: AmoLead[] } }>(cred, '/leads', query);
    return data?._embedded?.leads ?? [];
  }

  async contactsByIds(cred: AmoCredentials, ids: number[]): Promise<Map<number, AmoContact>> {
    const map = new Map<number, AmoContact>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CONTACTS_BATCH) {
      const batch = unique.slice(i, i + CONTACTS_BATCH);
      const query: Record<string, string> = { limit: String(CONTACTS_BATCH) };
      batch.forEach((id, idx) => (query[`filter[id][${idx}]`] = String(id)));
      const data = await this.get<{ _embedded?: { contacts?: AmoContact[] } }>(
        cred,
        '/contacts',
        query,
      );
      for (const c of data?._embedded?.contacts ?? []) map.set(c.id, c);
    }
    return map;
  }

  /**
   * GET к API v4. 204 — пустая выборка (amo не отдаёт тело), null.
   * Коды ошибок переводятся в текст для владельца, без технических деталей.
   */
  private async get<T>(
    cred: AmoCredentials,
    path: string,
    query?: Record<string, string>,
  ): Promise<T | null> {
    assertHeaderSafe(cred.token);
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const url = `https://${cred.subdomain}.amocrm.ru/api/v4${path}${qs}`;
    let res;
    try {
      res = await this.http.getJson(url, {
        Authorization: `Bearer ${cred.token}`,
        Accept: 'application/json',
      });
    } catch (e) {
      const reason =
        e instanceof Error && e.name === 'TimeoutError' ? 'не ответил вовремя' : 'недоступен';
      throw new AmoApiError(0, `amoCRM ${reason} — проверьте сеть до ${cred.subdomain}.amocrm.ru`);
    }
    if (res.status === 204) return null;
    if (res.status === 401 || res.status === 403) {
      throw new AmoApiError(
        res.status,
        'amoCRM отклонил токен — перевыпустите долгосрочный токен в «Ключи и доступы» интеграции и вставьте его заново',
      );
    }
    if (res.status === 404) {
      throw new AmoApiError(
        404,
        `amoCRM не нашёл аккаунт «${cred.subdomain}» — проверьте поддомен`,
      );
    }
    if (res.status === 429) {
      throw new AmoApiError(
        429,
        'amoCRM ограничил частоту запросов — синхронизация повторится позже',
      );
    }
    if (res.status >= 500)
      throw new AmoApiError(res.status, `amoCRM недоступен (код ${res.status})`);
    if (res.status >= 400)
      throw new AmoApiError(res.status, `amoCRM ответил ошибкой ${res.status}`);
    if (!res.body) return null;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new AmoApiError(0, 'amoCRM вернул ответ не в формате JSON');
    }
  }
}
