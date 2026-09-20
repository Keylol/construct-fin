import { normalizePhone } from '@construct/shared';

/**
 * Чистое отображение сущностей amoCRM в снимок сделки (CrmDeal). Без сети и
 * без БД — чтобы правила чтения amo проверялись юнитами.
 */

/** Системные этапы amo, одинаковые во всех воронках. */
export const AMO_STATUS_WON = 142;
export const AMO_STATUS_LOST = 143;

export interface AmoStatus {
  id: number;
  name: string;
  sort: number;
  /** 0 — обычный этап, 1 — системный (успех/провал). */
  type: number;
  pipelineId: number;
  pipelineName: string;
}

/** Снимок воронок, который храним на подключении (CrmConnection.pipelines). */
export interface PipelineSnapshot {
  id: number;
  name: string;
  isMain: boolean;
  statuses: { id: number; name: string; sort: number; type: number }[];
}

export interface AmoCustomField {
  field_id?: number;
  field_name?: string;
  field_code?: string | null;
  values?: { value?: unknown; enum_code?: string }[];
}

export interface AmoLead {
  id: number;
  name?: string;
  price?: number | null;
  status_id: number;
  pipeline_id: number;
  responsible_user_id?: number | null;
  created_at: number;
  updated_at: number;
  closed_at?: number | null;
  custom_fields_values?: AmoCustomField[] | null;
  _embedded?: { contacts?: { id: number; is_main?: boolean }[] };
}

export interface AmoContact {
  id: number;
  name?: string;
  custom_fields_values?: AmoCustomField[] | null;
}

/** Поля сделки, которые кладём в `wishes` при заведении заказа. */
const WISH_FIELDS = ['Пожелания по сборке', 'Гарантия', 'Сроки покупки'];

export interface MappedDeal {
  externalId: number;
  name: string;
  price: string;
  pipelineId: number;
  pipelineName: string;
  statusId: number;
  statusName: string;
  statusSort: number;
  isClosed: boolean;
  isWon: boolean;
  responsibleName: string | null;
  contactName: string | null;
  phone: string | null;
  wishes: string | null;
  remoteCreatedAt: Date;
  remoteUpdatedAt: Date;
  remoteClosedAt: Date | null;
}

const fieldText = (f: AmoCustomField): string =>
  (f.values ?? [])
    .map((v) => (v.value == null ? '' : String(v.value).trim()))
    .filter(Boolean)
    .join('; ');

/** Телефон контакта: первое значение поля с кодом PHONE, приведённое к «+7…». */
export function contactPhone(contact: AmoContact | undefined): string | null {
  if (!contact) return null;
  for (const f of contact.custom_fields_values ?? []) {
    if (f.field_code !== 'PHONE') continue;
    for (const v of f.values ?? []) {
      const phone = normalizePhone(v.value == null ? '' : String(v.value));
      if (phone) return phone;
    }
  }
  return null;
}

/** Основной контакт сделки (is_main), иначе первый. */
export function mainContactId(lead: AmoLead): number | null {
  const list = lead._embedded?.contacts ?? [];
  const main = list.find((c) => c.is_main) ?? list[0];
  return main?.id ?? null;
}

export function pipelineSnapshot(
  raw: {
    id: number;
    name: string;
    is_main?: boolean;
    _embedded?: { statuses?: { id: number; name: string; sort: number; type: number }[] };
  }[],
): PipelineSnapshot[] {
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    isMain: !!p.is_main,
    statuses: (p._embedded?.statuses ?? [])
      .map((s) => ({ id: s.id, name: s.name, sort: s.sort, type: s.type }))
      .sort((a, b) => a.sort - b.sort),
  }));
}

export function statusIndex(pipelines: PipelineSnapshot[]): Map<number, AmoStatus> {
  const m = new Map<number, AmoStatus>();
  for (const p of pipelines) {
    for (const s of p.statuses) {
      m.set(s.id, { ...s, pipelineId: p.id, pipelineName: p.name });
    }
  }
  return m;
}

export function mapLead(
  lead: AmoLead,
  statuses: Map<number, AmoStatus>,
  contacts: Map<number, AmoContact>,
  users: Map<number, string>,
): MappedDeal {
  const status = statuses.get(lead.status_id);
  const contactId = mainContactId(lead);
  const contact = contactId != null ? contacts.get(contactId) : undefined;
  const wishes = (lead.custom_fields_values ?? [])
    .filter((f) => f.field_name && WISH_FIELDS.includes(f.field_name))
    .map((f) => {
      const text = fieldText(f);
      return text ? `${f.field_name}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
  const isWon = lead.status_id === AMO_STATUS_WON;
  const isLost = lead.status_id === AMO_STATUS_LOST;
  return {
    externalId: lead.id,
    name: (lead.name ?? '').trim() || `Сделка #${lead.id}`,
    // amo хранит бюджет целыми рублями; в учёте деньги — строка с 2 знаками.
    price: (Number(lead.price ?? 0) || 0).toFixed(2),
    pipelineId: lead.pipeline_id,
    pipelineName: status?.pipelineName ?? '',
    statusId: lead.status_id,
    statusName:
      status?.name ?? (isWon ? 'Успешно реализовано' : isLost ? 'Закрыто и не реализовано' : ''),
    // Системные этапы стоят в конце воронки; если снимок этапов не знает
    // статус, ставим ему запредельный порядок, чтобы порог его не ловил.
    statusSort: status?.sort ?? (isWon || isLost ? 10_000 : 0),
    isClosed: isWon || isLost || status?.type === 1,
    isWon,
    responsibleName:
      lead.responsible_user_id != null ? (users.get(lead.responsible_user_id) ?? null) : null,
    contactName: contact?.name?.trim() || null,
    phone: contactPhone(contact),
    wishes: wishes || null,
    remoteCreatedAt: new Date(lead.created_at * 1000),
    remoteUpdatedAt: new Date(lead.updated_at * 1000),
    remoteClosedAt: lead.closed_at ? new Date(lead.closed_at * 1000) : null,
  };
}

/**
 * Сделка «ждёт заказа»: открыта, не привязана, не отложена, в наблюдаемой
 * воронке и на одном из выбранных этапов. Набор пуст — считается любая открытая.
 * Именно набор, а не порог «с этапа и дальше»: на доске владельца сервисные
 * этапы (Гарантия, Проверка, Отложенная покупка) стоят после «Отправлен».
 */
export function isWaiting(
  deal: {
    isClosed: boolean;
    orderId: string | null;
    dismissedAt: Date | null;
    pipelineId: number;
    statusId: number;
  },
  conn: { pipelineId: number | null; waitingStatusIds: number[] },
): boolean {
  if (deal.isClosed || deal.orderId || deal.dismissedAt) return false;
  if (conn.pipelineId != null && deal.pipelineId !== conn.pipelineId) return false;
  if (conn.waitingStatusIds.length > 0 && !conn.waitingStatusIds.includes(deal.statusId))
    return false;
  return true;
}
