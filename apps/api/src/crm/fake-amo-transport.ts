import { Injectable } from '@nestjs/common';
import type { AmoHttp, AmoHttpResponse } from './amo-http';

/**
 * Подменный amoCRM для NODE_ENV=test (по образцу FakeBankAdapter): отдаёт
 * фиксированный аккаунт, одну воронку с этапами «САЙТ → Проверка → Отправлен →
 * Фото комплектующих» и три сделки — до порога, на пороге с телефоном и
 * закрытую. Функциональные тесты гоняют весь цикл без сети; в production этот
 * транспорт не подключается никогда (см. CrmModule).
 *
 * Токен «bad-token…» отклоняется как 401 — чтобы проверить путь ошибки.
 */
export const FAKE_AMO = {
  subdomain: 'faketest',
  account: { id: 1, name: 'Fake amoCRM', subdomain: 'faketest' },
  pipelineId: 100,
  statuses: {
    site: 1,
    check: 2,
    sent: 3,
    parts: 4,
  },
  leads: {
    beforeThreshold: 1001,
    waiting: 1002,
    won: 1003,
  },
  phone: '+79243634029',
} as const;

const NOW = 1_790_000_000;

@Injectable()
export class FakeAmoTransport implements AmoHttp {
  async getJson(url: string, headers: Record<string, string>): Promise<AmoHttpResponse> {
    const auth = headers.Authorization ?? headers.authorization ?? '';
    if (auth.includes('bad-token')) return { status: 401, body: '{"title":"Unauthorized"}' };
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v4/, '');
    const json = (body: unknown): AmoHttpResponse => ({ status: 200, body: JSON.stringify(body) });

    if (path === '/account') return json(FAKE_AMO.account);
    if (path === '/leads/pipelines') {
      return json({
        _embedded: {
          pipelines: [
            {
              id: FAKE_AMO.pipelineId,
              name: 'Воронка',
              is_main: true,
              _embedded: {
                statuses: [
                  { id: FAKE_AMO.statuses.site, name: 'САЙТ', sort: 10, type: 0 },
                  { id: FAKE_AMO.statuses.check, name: 'Проверка', sort: 20, type: 0 },
                  { id: FAKE_AMO.statuses.sent, name: 'Отправлен', sort: 30, type: 0 },
                  { id: FAKE_AMO.statuses.parts, name: 'Фото комплектующих', sort: 40, type: 0 },
                  { id: 142, name: 'Успешно реализовано', sort: 10000, type: 1 },
                  { id: 143, name: 'Закрыто и не реализовано', sort: 11000, type: 1 },
                ],
              },
            },
          ],
        },
      });
    }
    if (path === '/users') return json({ _embedded: { users: [{ id: 9, name: 'Илья' }] } });
    if (path === '/leads') {
      // Вторая страница пуста — amo отвечает 204 без тела.
      if (u.searchParams.get('page') !== '1') return { status: 204, body: '' };
      const lead = (
        id: number,
        name: string,
        price: number,
        status: number,
        contact: number | null,
        extra: object = {},
      ) => ({
        id,
        name,
        price,
        status_id: status,
        pipeline_id: FAKE_AMO.pipelineId,
        responsible_user_id: 9,
        created_at: NOW - 86_400,
        updated_at: NOW - 3_600 + id,
        closed_at: null,
        custom_fields_values: [
          { field_name: 'Пожелания по сборке', values: [{ value: 'под игры, белый корпус' }] },
        ],
        _embedded: { contacts: contact ? [{ id: contact, is_main: true }] : [] },
        ...extra,
      });
      return json({
        _embedded: {
          leads: [
            lead(
              FAKE_AMO.leads.beforeThreshold,
              'Лид с сайта',
              120000,
              FAKE_AMO.statuses.check,
              501,
            ),
            lead(
              FAKE_AMO.leads.waiting,
              'Донгак Алдын-Херел (Р)',
              150198,
              FAKE_AMO.statuses.parts,
              502,
            ),
            lead(FAKE_AMO.leads.won, 'Старый клиент', 90000, 142, null, { closed_at: NOW - 7_200 }),
          ],
        },
      });
    }
    if (path === '/contacts') {
      return json({
        _embedded: {
          contacts: [
            { id: 501, name: 'Без телефона', custom_fields_values: [] },
            {
              id: 502,
              name: 'Донгак Алдын-Херел',
              custom_fields_values: [
                {
                  field_code: 'PHONE',
                  field_name: 'Телефон',
                  values: [{ value: '8 (924) 363-40-29', enum_code: 'WORK' }],
                },
              ],
            },
          ],
        },
      });
    }
    return { status: 404, body: '{}' };
  }
}
