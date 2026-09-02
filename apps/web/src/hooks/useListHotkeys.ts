'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Клавиши для экранов-списков: «/» ставит курсор в поиск, «n» открывает форму
 * создания. Работа идёт с клавиатуры — при заведении архива это десятки
 * переходов «найти → создать», и каждый раз тянуться к мыши дорого.
 *
 * Молчит, когда фокус в поле ввода (иначе «n» не напечатать) и когда открыто
 * окно: там свои клавиши, а список за ним не должен на них отвечать. Русская
 * раскладка учтена — «n» на ней даёт «т».
 */
export function useListHotkeys({
  searchRef,
  onNew,
}: {
  searchRef?: RefObject<HTMLInputElement>;
  onNew?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return;
      }
      // Открытое окно или палитра команд забирают клавиатуру себе.
      if (document.querySelector('[role="dialog"]')) return;

      if (e.key === '/' && searchRef?.current) {
        e.preventDefault();
        searchRef.current.focus();
        searchRef.current.select();
        return;
      }
      if ((e.key === 'n' || e.key === 'т' || e.key === 'N' || e.key === 'Т') && onNew) {
        e.preventDefault();
        onNew();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchRef, onNew]);
}
