'use client';

import { X } from '@/components/ui/icons';
import type { Account, RuleAction, RuleActionType } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { ACTION_LABELS, defaultAction } from './dictionaries';

/** Одна строка блока «То подставить»: тип действия + выбор сущности. */
export function ActionRow({
  wsId,
  action,
  categoryOptions,
  counterpartyOptions,
  accounts,
  onChange,
  onRemove,
}: {
  wsId: string;
  action: RuleAction;
  categoryOptions: ComboboxOption[];
  counterpartyOptions: ComboboxOption[];
  accounts: Account[];
  onChange: (a: RuleAction) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
      <div className="flex-1 space-y-2">
        <Select
          value={action.type}
          onChange={(e) => onChange(defaultAction(e.target.value as RuleActionType))}
          aria-label="Тип действия"
        >
          {(Object.keys(ACTION_LABELS) as RuleActionType[]).map((t) => (
            <option key={t} value={t}>
              {ACTION_LABELS[t]}
            </option>
          ))}
        </Select>

        {action.type === 'SET_CATEGORY' && (
          <Combobox
            value={action.categoryId}
            onChange={(v) => onChange({ type: 'SET_CATEGORY', categoryId: v })}
            options={categoryOptions}
            placeholder="— Выберите категорию —"
            searchPlaceholder="Название категории…"
          />
        )}
        {action.type === 'SET_COUNTERPARTY' && (
          <Combobox
            value={action.counterpartyId}
            onChange={(v) => onChange({ type: 'SET_COUNTERPARTY', counterpartyId: v })}
            options={counterpartyOptions}
            placeholder="— Выберите контрагента —"
            searchPlaceholder="Имя или контакт…"
            recentKey={`${wsId}:counterparty`}
          />
        )}
        {action.type === 'SET_ACCOUNT' && (
          <Select
            value={action.accountId}
            onChange={(e) => onChange({ type: 'SET_ACCOUNT', accountId: e.target.value })}
          >
            <option value="" disabled>
              — Выберите счёт —
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Убрать действие"
          className="text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
