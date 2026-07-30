import { D } from '../common/money';

/**
 * Движок правил «условие → действие» (конфигурируемость Блок 1, обобщение
 * CategoryRule). Чистая функция БЕЗ БД/побочных эффектов — только СОПОСТАВЛЯЕТ
 * контекст операции с правилами и возвращает, что подставить.
 *
 * Сам движок денег не двигает, но его РЕЗУЛЬТАТ двигает: в ручной форме и в
 * превью импорта это подсказка, которую подтверждает человек, а в банк-синке
 * распознанная строка проводится сразу (`AUTO_POSTED`, см. sync.service.ts) —
 * так задумано мастер-планом «авто-проводки + Inbox остатка». Обратимость даёт
 * вкладка «Проведено правилами» во «Входящих» и откат (undo / undo-bulk).
 *
 * Условия и действия — из ФИКСИРОВАННОГО словаря (не произвольный код/DSL): это
 * держит фичу в Тир-1 безопасности (нельзя испортить деньги конфигом). Условия
 * комбинируются по И: правило срабатывает, только если ВСЕ его условия истинны.
 */

export type RuleCondition =
  | { type: 'DESCRIPTION_CONTAINS'; value: string }
  | { type: 'COUNTERPARTY_EQUALS'; counterpartyId: string }
  | { type: 'COUNTERPARTY_INN_IN'; values: string[] }
  | { type: 'ACCOUNT_EQUALS'; accountId: string }
  | { type: 'TYPE_EQUALS'; value: 'INCOME' | 'EXPENSE' }
  | { type: 'AMOUNT_RANGE'; min?: string | null; max?: string | null }
  | { type: 'SOURCE_EQUALS'; value: 'IMPORT' | 'MANUAL' };

export type RuleAction =
  | { type: 'SET_CATEGORY'; categoryId: string }
  | { type: 'SET_COUNTERPARTY'; counterpartyId: string }
  | { type: 'SET_ACCOUNT'; accountId: string };

export interface RuleDef {
  id: string;
  name: string;
  priority: number;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

/** Контекст оцениваемой операции (частично заполненная форма / строка импорта). */
export interface RuleContext {
  description?: string | null;
  counterpartyId?: string | null;
  /** Имя контрагента (импорт даёт имя, не id) — для текстового условия. */
  counterpartyName?: string | null;
  /**
   * ИНН контрагента из выписки. Самый устойчивый признак для категоризации:
   * наименование и назначение банк форматирует как придётся («ООО "Ромашка"»,
   * «ООО РОМАШКА», с городом и без), а ИНН у одного контрагента всегда один.
   */
  counterpartyInn?: string | null;
  accountId?: string | null;
  amount?: string | null;
  type?: 'INCOME' | 'EXPENSE' | null;
  source: 'IMPORT' | 'MANUAL';
}

/** Что подставить + какие правила сработали (для подсветки «применено правило X»). */
export interface RuleSuggestion {
  categoryId?: string;
  counterpartyId?: string;
  accountId?: string;
  /**
   * Правило, давшее категорию. Именно оно превращает строку выписки в проводку, и
   * именно его надо знать, чтобы потом ревизовать и откатить результат конкретного
   * правила. `matchedRuleIds` для этого не годится — там все сработавшие.
   */
  categoryRuleId?: string;
  matchedRuleIds: string[];
}

/**
 * ИНН сравниваем по одним цифрам: банки отдают его то с пробелами, то пустой строкой
 * вместо null, а пользователь копирует значение откуда придётся (из выписки, из карточки
 * контрагента, из письма). Незначащее форматирование не должно ломать правило.
 */
function digitsOnly(raw?: string | null): string {
  return (raw ?? '').replace(/\D/g, '');
}

function matchesCondition(c: RuleCondition, ctx: RuleContext): boolean {
  switch (c.type) {
    case 'DESCRIPTION_CONTAINS': {
      // Ищем в описании И имени контрагента (как исходный matcher): импорт часто
      // кладёт назначение в оба поля.
      const haystack = `${ctx.description ?? ''} ${ctx.counterpartyName ?? ''}`
        .trim()
        .toLowerCase();
      const needle = c.value.trim().toLowerCase();
      return !!needle && haystack.includes(needle);
    }
    case 'COUNTERPARTY_EQUALS':
      return !!ctx.counterpartyId && ctx.counterpartyId === c.counterpartyId;
    case 'COUNTERPARTY_INN_IN': {
      // Список, а не одно значение: ИЛИ внутри правила нет, а одна категория обычно
      // собирает нескольких контрагентов («Закупка товара» — все поставщики). Иначе
      // на каждого поставщика пришлось бы заводить отдельное правило.
      const inn = digitsOnly(ctx.counterpartyInn);
      return !!inn && c.values.some((v) => digitsOnly(v) === inn);
    }
    case 'ACCOUNT_EQUALS':
      return !!ctx.accountId && ctx.accountId === c.accountId;
    case 'TYPE_EQUALS':
      return !!ctx.type && ctx.type === c.value;
    case 'AMOUNT_RANGE': {
      if (ctx.amount == null || ctx.amount === '') return false;
      const hasMin = c.min != null && c.min !== '';
      const hasMax = c.max != null && c.max !== '';
      if (!hasMin && !hasMax) return false; // без границ — не матчим (DTO это тоже не даст)
      const amt = D(ctx.amount).abs(); // сравниваем по модулю (знак несёт type)
      if (hasMin && amt.lessThan(D(c.min!).abs())) return false;
      if (hasMax && amt.greaterThan(D(c.max!).abs())) return false;
      return true;
    }
    case 'SOURCE_EQUALS':
      return ctx.source === c.value;
    default:
      return false;
  }
}

/** Правило срабатывает, только если ВСЕ его условия истинны (И). Пустой набор
 * условий НЕ срабатывает (защита от «правило на всё»; DTO это тоже запрещает).
 *
 * Экспортируется ради предпросмотра («сколько строк зацепит черновик правила»):
 * там нужен именно матчинг без действий, и второй реализации быть не должно. */
export function ruleMatches(
  rule: Pick<RuleDef, 'conditions'>,
  ctx: RuleContext,
): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => matchesCondition(c, ctx));
}

/**
 * Прогоняет контекст через правила и собирает подсказки. Правила выше по priority
 * применяются первыми; при конфликте действий на одно поле выигрывает первое
 * (более приоритетное) правило — остальные для этого поля игнорируются.
 */
export function applyRules(rules: RuleDef[], ctx: RuleContext): RuleSuggestion {
  // priority desc; при равном priority — по id (детерминизм между сессиями,
  // не зависит от порядка выборки из БД).
  const ordered = [...rules].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const out: RuleSuggestion = { matchedRuleIds: [] };
  for (const rule of ordered) {
    if (!ruleMatches(rule, ctx)) continue;
    let used = false;
    for (const action of rule.actions) {
      switch (action.type) {
        case 'SET_CATEGORY':
          if (out.categoryId === undefined) {
            out.categoryId = action.categoryId;
            out.categoryRuleId = rule.id;
            used = true;
          }
          break;
        case 'SET_COUNTERPARTY':
          if (out.counterpartyId === undefined) {
            out.counterpartyId = action.counterpartyId;
            used = true;
          }
          break;
        case 'SET_ACCOUNT':
          if (out.accountId === undefined) {
            out.accountId = action.accountId;
            used = true;
          }
          break;
      }
    }
    if (used) out.matchedRuleIds.push(rule.id);
  }
  return out;
}
