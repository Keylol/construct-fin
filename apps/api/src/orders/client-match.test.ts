import { describe, expect, it } from 'vitest';
import { findClient, normalizeClientName } from '@construct/shared';

const LIST = [
  { id: 'a', name: 'Агеев Валентин Павлович', contact: null },
  { id: 'b', name: 'Кылтасов Валерий Егорович', contact: '+79243634029' },
  { id: 'c', name: 'Фёдоров  Илья   Игоревич', contact: '8 924 363 40 30' },
];

describe('normalizeClientName', () => {
  it('снимает регистр, ё и лишние пробелы', () => {
    expect(normalizeClientName('Фёдоров  Илья   Игоревич')).toBe('федоров илья игоревич');
  });

  it('снимает неразрывный пробел из docx', () => {
    expect(normalizeClientName('Агеев Валентин Павлович')).toBe('агеев валентин павлович');
  });

  it('пустое имя даёт пустую строку', () => {
    expect(normalizeClientName(null)).toBe('');
  });
});

describe('findClient', () => {
  it('находит по имени, когда телефона в карточке нет', () => {
    expect(findClient(LIST, 'Агеев Валентин Павлович', '+79279788951')?.id).toBe('a');
  });

  it('телефон важнее имени: карточка записана иначе', () => {
    expect(findClient(LIST, 'Кылтасов В.Е. (магазин)', '89243634029')?.id).toBe('b');
  });

  it('разное написание ё и двойные пробелы не рождают дубль', () => {
    expect(findClient(LIST, 'Федоров Илья Игоревич', null)?.id).toBe('c');
  });

  it('пустой справочник — ничего не находит', () => {
    expect(findClient([], 'Агеев Валентин Павлович', '+79279788951')).toBeNull();
  });

  it('незнакомый человек — null, форма предложит завести', () => {
    expect(findClient(LIST, 'Новиков Пётр Петрович', '+79000000000')).toBeNull();
  });

  it('мусор вместо телефона не мешает поиску по имени', () => {
    expect(findClient(LIST, 'Агеев Валентин Павлович', 'договор 12')?.id).toBe('a');
  });
});
