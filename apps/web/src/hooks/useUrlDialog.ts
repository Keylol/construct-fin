'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Адрес открытого окна для крупных сущностей — заказа, закупки.
 *
 * Зачем: карточка заказа живёт минутами (позиции, оплаты, склад), и без адреса
 * её нельзя перезагрузить, положить в закладку или скинуть ссылкой, а «назад» в
 * браузере уводит со страницы целиком вместо закрытия окна.
 *
 *   const order = useUrlDialog('order');
 *   <OrderDetailModal orderId={order.value} onClose={order.close} />
 *   <Tile onClick={() => order.open(o.id)} />
 *
 * Открытие пишется в историю (`push`), поэтому «назад» закрывает окно.
 * Закрытие историю не копит (`replace`) — иначе «назад» открывало бы окно
 * снова. Остальные параметры страницы (фильтры, период) сохраняются.
 *
 * Мелкие формы справочников адреса не получают: их состояние ничего не стоит
 * восстановить, а история засорялась бы каждым «новым клиентом».
 *
 * Внимание: `useSearchParams` требует Suspense-границы вокруг компонента —
 * иначе `next build` падает на пререндере (грабли волны В4).
 */
export function useUrlDialog(key: string) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const value = params.get(key);

  const buildHref = useCallback(
    (next: string | null) => {
      const sp = new URLSearchParams(params.toString());
      if (next === null) sp.delete(key);
      else sp.set(key, next);
      const qs = sp.toString();
      return (qs ? `${pathname}?${qs}` : pathname) as Parameters<typeof router.push>[0];
    },
    [key, params, pathname, router],
  );

  const open = useCallback((next: string) => router.push(buildHref(next)), [buildHref, router]);

  const close = useCallback(() => router.replace(buildHref(null)), [buildHref, router]);

  return { value, open, close };
}
