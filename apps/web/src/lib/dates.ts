const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const DATE_TIME_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** 12.07.2026 */
export function formatDate(d: string | Date): string {
  return DATE_FMT.format(typeof d === 'string' ? new Date(d) : d);
}

/** 12.07.2026, 14:05 */
export function formatDateTime(d: string | Date): string {
  return DATE_TIME_FMT.format(typeof d === 'string' ? new Date(d) : d);
}
