'use client';

import { useEffect, useRef, useState } from 'react';
import { formatRub } from '@construct/shared';

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Тикер денег для KPI дашборда (решение №33 блица): цифра «докручивается»
 * 0 → значение за 400мс (ease-out) при появлении данных, и prev → next при
 * их смене. Компонент монтируется ПОСЛЕ загрузки (до того — скелетон), поэтому
 * стартуем с 0 сразу в initial state — вспышки финального значения нет,
 * гидрация не участвует (ветка рендерится только на клиенте с данными).
 *
 * Промежуточные кадры считаются через Number ТОЛЬКО как визуальный эффект;
 * финальный кадр — исходная Decimal-строка без потерь копейки.
 * prefers-reduced-motion → сразу финальное значение, без анимации.
 */
export function AnimatedNumber({ value }: { value: string }) {
  const [display, setDisplay] = useState(() => (reducedMotion() ? value : '0'));
  const prevRef = useRef<string>('0');

  useEffect(() => {
    const target = Number(value);
    if (reducedMotion() || !Number.isFinite(target)) {
      prevRef.current = value;
      setDisplay(value);
      return;
    }
    const from = Number(prevRef.current);
    prevRef.current = value;
    if (!Number.isFinite(from) || from === target) {
      setDisplay(value);
      return;
    }
    const started = performance.now();
    const DURATION = 400;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / DURATION);
      if (t >= 1) {
        // Финал — точная Decimal-строка, копейки не теряются.
        setDisplay(value);
        return;
      }
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay((from + (target - from) * eased).toFixed(2));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{formatRub(display)}</>;
}
