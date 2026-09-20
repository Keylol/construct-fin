import { describe, it, expect } from 'vitest';
import {
  contactPhone,
  isWaiting,
  mapLead,
  pipelineSnapshot,
  statusIndex,
  type AmoContact,
  type AmoLead,
} from './amo-map';

/**
 * Чтение amo без сети: телефон контакта → «+7…», этапы → порядок и закрытость,
 * порог «ждёт заказа» (решение владельца: с этапа «Отправлен»).
 */

const PIPELINES = pipelineSnapshot([
  {
    id: 100,
    name: 'Воронка',
    is_main: true,
    _embedded: {
      statuses: [
        { id: 1, name: 'САЙТ', sort: 10, type: 0 },
        { id: 2, name: 'Проверка', sort: 20, type: 0 },
        { id: 3, name: 'Отправлен', sort: 30, type: 0 },
        { id: 4, name: 'Фото комплектующих', sort: 40, type: 0 },
        { id: 142, name: 'Успешно реализовано', sort: 10000, type: 1 },
        { id: 143, name: 'Закрыто и не реализовано', sort: 11000, type: 1 },
      ],
    },
  },
]);
const STATUSES = statusIndex(PIPELINES);

const contact = (phone: string | null, name = 'Донгак Алдын-Херел'): AmoContact => ({
  id: 7,
  name,
  custom_fields_values: phone
    ? [
        {
          field_code: 'PHONE',
          field_name: 'Телефон',
          values: [{ value: phone, enum_code: 'WORK' }],
        },
      ]
    : [],
});

const lead = (over: Partial<AmoLead> = {}): AmoLead => ({
  id: 52085551,
  name: 'Донгак Алдын-Херел Хураган-оолович(Р)',
  price: 150198,
  status_id: 4,
  pipeline_id: 100,
  responsible_user_id: 9,
  created_at: 1789800000,
  updated_at: 1789900000,
  closed_at: null,
  custom_fields_values: [
    { field_name: 'Пожелания по сборке', values: [{ value: 'на выбор. белый вариант.' }] },
    { field_name: 'Гарантия', values: [{ value: 'Старт 12 мес.' }] },
    { field_name: 'utm_source', values: [{ value: 'google' }] },
  ],
  _embedded: { contacts: [{ id: 7, is_main: true }] },
  ...over,
});

describe('contactPhone', () => {
  it('берёт первое значение поля PHONE и приводит к «+7…»', () => {
    expect(contactPhone(contact('8 (924) 363-40-29'))).toBe('+79243634029');
  });
  it('без поля PHONE или с мусором — null', () => {
    expect(contactPhone(contact(null))).toBeNull();
    expect(contactPhone(contact('нет телефона'))).toBeNull();
    expect(contactPhone(undefined)).toBeNull();
  });
});

describe('mapLead', () => {
  it('переносит бюджет как деньги с 2 знаками, этап, контакт и пожелания', () => {
    const d = mapLead(
      lead(),
      STATUSES,
      new Map([[7, contact('+7 924 363 40 29')]]),
      new Map([[9, 'Илья']]),
    );
    expect(d.externalId).toBe(52085551);
    expect(d.price).toBe('150198.00');
    expect(d.pipelineName).toBe('Воронка');
    expect(d.statusName).toBe('Фото комплектующих');
    expect(d.statusSort).toBe(40);
    expect(d.isClosed).toBe(false);
    expect(d.responsibleName).toBe('Илья');
    expect(d.contactName).toBe('Донгак Алдын-Херел');
    expect(d.phone).toBe('+79243634029');
    // utm-поля в пожелания не попадают — только то, что нужно при заведении заказа.
    expect(d.wishes).toBe('Пожелания по сборке: на выбор. белый вариант.\nГарантия: Старт 12 мес.');
    expect(d.remoteCreatedAt.toISOString()).toBe(new Date(1789800000 * 1000).toISOString());
  });

  it('системные этапы 142/143 — закрытые, без снимка этапов тоже', () => {
    const won = mapLead(
      lead({ status_id: 142, closed_at: 1789950000 }),
      STATUSES,
      new Map(),
      new Map(),
    );
    expect(won.isClosed).toBe(true);
    expect(won.isWon).toBe(true);
    expect(won.remoteClosedAt?.getTime()).toBe(1789950000 * 1000);
    const lost = mapLead(lead({ status_id: 143 }), new Map(), new Map(), new Map());
    expect(lost.isClosed).toBe(true);
    expect(lost.isWon).toBe(false);
    expect(lost.statusName).toBe('Закрыто и не реализовано');
  });

  it('пустое имя и бюджет не роняют разбор', () => {
    const d = mapLead(
      lead({ name: '', price: null, custom_fields_values: null, _embedded: {} }),
      STATUSES,
      new Map(),
      new Map(),
    );
    expect(d.name).toBe('Сделка #52085551');
    expect(d.price).toBe('0.00');
    expect(d.phone).toBeNull();
    expect(d.wishes).toBeNull();
  });
});

describe('isWaiting — набор этапов «ждут заказа»', () => {
  const conn = { pipelineId: 100, waitingStatusIds: [3, 4] };
  const base = { isClosed: false, orderId: null, dismissedAt: null, pipelineId: 100, statusId: 3 };

  it('на выбранном этапе — ждёт', () => {
    expect(isWaiting(base, conn)).toBe(true);
    expect(isWaiting({ ...base, statusId: 4 }, conn)).toBe(true);
  });
  it('на невыбранном этапе, закрытая, привязанная, отложенная или из другой воронки — нет', () => {
    // Этап после «Отправлен» по порядку доски (сервисный) не считается: набор, а не порог.
    expect(isWaiting({ ...base, statusId: 2 }, conn)).toBe(false);
    expect(isWaiting({ ...base, statusId: 5 }, conn)).toBe(false);
    expect(isWaiting({ ...base, isClosed: true }, conn)).toBe(false);
    expect(isWaiting({ ...base, orderId: 'ord' }, conn)).toBe(false);
    expect(isWaiting({ ...base, dismissedAt: new Date() }, conn)).toBe(false);
    expect(isWaiting({ ...base, pipelineId: 200 }, conn)).toBe(false);
  });
  it('пустой набор и без воронки — любая открытая непривязанная', () => {
    expect(
      isWaiting(
        { ...base, statusId: 1, pipelineId: 200 },
        { pipelineId: null, waitingStatusIds: [] },
      ),
    ).toBe(true);
  });
});
