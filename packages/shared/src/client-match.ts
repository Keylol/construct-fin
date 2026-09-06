/**
 * Поиск клиента в справочнике по имени и телефону из спецификации.
 *
 * Форма заказа предлагает «Завести клиента», когда заказчика из документа нет в
 * справочнике. Если поиск промахнётся, на прод уедет второй карточкой тот же
 * человек — так и появились десять дублей при заведении архивов 29.08 и 05.09.
 *
 * Две причины промаха, которые здесь закрыты:
 *  1) справочник ещё не загрузился — сравнивать было не с чем;
 *  2) имя записано иначе по мелочи: «ё» против «е», двойной пробел,
 *     неразрывный пробел из docx.
 */

import { normalizePhone } from './phone';

export interface ClientCandidate {
  id: string;
  name: string;
  /** Контакт карточки — обычно телефон, но может быть и почта. */
  contact?: string | null;
}

/**
 * Имя для сравнения: регистр, «ё» и любые пробельные разделители не должны
 * рождать второго «Агеева Валентина Павловича».
 */
export function normalizeClientName(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/ /g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

/**
 * Ищет клиента сперва по телефону, затем по имени: люди приходят повторно, а
 * имя в справочнике может быть записано иначе («Иванов И.И.», с пометкой
 * магазина). Телефон — надёжнее.
 */
export function findClient(
  list: readonly ClientCandidate[],
  name: string | null | undefined,
  phone: string | null | undefined,
): ClientCandidate | null {
  const wantPhone = normalizePhone(phone);
  if (wantPhone) {
    const byPhone = list.find((c) => c.contact && normalizePhone(c.contact) === wantPhone);
    if (byPhone) return byPhone;
  }
  const wantName = normalizeClientName(name);
  if (!wantName) return null;
  return list.find((c) => normalizeClientName(c.name) === wantName) ?? null;
}
