import { Children, cloneElement, isValidElement, useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface FormFieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Обёртка поля: label + hint/error. Если внутри ровно один элемент (Input/Select/
 * Textarea), автоматически пробрасывает в него id, aria-invalid и aria-describedby —
 * ошибка краснит рамку и читается скринридером. С несколькими детьми (составные
 * поля) ведёт себя как раньше: только разметка, без инъекции пропсов.
 */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const autoId = useId();

  let fieldId = htmlFor;
  let content = children;

  const items = Children.toArray(children);
  if (items.length === 1 && isValidElement(items[0])) {
    const child = items[0] as React.ReactElement<Record<string, unknown>>;
    fieldId = htmlFor ?? (child.props.id as string | undefined) ?? autoId;
    const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;
    content = cloneElement(child, {
      id: fieldId,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': (child.props['aria-describedby'] as string | undefined) ?? describedBy,
    });
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <label
        htmlFor={fieldId}
        className="block text-sm font-medium text-foreground"
      >
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {content}
      {hint && !error && (
        <p id={fieldId ? `${fieldId}-hint` : undefined} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={fieldId ? `${fieldId}-error` : undefined}
          role="alert"
          className="text-xs font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
