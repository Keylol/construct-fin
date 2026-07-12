'use client';

import { useEffect, useState } from 'react';

/** Дебаунс значения — для поиска: запрос уходит после паузы в наборе, а не на каждый символ. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
