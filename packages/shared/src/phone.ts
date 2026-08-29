/**
 * Телефон клиента как видимый номер заказа.
 *
 * В спецификациях номер записан как попало: «+7 924 363 40 29», «89995824268»,
 * «+79505622684», «8 (912) 345-67-89». Для поиска и группировки заказов одного
 * человека нужен единый вид, иначе два его заказа не встретятся: строки-то
 * разные.
 *
 * Канонический вид — «+7XXXXXXXXXX»: одиннадцать цифр, ведущая всегда 7.
 */

/** Российский номер в каноническом виде. */
export type NormalizedPhone = string;

/**
 * Приводит запись телефона к «+7XXXXXXXXXX» либо возвращает null, если это не
 * похоже на российский номер.
 *
 * Восьмёрка и семёрка в начале равнозначны — это одна и та же страна, просто
 * разный способ набора; десятизначная запись (без кода страны) тоже принимается.
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return null;

  let ten: string;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    ten = digits.slice(1);
  } else if (digits.length === 10) {
    ten = digits;
  } else {
    return null;
  }
  // Мобильные и городские РФ начинаются с 3..9; ведущий 0/1/2 — мусор вроде
  // номера договора, случайно попавшего в поле телефона.
  if (!/^[3-9]\d{9}$/.test(ten)) return null;
  return `+7${ten}`;
}

/** Человекочитаемый вид «+7 924 363-40-29» для показа в интерфейсе. */
export function formatPhone(raw: string | null | undefined): string {
  const norm = normalizePhone(raw);
  if (!norm) return raw ?? '';
  const d = norm.slice(2);
  return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`;
}
