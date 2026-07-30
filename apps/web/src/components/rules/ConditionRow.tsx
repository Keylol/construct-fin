'use client';

import { X } from '@/components/ui/icons';
import type { Account, RuleCondition, RuleConditionType } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { CONDITION_LABELS, defaultCondition } from './dictionaries';

/** Одна строка блока «Если (все условия)»: тип + поля под выбранный тип. */
export function ConditionRow({
  wsId,
  condition,
  counterpartyOptions,
  accounts,
  onChange,
  onRemove,
}: {
  wsId: string;
  condition: RuleCondition;
  counterpartyOptions: ComboboxOption[];
  accounts: Account[];
  onChange: (c: RuleCondition) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
      <div className="flex-1 space-y-2">
        <Select
          value={condition.type}
          onChange={(e) => onChange(defaultCondition(e.target.value as RuleConditionType))}
          aria-label="Тип условия"
        >
          {(Object.keys(CONDITION_LABELS) as RuleConditionType[]).map((t) => (
            <option key={t} value={t}>
              {CONDITION_LABELS[t]}
            </option>
          ))}
        </Select>

        {condition.type === 'DESCRIPTION_CONTAINS' && (
          <Input
            value={condition.value}
            onChange={(e) => onChange({ type: 'DESCRIPTION_CONTAINS', value: e.target.value })}
            placeholder="подстрока в описании/контрагенте"
          />
        )}
        {condition.type === 'COUNTERPARTY_EQUALS' && (
          <Combobox
            value={condition.counterpartyId}
            onChange={(v) => onChange({ type: 'COUNTERPARTY_EQUALS', counterpartyId: v })}
            options={counterpartyOptions}
            placeholder="— Выберите контрагента —"
            searchPlaceholder="Имя или контакт…"
            recentKey={`${wsId}:counterparty`}
          />
        )}
        {condition.type === 'COUNTERPARTY_INN_IN' && (
          <div>
            <Input
              value={condition.values.join(', ')}
              onChange={(e) =>
                onChange({
                  type: 'COUNTERPARTY_INN_IN',
                  // Разделители любые (запятая, пробел, перенос) — ИНН обычно
                  // копируют пачкой из выписки; оставляем одни цифры.
                  values: e.target.value
                    .split(/[^0-9]+/)
                    .filter(Boolean),
                })
              }
              inputMode="numeric"
              placeholder="7701234567, 660312345678"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Несколько ИНН через запятую — сработает на любом из них.
            </p>
          </div>
        )}
        {condition.type === 'ACCOUNT_EQUALS' && (
          <Select
            value={condition.accountId}
            onChange={(e) => onChange({ type: 'ACCOUNT_EQUALS', accountId: e.target.value })}
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
        {condition.type === 'TYPE_EQUALS' && (
          <Select
            value={condition.value}
            onChange={(e) =>
              onChange({ type: 'TYPE_EQUALS', value: e.target.value as 'INCOME' | 'EXPENSE' })
            }
          >
            <option value="EXPENSE">Расход</option>
            <option value="INCOME">Доход</option>
          </Select>
        )}
        {condition.type === 'AMOUNT_RANGE' && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              inputMode="decimal"
              value={condition.min ?? ''}
              onChange={(e) =>
                onChange({ type: 'AMOUNT_RANGE', min: e.target.value, max: condition.max })
              }
              placeholder="от"
            />
            <Input
              inputMode="decimal"
              value={condition.max ?? ''}
              onChange={(e) =>
                onChange({ type: 'AMOUNT_RANGE', min: condition.min, max: e.target.value })
              }
              placeholder="до"
            />
          </div>
        )}
        {condition.type === 'SOURCE_EQUALS' && (
          <Select
            value={condition.value}
            onChange={(e) =>
              onChange({ type: 'SOURCE_EQUALS', value: e.target.value as 'IMPORT' | 'MANUAL' })
            }
          >
            <option value="IMPORT">Импорт</option>
            <option value="MANUAL">Ручной ввод</option>
          </Select>
        )}
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Убрать условие"
          className="text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
