import { describe, it, expect } from 'vitest';
import { CreateCounterpartySchema, UpdateCounterpartySchema } from './counterparty.dto';

// #25: ИНН валидируется как 10 или 12 цифр (а не просто «≤12 символов»).
describe('Counterparty inn validation', () => {
  it('accepts 10-digit inn (юрлицо)', () => {
    expect(CreateCounterpartySchema.safeParse({ name: 'ООО', inn: '7707083893' }).success).toBe(true);
  });

  it('accepts 12-digit inn (физлицо/ИП)', () => {
    expect(CreateCounterpartySchema.safeParse({ name: 'ИП', inn: '500100732259' }).success).toBe(true);
  });

  it('rejects inn with wrong length (11 цифр)', () => {
    expect(CreateCounterpartySchema.safeParse({ name: 'X', inn: '12345678901' }).success).toBe(false);
  });

  it('rejects inn with non-digits', () => {
    expect(CreateCounterpartySchema.safeParse({ name: 'X', inn: '12345abcde' }).success).toBe(false);
  });

  it('inn остаётся необязательным в Create', () => {
    expect(CreateCounterpartySchema.safeParse({ name: 'X' }).success).toBe(true);
  });

  it('Update сохраняет nullable + optional для inn', () => {
    expect(UpdateCounterpartySchema.safeParse({ inn: null }).success).toBe(true);
    expect(UpdateCounterpartySchema.safeParse({}).success).toBe(true);
    expect(UpdateCounterpartySchema.safeParse({ inn: '7707083893' }).success).toBe(true);
    expect(UpdateCounterpartySchema.safeParse({ inn: '123' }).success).toBe(false);
  });
});
