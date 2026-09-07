/**
 * localStorage без падений: приватный режим и запрет cookies бросают на любом
 * обращении, а это не повод ронять экран. Значение валидируется вызывающим —
 * в хранилище может лежать ключ прошлой версии.
 */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // см. выше
  }
}
