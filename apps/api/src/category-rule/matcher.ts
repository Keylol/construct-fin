/**
 * @deprecated Заменён движком правил (apps/api/src/rule/engine.ts). Импорт теперь
 * берёт подсказки категории из единого движка Rule (см. import.service.ts), а
 * исторические CategoryRule перенесены в Rule миграцией
 * 20260704130000_migrate_category_rules_to_rules. Файл сохранён как справочный/для
 * существующих тестов CategoryRuleService; в проде путь мёртв. Удалить отдельным
 * cleanup-PR после обкатки движка.
 */
export interface MatchableRule {
  keyword: string;
  categoryId: string;
  priority: number;
  /** kind категории правила. Если задан и у транзакции тоже — должны совпасть. */
  kind?: 'INCOME' | 'EXPENSE' | null;
}

export interface MatchableTransaction {
  description?: string | null;
  counterpartyName?: string | null;
  /** kind транзакции. Если задан — правило другого kind не применяется. */
  kind?: 'INCOME' | 'EXPENSE' | null;
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
    // Не применяем правило расходной категории к доходной транзакции (и наоборот).
    // Фильтруем только когда kind известен с обеих сторон.
    if (tx.kind && rule.kind && rule.kind !== tx.kind) continue;
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
