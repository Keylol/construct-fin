import { describe, expect, it } from 'vitest';
import { periodKeyFor } from './period.service';

describe('periodKeyFor', () => {
  it('returns 1-based month from UTC date', () => {
    expect(periodKeyFor(new Date('2026-01-15T12:00:00Z'))).toEqual({ year: 2026, month: 1 });
    expect(periodKeyFor(new Date('2026-12-31T23:00:00Z'))).toEqual({ year: 2026, month: 12 });
  });

  it('crosses year boundary correctly', () => {
    expect(periodKeyFor(new Date('2025-12-31T23:59:59Z'))).toEqual({ year: 2025, month: 12 });
    expect(periodKeyFor(new Date('2026-01-01T00:00:01Z'))).toEqual({ year: 2026, month: 1 });
  });
});
