/**
 * Ф5. Чистый билдер текста напоминания о платежах для Telegram. Вынесен из
 * крон-сервиса, чтобы покрыть форматирование юнит-тестом без БД/сети.
 */

export interface DigestItem {
  title: string;
  amount: string; // «30000.00»
  dueDate: string; // ISO (полдень бизнес-дня)
  dueInDays: number;
  overdue: boolean;
  soon: boolean;
  counterpartyName: string | null;
}

/** ISO → «DD.MM.YYYY» по календарной дате (dueDate уже канонично на полдень). */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** «30000.00» → «30 000.00» (тонкая читабельность, без locale-зависимостей). */
function fmtAmount(a: string): string {
  const [int, frac] = a.split('.');
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * Дайджест по одному пространству: просроченные + «горящие» (soon). Возвращает
 * null, если напоминать не о чем (крон тогда молчит по этому пространству).
 */
export function buildPlanningDigest(workspaceName: string, items: DigestItem[]): string | null {
  const overdue = items.filter((i) => i.overdue);
  const soon = items.filter((i) => i.soon);
  if (overdue.length === 0 && soon.length === 0) return null;

  const lines: string[] = [`🗓 Платежи — ${workspaceName}`];

  if (overdue.length > 0) {
    lines.push('', `⚠️ Просрочено (${overdue.length}):`);
    for (const i of overdue) {
      const who = i.counterpartyName ? `, ${i.counterpartyName}` : '';
      lines.push(`• ${i.title} — ${fmtAmount(i.amount)} ₽ (${Math.abs(i.dueInDays)} дн. назад${who})`);
    }
  }

  if (soon.length > 0) {
    lines.push('', `🔔 Скоро (${soon.length}):`);
    for (const i of soon) {
      const when = i.dueInDays === 0 ? 'сегодня' : `через ${i.dueInDays} дн.`;
      const who = i.counterpartyName ? `, ${i.counterpartyName}` : '';
      lines.push(`• ${i.title} — ${fmtAmount(i.amount)} ₽ (${when}, ${fmtDate(i.dueDate)}${who})`);
    }
  }

  return lines.join('\n');
}
