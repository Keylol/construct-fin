import { describe, expect, it } from 'vitest';
import { __testing__ } from './idempotency.interceptor';

const { hashRequest, stableStringify } = __testing__;

describe('idempotency hashRequest', () => {
  it('hashes identical requests to identical values', () => {
    const a = hashRequest('POST', '/x', { a: 1, b: 'hi' });
    const b = hashRequest('POST', '/x', { a: 1, b: 'hi' });
    expect(a).toBe(b);
  });

  it('is invariant to key order', () => {
    const a = hashRequest('POST', '/x', { a: 1, b: 'hi' });
    const b = hashRequest('POST', '/x', { b: 'hi', a: 1 });
    expect(a).toBe(b);
  });

  it('differs when body differs', () => {
    expect(hashRequest('POST', '/x', { a: 1 })).not.toBe(
      hashRequest('POST', '/x', { a: 2 }),
    );
  });

  it('differs when method differs', () => {
    expect(hashRequest('POST', '/x', { a: 1 })).not.toBe(
      hashRequest('PATCH', '/x', { a: 1 }),
    );
  });

  it('differs when URL differs', () => {
    expect(hashRequest('POST', '/a', { a: 1 })).not.toBe(
      hashRequest('POST', '/b', { a: 1 }),
    );
  });

  it('handles null/undefined body', () => {
    expect(hashRequest('POST', '/x', undefined)).toBe(hashRequest('POST', '/x', null));
  });
});

describe('stableStringify', () => {
  it('sorts object keys', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested objects', () => {
    expect(stableStringify({ b: { y: 2, x: 1 }, a: 1 })).toBe(
      '{"a":1,"b":{"x":1,"y":2}}',
    );
  });
});
