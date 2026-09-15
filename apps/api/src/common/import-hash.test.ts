import { describe, expect, it } from 'vitest';
import { computeRowHash } from './import-hash';

const base = {
  workspaceId: 'ws-1',
  accountId: 'acc-1',
  date: new Date('2026-08-20T09:15:00.000Z'),
  amount: '4751',
  type: 'INCOME' as const,
  counterpartyName: '  ООО Ромашка ',
  description: 'Возврат по счёту 65160',
};

describe('computeRowHash', () => {
  it('отпечаток без номера повтора прежний: по нему узнаются операции, уже лежащие в базе', () => {
    const legacy = '91413bbd33a2e7cdddd5fe9959384f2c66449b54f96420194507b9ee22d8ca3b';
    expect(computeRowHash(base)).toBe(legacy);
    expect(computeRowHash({ ...base, occurrence: 1 })).toBe(legacy);
  });

  it('регистр, пробелы по краям и время внутри дня отпечаток не меняют', () => {
    expect(
      computeRowHash({
        ...base,
        date: new Date('2026-08-20T23:59:00.000Z'),
        counterpartyName: 'ооо ромашка',
        description: 'ВОЗВРАТ ПО СЧЁТУ 65160 ',
      }),
    ).toBe(computeRowHash(base));
  });

  it('у близнецов отпечатки разные: второй и третий получают номер повтора', () => {
    const hashes = [1, 2, 3].map((occurrence) => computeRowHash({ ...base, occurrence }));
    expect(new Set(hashes).size).toBe(3);
  });
});
