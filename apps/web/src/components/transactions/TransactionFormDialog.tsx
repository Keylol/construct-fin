'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Paperclip, Sparkles, Trash2, X } from '@/components/ui/icons';
import type { TxType, Account, Category, Counterparty, RuleSuggestion } from '@/lib/types';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useUpdateTransaction,
  useTransaction,
  useUploadAttachment,
  useDeleteAttachment,
} from '@/hooks/useTransactions';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useRules, useRuleSuggest } from '@/hooks/useRules';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import { cn } from '@/lib/cn';
import { toLocalDateInput, fromLocalDateInput } from '@/lib/periods';
import { parseAmountInput } from '@construct/shared';

interface Props {
  wsId: string;
  open: boolean;
  transactionId: string | null; // null = create
  onClose: () => void;
}

export function TransactionFormDialog({ wsId, open, transactionId, onClose }: Props) {
  const isEdit = !!transactionId;
  const existing = useTransaction(wsId, transactionId);
  const accounts = useAccounts(wsId);
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const counterparties = useCounterparties(wsId);
  const create = useCreateTransaction(wsId);
  const update = useUpdateTransaction(wsId);
  const del = useDeleteTransaction(wsId);
  const upload = useUploadAttachment(wsId);
  const removeAtt = useDeleteAttachment(wsId);
  const rules = useRules(wsId);
  const suggest = useRuleSuggest(wsId);

  const [type, setType] = useState<TxType>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(toLocalDateInput(new Date()));
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [counterpartyId, setCounterpartyId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  // «+ Создать контрагента» из комбобокса: null = закрыто, строка = префилл имени.
  const [createCpQuery, setCreateCpQuery] = useState<string | null>(null);
  // Подсказка движка правил (только при создании): что подставить + какие правила
  // сработали. dismissed прячет баннер до следующей смены набора сработавших правил.
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const lastSigRef = useRef('');

  useEffect(() => {
    if (!open) return;
    if (existing.data) {
      setType(existing.data.type);
      setAmount(existing.data.amount);
      setDate(toLocalDateInput(existing.data.date));
      setAccountId(existing.data.accountId);
      setCategoryId(existing.data.categoryId ?? '');
      setCounterpartyId(existing.data.counterpartyId ?? '');
      setDescription(existing.data.description ?? '');
    } else if (!isEdit) {
      setType('EXPENSE');
      setAmount('');
      setDate(toLocalDateInput(new Date()));
      setAccountId(accounts.data?.[0]?.id ?? '');
      setCategoryId('');
      setCounterpartyId('');
      setDescription('');
    }
    setError(null);
    setSuggestion(null);
    setSuggestDismissed(false);
    lastSigRef.current = '';
  }, [open, existing.data, isEdit, accounts.data]);

  // Подсказки движка правил — только при создании (в режиме правки не навязываем
  // перезапись). Debounced: ждём паузу в наборе, затем POST /rules/suggest.
  useEffect(() => {
    if (!open || isEdit || !wsId) {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      const normalized = parseAmountInput(amount);
      suggest({
        description: description.trim() || null,
        counterpartyId: counterpartyId || null,
        accountId: accountId || null,
        amount: normalized || null,
        type,
        source: 'MANUAL',
      })
        .then((s) => {
          if (cancelled) return;
          const sig = s.matchedRuleIds.slice().sort().join(',');
          // Новый набор сработавших правил → снова показываем баннер.
          if (sig !== lastSigRef.current) {
            lastSigRef.current = sig;
            setSuggestDismissed(false);
          }
          setSuggestion(s.matchedRuleIds.length ? s : null);
        })
        .catch(() => {
          /* подсказка необязательна — молча игнорируем сбой */
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, isEdit, wsId, description, counterpartyId, accountId, amount, type, suggest]);

  const cats = type === 'INCOME' ? incomeCats.data ?? [] : expenseCats.data ?? [];
  const rootCats = cats.filter((c) => c.parentId === null && !c.isArchived);
  const childCats = (parentId: string) =>
    cats.filter((c) => c.parentId === parentId && !c.isArchived);
  const selectedCat = cats.find((c) => c.id === categoryId);

  // Категории для комбобокса: иерархия через группы — заголовок = родитель,
  // внутри «(общая)» + подкатегории. Поиск находит и родителя, и ребёнка.
  const categoryOptions = useMemo<ComboboxOption[]>(
    () =>
      rootCats.flatMap((root: Category) => [
        { value: root.id, label: `${root.name} (общая)`, group: root.name },
        ...childCats(root.id).map((child: Category) => ({
          value: child.id,
          label: child.name,
          group: root.name,
        })),
      ]),
    // childCats — производная от cats; сами cats в зависимостях.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cats],
  );

  const counterpartyOptions = useMemo<ComboboxOption[]>(
    () =>
      (counterparties.data ?? [])
        .filter((c: Counterparty) => !c.isArchived)
        .map((c: Counterparty) => ({
          value: c.id,
          label: c.name,
          description: c.contact ?? undefined,
        })),
    [counterparties.data],
  );

  // ─── Подсказка правил: имена сработавших правил + поля, отличные от текущих ───
  const ruleNames = useMemo(() => {
    if (!suggestion) return [] as string[];
    return suggestion.matchedRuleIds
      .map((id) => rules.data?.find((r) => r.id === id)?.name)
      .filter((n): n is string => !!n);
  }, [suggestion, rules.data]);

  const cpById = (id: string) => (counterparties.data ?? []).find((c) => c.id === id)?.name;
  const accById = (id: string) => (accounts.data ?? []).find((a) => a.id === id)?.name;

  const suggestionItems = useMemo(() => {
    if (!suggestion) return [] as { key: string; label: string }[];
    const items: { key: string; label: string }[] = [];
    // Категорию подсказываем, только если она подходит текущему типу (есть в списке
    // cats) — иначе её нельзя выбрать в форме и бэкенд отверг бы разный kind.
    if (
      suggestion.categoryId &&
      suggestion.categoryId !== categoryId &&
      cats.some((c) => c.id === suggestion.categoryId)
    ) {
      items.push({
        key: 'cat',
        label: `Категория → ${cats.find((c) => c.id === suggestion.categoryId)?.name ?? '—'}`,
      });
    }
    if (suggestion.counterpartyId && suggestion.counterpartyId !== counterpartyId) {
      items.push({ key: 'cp', label: `Контрагент → ${cpById(suggestion.counterpartyId) ?? '—'}` });
    }
    if (suggestion.accountId && suggestion.accountId !== accountId) {
      items.push({ key: 'acc', label: `Счёт → ${accById(suggestion.accountId) ?? '—'}` });
    }
    return items;
    // cpById/accById пересоздаются каждый рендер, но их реальные входы —
    // counterparties.data/accounts.data — уже в зависимостях; отключаем правило,
    // чтобы не тянуть нестабильные функции в deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion, categoryId, counterpartyId, accountId, cats, counterparties.data, accounts.data]);

  const showSuggestion = !isEdit && !suggestDismissed && suggestionItems.length > 0;

  const applySuggestion = () => {
    if (!suggestion) return;
    if (suggestion.categoryId && cats.some((c) => c.id === suggestion.categoryId))
      setCategoryId(suggestion.categoryId);
    if (suggestion.counterpartyId) setCounterpartyId(suggestion.counterpartyId);
    if (suggestion.accountId) setAccountId(suggestion.accountId);
    setSuggestDismissed(true);
  };

  const onSave = async () => {
    setError(null);
    const normalized = parseAmountInput(amount);
    if (!normalized) {
      setError('Сумма указана некорректно');
      return;
    }
    if (!accountId) {
      setError('Выберите счёт');
      return;
    }
    const payload = {
      date: fromLocalDateInput(date),
      amount: normalized,
      type,
      accountId,
      categoryId: categoryId || null,
      counterpartyId: counterpartyId || null,
      description: description.trim() || undefined,
    };
    try {
      if (isEdit && transactionId) {
        await update.mutateAsync({
          id: transactionId,
          ...payload,
          description: payload.description ?? null,
        });
      } else {
        await create.mutateAsync(payload);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const onDelete = async () => {
    if (!transactionId) return;
    await del.mutateAsync(transactionId);
    onClose();
  };

  const onPickFile = async (file: File) => {
    if (!transactionId) return;
    try {
      await upload.mutateAsync({ txId: transactionId, file });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Загрузка не удалась');
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" hideClose>
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>{isEdit ? 'Операция' : 'Новая операция'}</SheetTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>

          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
          <SheetBody className="space-y-4">
            {showSuggestion && (
              <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="flex-1 text-sm">
                    <div className="font-medium">
                      {ruleNames.length
                        ? `Правило «${ruleNames.join('», «')}» предлагает:`
                        : 'Правило предлагает:'}
                    </div>
                    <ul className="mt-1 space-y-0.5 text-muted-foreground">
                      {suggestionItems.map((it) => (
                        <li key={it.key}>{it.label}</li>
                      ))}
                    </ul>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSuggestDismissed(true)}
                    aria-label="Скрыть подсказку"
                    className="text-muted-foreground transition-colors hover:opacity-80"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex justify-end">
                  <Button type="button" size="sm" variant="secondary" onClick={applySuggestion}>
                    <Check className="h-3.5 w-3.5" /> Применить
                  </Button>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {/* C16: смена типа сбрасывает категорию — иначе в payload осталась бы
                  stale-категория прежнего типа (расходная на доходе), которую
                  бэкенд теперь отвергает 400. Список категорий и так фильтруется
                  по type, но state categoryId нужно занулить явно. */}
              <button
                type="button"
                onClick={() => {
                  setType('EXPENSE');
                  setCategoryId('');
                }}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md border text-sm font-medium transition-colors',
                  type === 'EXPENSE'
                    ? 'border-destructive bg-destructive text-destructive-foreground'
                    : 'border-input bg-background text-foreground hover:bg-secondary',
                )}
              >
                Расход
              </button>
              <button
                type="button"
                onClick={() => {
                  setType('INCOME');
                  setCategoryId('');
                }}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md border text-sm font-medium transition-colors',
                  type === 'INCOME'
                    ? 'border-success bg-success text-success-foreground'
                    : 'border-input bg-background text-foreground hover:bg-secondary',
                )}
              >
                Доход
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Сумма" htmlFor="tx-amount" required>
                <MoneyInput
                  id="tx-amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  autoFocus
                />
              </FormField>
              <FormField label="Дата" htmlFor="tx-date" required>
                <Input
                  id="tx-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </FormField>
            </div>

            <FormField label="Счёт" htmlFor="tx-account" required>
              <Select
                id="tx-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="" disabled>
                  — Выберите счёт —
                </option>
                {(accounts.data ?? [])
                  .filter((a: Account) => !a.isArchived)
                  .map((a: Account) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </FormField>

            <FormField label="Категория" htmlFor="tx-cat">
              <Combobox
                id="tx-cat"
                value={categoryId}
                onChange={setCategoryId}
                options={categoryOptions}
                placeholder="— Без категории —"
                searchPlaceholder="Название категории…"
                clearLabel="— Без категории —"
              />
              {selectedCat?.isFixedCost && (
                <Badge variant="outline" className="mt-1">
                  Постоянная издержка
                </Badge>
              )}
            </FormField>

            <FormField label="Контрагент" htmlFor="tx-cp">
              <Combobox
                id="tx-cp"
                value={counterpartyId}
                onChange={setCounterpartyId}
                options={counterpartyOptions}
                placeholder="— Без контрагента —"
                searchPlaceholder="Имя или контакт…"
                clearLabel="— Без контрагента —"
                recentKey={`${wsId}:counterparty`}
                onCreate={(q) => setCreateCpQuery(q)}
                createLabel={(q) => `Создать контрагента «${q}»`}
              />
            </FormField>

            <FormField label="Описание" htmlFor="tx-desc">
              <Input
                id="tx-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="напр. «обед, кафе»"
              />
            </FormField>

            {isEdit && transactionId && (
              <div className="space-y-1.5 pt-2">
                <div className="text-sm font-medium">Вложения</div>
                <div className="space-y-1.5">
                  {(existing.data?.attachments ?? []).map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a
                        href={`/api/v1/workspaces/${wsId}/attachments/${a.id}/download`}
                        className="flex-1 truncate text-primary hover:underline"
                      >
                        {a.filename}
                      </a>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {(a.size / 1024).toFixed(0)} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAtt.mutate({ id: a.id, txId: transactionId })}
                        aria-label="Удалить вложение"
                        className="text-destructive transition-colors hover:opacity-80"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary">
                    <Paperclip className="h-3.5 w-3.5" />
                    Прикрепить файл
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onPickFile(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {upload.isPending && (
                    <p className="text-xs text-muted-foreground">Загружаю…</p>
                  )}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </SheetBody>

          <SheetFooter>
            {isEdit && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmDel(true)}
                className="sm:mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Удалить
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button
              type="submit"
              loading={create.isPending || update.isPending}
              disabled={!amount.trim() || !accountId}
            >
              Сохранить
            </Button>
          </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Удалить операцию?"
        description="Операцию можно восстановить из истории."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />

      {/* Роль по контексту: расход — платим поставщику, доход — платит клиент.
          Так запись не уходит в невидимый OTHER и видна в своём справочнике. */}
      <QuickCreateCounterpartyDialog
        wsId={wsId}
        role={type === 'INCOME' ? 'CLIENT' : 'SUPPLIER'}
        open={createCpQuery !== null}
        initialName={createCpQuery ?? ''}
        onOpenChange={(o) => !o && setCreateCpQuery(null)}
        onCreated={setCounterpartyId}
      />
    </>
  );
}
