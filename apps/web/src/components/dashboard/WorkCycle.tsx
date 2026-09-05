'use client';

import Link from 'next/link';
import { ArrowRight } from '@/components/ui/icons';

/**
 * Ежедневный круг работы, показанный явно.
 *
 * Учёт держится на одном повторяющемся цикле, и человек, севший за приложение
 * впервые, должен видеть его целиком, а не угадывать по названиям разделов.
 * Каждый шаг — ссылка ровно туда, где он делается.
 *
 * Порядок совпадает с порядком разделов в меню: то, что читается сверху вниз
 * здесь, лежит сверху вниз и там.
 */
const STEPS: { n: number; title: string; hint: string; href: string }[] = [
  {
    n: 1,
    title: 'Завести заказ',
    hint: 'Спецификация и чеки из папки клиента',
    href: '/orders?new=1',
  },
  {
    n: 2,
    title: 'Разнести деньги',
    hint: 'Строки банка — к заказу или в расход',
    href: '/inbox',
  },
  {
    n: 3,
    title: 'Закрыть заказ',
    hint: 'Датой денег — тогда выручка признана',
    href: '/orders?status=OPEN',
  },
  {
    n: 4,
    title: 'Посмотреть итог',
    hint: 'Прибыль, долги, налог за месяц',
    href: '/reports',
  },
];

export function WorkCycle() {
  return (
    <section>
      <h2 className="mb-3 text-base font-semibold tracking-tight">Порядок работы</h2>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <li key={s.n}>
            <Link
              href={s.href as Parameters<typeof Link>[0]['href']}
              className="group flex h-full flex-col gap-1 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-secondary"
            >
              <span className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-muted-foreground">
                  {s.n}
                </span>
                <span className="text-sm font-medium text-foreground">{s.title}</span>
                <ArrowRight
                  className="ml-auto h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden
                />
              </span>
              <span className="text-xs text-muted-foreground">{s.hint}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
