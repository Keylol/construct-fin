/**
 * «Открыть общий поиск» из любого места: поле на Главной открывает ту же
 * палитру, что ⌘K, без прокидывания состояния через каркас. Палитра живёт в
 * AppShell и слушает это событие.
 */
export const OPEN_GLOBAL_SEARCH_EVENT = 'construct:open-global-search';

export function openGlobalSearch(): void {
  window.dispatchEvent(new Event(OPEN_GLOBAL_SEARCH_EVENT));
}
