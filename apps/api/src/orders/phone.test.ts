import { describe, it, expect } from 'vitest';
import { normalizePhone, formatPhone } from '@construct/shared';

describe('телефон как номер заказа', () => {
  it('принимает все формы записи из спецификаций', () => {
    // Ровно те варианты, что встречаются в docx на Я.Диске.
    expect(normalizePhone('+7 924 363 40 29')).toBe('+79243634029');
    expect(normalizePhone('89995824268')).toBe('+79995824268');
    expect(normalizePhone('+79505622684')).toBe('+79505622684');
    expect(normalizePhone('8 (912) 345-67-89')).toBe('+79123456789');
    expect(normalizePhone('9243634029')).toBe('+79243634029');
  });

  it('одна и та же запись в разных видах даёт один номер', () => {
    const forms = ['89243634029', '+7 924 363 40 29', '7-924-363-40-29', '9243634029'];
    expect(new Set(forms.map(normalizePhone)).size).toBe(1);
  });

  it('мусор в поле телефона отвергается', () => {
    // Номер договора и обрывки не должны стать «номером заказа».
    expect(normalizePhone('56650/26')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('0243634029')).toBeNull();
  });

  it('показывается человеку с разделителями', () => {
    expect(formatPhone('89243634029')).toBe('+7 924 363-40-29');
  });
});
