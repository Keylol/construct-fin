export interface MatchableRule {
  keyword: string;
  categoryId: string;
  priority: number;
}

export interface MatchableTransaction {
  description?: string | null;
  counterpartyName?: string | null;
}

export function applyRules(
  rules: MatchableRule[],
  tx: MatchableTransaction,
): string | null {
  const haystack = `${tx.description ?? ''} ${tx.counterpartyName ?? ''}`
    .trim()
    .toLowerCase();
  if (!haystack) return null;

  let best: MatchableRule | null = null;
  for (const rule of rules) {
    const needle = rule.keyword.trim().toLowerCase();
    if (!needle) continue;
    if (!haystack.includes(needle)) continue;
    if (
      !best ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && needle.length > best.keyword.trim().length)
    ) {
      best = rule;
    }
  }
  return best?.categoryId ?? null;
}
