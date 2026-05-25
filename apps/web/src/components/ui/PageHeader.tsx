import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface Crumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-border bg-background px-6 py-5',
        'sm:flex-row sm:items-end sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Хлебные крошки" className="mb-1.5">
            <ol className="flex items-center gap-1 text-xs text-muted-foreground">
              {breadcrumbs.map((c, i) => {
                const isLast = i === breadcrumbs.length - 1;
                return (
                  <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                    {c.href && !isLast ? (
                      <Link
                        href={c.href as Parameters<typeof Link>[0]['href']}
                        className="hover:text-foreground transition-colors"
                      >
                        {c.label}
                      </Link>
                    ) : (
                      <span className={isLast ? 'text-foreground' : ''}>{c.label}</span>
                    )}
                    {!isLast && <ChevronRight className="h-3 w-3 shrink-0" />}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">{actions}</div>
      )}
    </div>
  );
}
