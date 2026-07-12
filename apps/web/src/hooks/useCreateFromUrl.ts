'use client';

import { useEffect } from 'react';

/**
 * Глобальное «+ Создать»: если в URL есть ?new=1, открывает форму создания на
 * маунте и убирает параметр (refresh не переоткроет). Читаем через
 * window.location — без useSearchParams/Suspense, т.к. это разовый триггер.
 */
export function useCreateFromUrl(onOpen: () => void) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('new') !== '1') return;
    onOpen();
    sp.delete('new');
    const qs = sp.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    // Разовый триггер на маунте.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
