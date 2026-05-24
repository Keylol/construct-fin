import { describe, expect, it } from 'vitest';
import { applyRules, type MatchableRule } from './matcher';

const rule = (
  keyword: string,
  categoryId: string,
  priority = 0,
): MatchableRule => ({ keyword, categoryId, priority });

describe('applyRules', () => {
  it('returns null when no rules match', () => {
    expect(applyRules([rule('coffee', 'c1')], { description: 'restaurant bill' })).toBeNull();
  });

  it('returns null when transaction has empty text', () => {
    expect(applyRules([rule('coffee', 'c1')], { description: null, counterpartyName: null })).toBeNull();
  });

  it('matches case-insensitively in description', () => {
    expect(applyRules([rule('COFFEE', 'c1')], { description: 'Starbucks coffee' })).toBe('c1');
  });

  it('matches in counterparty name', () => {
    expect(applyRules([rule('starbucks', 'c1')], { counterpartyName: 'Starbucks Coffee LLC' })).toBe(
      'c1',
    );
  });

  it('higher priority wins over lower', () => {
    const rules = [rule('coffee', 'low', 0), rule('coffee', 'high', 10)];
    expect(applyRules(rules, { description: 'morning coffee' })).toBe('high');
  });

  it('longer keyword wins on tie priority', () => {
    const rules = [rule('star', 'short', 0), rule('starbucks', 'long', 0)];
    expect(applyRules(rules, { description: 'Starbucks chai' })).toBe('long');
  });

  it('priority beats length', () => {
    const rules = [rule('starbucks', 'long-low', 0), rule('star', 'short-high', 5)];
    expect(applyRules(rules, { description: 'Starbucks chai' })).toBe('short-high');
  });

  it('ignores empty keywords', () => {
    const rules = [rule('   ', 'empty', 100), rule('coffee', 'real', 0)];
    expect(applyRules(rules, { description: 'morning coffee' })).toBe('real');
  });

  it('trims keyword whitespace before matching', () => {
    expect(applyRules([rule('  coffee  ', 'c1')], { description: 'morning coffee' })).toBe('c1');
  });
});
