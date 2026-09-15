'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Пара «разобрать из URL / собрать в URL» для фильтров списка. Кодек пишет
 * экран: какие ключи, как валидировать мусор из адреса, что по умолчанию.
 */
export interface UrlCodec<T> {
  /** Ключи адреса, которыми владеет этот кодек — при записи они перезаписываются или снимаются. */
  keys: readonly string[];
  parse: (sp: URLSearchParams) => T;
  serialize: (value: T) => URLSearchParams;
}

/** Сколько своих ещё не дошедших до адреса записей помним — с запасом на быстрый набор. */
const MAX_PENDING = 20;

/**
 * Состояние фильтров списка в адресе страницы.
 *
 * Зачем: разрез списка (период, счёт, статус, поиск) должен переживать
 * перезагрузку и уходить ссылкой — так работает drill-down из отчётов в
 * операции. До этого адрес умели только «Операции», остальные экраны держали
 * фильтры в useState и теряли их на F5.
 *
 * Читается на маунте, дальше состояние ведёт экран, а в адрес оно пишется
 * `replace`-ом без прокрутки — клики по фильтрам не засоряют историю браузера.
 * Параметры, которых кодек не знает (например, `?order=` открытого окна),
 * сохраняются как есть.
 *
 * Если адрес поменяли снаружи, пока экран открыт, — ссылкой на тот же экран,
 * «Показать все» из общего поиска, «назад» в браузере — фильтры перечитываются
 * из адреса. Свои записи отличаем по очереди `pending`: `replace` доходит до
 * адреса не сразу, и без неё быстрый набор в поиске откатывался бы к старому
 * значению.
 *
 * Требует Suspense-границы вокруг страницы (useSearchParams в Next 14).
 */
export function useUrlFilters<T>(codec: UrlCodec<T>): [T, (next: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState<T>(() => codec.parse(searchParams));

  const ownOf = useCallback(
    (sp: URLSearchParams) => codec.keys.map((k) => `${k}=${sp.get(k) ?? ''}`).join('&'),
    [codec],
  );
  const inUrl = ownOf(searchParams);
  const seen = useRef(inUrl);
  const pending = useRef<string[]>([]);

  useEffect(() => {
    if (inUrl === seen.current) return;
    seen.current = inUrl;
    const mine = pending.current.indexOf(inUrl);
    if (mine !== -1) {
      // Дошла наша же запись — состояние её уже содержит.
      pending.current = pending.current.slice(mine + 1);
      return;
    }
    pending.current = [];
    setValue(codec.parse(searchParams));
  }, [inUrl, codec, searchParams]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      const own = codec.serialize(next);
      // Чужие параметры (окно карточки, ?new=1) переносим нетронутыми, свои —
      // снимаем и пишем заново: снятый фильтр не должен остаться в адресе.
      const merged = new URLSearchParams();
      searchParams.forEach((v, k) => {
        if (!codec.keys.includes(k)) merged.set(k, v);
      });
      own.forEach((v, k) => merged.set(k, v));
      const written = ownOf(merged);
      if (written !== seen.current) {
        pending.current = [...pending.current, written].slice(-MAX_PENDING);
      }
      const qs = merged.toString();
      router.replace((qs ? `${pathname}?${qs}` : pathname) as Parameters<typeof router.replace>[0], {
        scroll: false,
      });
    },
    [codec, ownOf, pathname, router, searchParams],
  );

  return [value, set];
}
