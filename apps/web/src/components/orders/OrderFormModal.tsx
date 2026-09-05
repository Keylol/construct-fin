'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { Textarea } from '@/components/ui/Textarea';
import { toast } from '@/components/ui/Toaster';
import { ClipboardList, Paperclip, Plus, Receipt, Trash2, X } from '@/components/ui/icons';
import { useAccounts } from '@/hooks/useAccounts';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useParseOrderSpec, useParseReceiptCosts, type OrderSpecDraft } from '@/hooks/useOrders';
import { type OrderItemInput, type ScheduleEntryInput, useAddOrderPayment, useCreateOrder, useSetOrderSchedule, useUpdateOrder } from '@/hooks/useOrders';
import { useWarehouse } from '@/hooks/useWarehouse';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { fromLocalDateInput, toLocalDateInput } from '@/lib/periods';
import type { Order } from '@/lib/types';
import { D, add, allocateSalePrices, formatRub, mul, normalizePhone, parseAmountInput, parseOrderItemsText, planCostApplication, sub, toMoneyString } from '@construct/shared';

export function OrderFormModal({
  wsId,
  open,
  editing,
  onClose,
  onCreated,
}: {
  wsId: string;
  open: boolean;
  editing: Order | null;
  onClose: () => void;
  /**
   * Заказ создан. Форма сама не решает, что дальше: страница открывает карточку,
   * чтобы следующий шаг круга («привязать оплату») был на виду, а не искался.
   */
  onCreated?: (orderId: string, paid: boolean) => void;
}) {
  const isEdit = !!editing;
  const clients = useCounterparties(wsId, undefined, false, 'CLIENT');
  const warehouse = useWarehouse(wsId);
  const accounts = useAccounts(wsId);
  const create = useCreateOrder(wsId);
  const update = useUpdateOrder(wsId);
  const setSchedule = useSetOrderSchedule(wsId);
  const addPayment = useAddOrderPayment(wsId);

  const [clientId, setClientId] = useState('');
  // Телефон — видимый номер заказа, обязателен (решение владельца 29.08).
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [discount, setDiscount] = useState('');
  const [items, setItems] = useState<OrderItemInput[]>([
    { name: '', qty: '1', unitPrice: '', unitCost: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  // Ошибки по строкам позиций: индекс строки → текст. Невалидная строка больше
  // не выбрасывается молча — подсвечивается и блокирует сабмит.
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({});
  const [confirmClose, setConfirmClose] = useState(false);
  // «+ Создать клиента» из комбобокса: null = закрыто, строка = префилл имени.
  const [createClientQuery, setCreateClientQuery] = useState<string | null>(null);
  // Заказчик из спецификации, которого нет в справочнике: заводится одной
  // кнопкой рядом с полем клиента, вместе с телефоном из того же документа.
  const [specClient, setSpecClient] = useState<string | null>(null);

  // ── Состав текстом и распределение цены (P0.1) ──
  // Спецификация заказа приходит списком (docx поставщика, заметка, таблица), а
  // сборка из восьми позиций — это 26 полей ручного ввода. Текстовое поле
  // переносит её целиком; цены продажи раскидываются по закупке одной кнопкой.
  const [pasteOpen, setPasteOpen] = useState(false);
  const parseSpec = useParseOrderSpec(wsId);
  const parseCosts = useParseReceiptCosts(wsId);
  // Итог последнего разбора чеков: сколько позиций получило цену и какие
  // строки остались лишними — показывается под составом, пока форма открыта.
  const [costsReport, setCostsReport] = useState<{
    matched: { name: string; cost: string; qty: string; applied: boolean; why: string }[];
    unmatchedLines: { name: string; price: string }[];
    files: number;
  } | null>(null);
  // Итог из спецификации: подсказка для «Распределить цену продажи» — в самом
  // документе цен по позициям нет.
  const [specTotal, setSpecTotal] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [allocTotal, setAllocTotal] = useState('');

  // ── План оплаты (только при СОЗДАНИИ; в правке платежи/график — в детали) ──
  // 'none' — без оплаты, 'full' — оплата сразу 100%, 'schedule' — свой график.
  // Предоплата = реальные деньги сейчас (решение владельца): пишется платежом.
  const [payMode, setPayMode] = useState<'none' | 'full' | 'schedule'>('none');
  const [prepayAmount, setPrepayAmount] = useState('');
  const [prepayAccount, setPrepayAccount] = useState('');
  const [payAccountFull, setPayAccountFull] = useState('');
  const [scheduleRows, setScheduleRows] = useState<{ dueDate: string; amount: string }[]>([]);
  const [payError, setPayError] = useState<string | null>(null);

  const accountOptions = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => !a.isArchived)
        .map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );

  // SKU со вторичной строкой (остаток, себестоимость) — для строк позиций.
  const skuOptions = useMemo(
    () =>
      (warehouse.data ?? [])
        .filter((w) => !w.isArchived)
        .map((w) => ({
          value: w.id,
          label: w.color ? `${w.name} · ${w.color}` : w.name,
          description: `ост. ${Number(w.qty)} ${w.unit}${
            Number(w.avgCost) > 0 ? ` · себест. ${formatRub(w.avgCost)}` : ''
          }`,
          keywords: w.sku ? [w.sku] : undefined,
        })),
    [warehouse.data],
  );
  // Снимок состояния на момент открытия — для guard «Закрыть без сохранения?».
  const initialSnap = useRef('');

  const snapOf = (
    cl: string,
    t: string,
    d: string,
    disc: string,
    its: OrderItemInput[],
  ) =>
    JSON.stringify({
      cl,
      t,
      d,
      disc,
      its: its.map((it) => ({
        w: it.warehouseItemId ?? null,
        n: it.name,
        q: it.qty,
        p: it.unitPrice,
        c: it.unitCost ?? '',
      })),
    });

  // Префилл при открытии на редактирование.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      const nextItems = (editing.items ?? []).map((it) => ({
        warehouseItemId: it.warehouseItemId,
        name: it.name,
        qty: String(Number(it.qty)),
        unitPrice: String(Number(it.unitPrice)),
        unitCost: it.unitCost ? String(Number(it.unitCost)) : '',
      }));
      const nextDiscount =
        Number(editing.discountAmount) > 0 ? String(Number(editing.discountAmount)) : '';
      setClientId(editing.clientId ?? '');
      setPhone(editing.phone ?? '');
      setTitle(editing.title ?? '');
      setDescription(editing.description ?? '');
      setDiscount(nextDiscount);
      setItems(nextItems);
      initialSnap.current = snapOf(
        editing.clientId ?? '',
        editing.title ?? '',
        editing.description ?? '',
        nextDiscount,
        nextItems,
      );
    } else {
      const nextItems = [{ warehouseItemId: null, name: '', qty: '1', unitPrice: '', unitCost: '' }];
      setClientId('');
      setPhone('');
      setTitle('');
      setDescription('');
      setDiscount('');
      setItems(nextItems);
      initialSnap.current = snapOf('', '', '', '', nextItems);
    }
    setError(null);
    setItemErrors({});
    setPasteOpen(false);
    setPasteText('');
    setAllocTotal('');
    // Модалка смонтирована постоянно: без сброса следующий архив открывался бы
    // с отчётом по чекам и итогом спецификации предыдущего заказа.
    setCostsReport(null);
    setSpecTotal(null);
    // Сброс плана оплаты.
    setPayMode('none');
    setPrepayAmount('');
    setPrepayAccount('');
    setPayAccountFull('');
    setScheduleRows([]);
    setPayError(null);
  }, [open, editing]);

  const isDirty =
    snapOf(clientId, title, description, discount, items) !== initialSnap.current ||
    // Незакрытый план оплаты при создании — тоже несохранённое состояние.
    (!isEdit && payMode !== 'none');

  // Закрытие через guard: заполненная форма не стирается молча по Esc/оверлею.
  const requestClose = () => {
    if (isDirty && !create.isPending && !update.isPending) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  // Правка строки позиции + сброс её ошибки (пользователь начал исправлять).
  const patchItem = (i: number, patch: Partial<OrderItemInput>) => {
    setItems((arr) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setItemErrors((prev) => {
      if (!(i in prev)) return prev;
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };

  // Разбор вставленного текста считаем на каждый ввод — человек видит, что
  // распозналось, ДО того как строки заменят форму.
  const pasteParsed = useMemo(() => parseOrderItemsText(pasteText), [pasteText]);

  /**
   * Чеки закупки → себестоимость позиций. Файлы уходят по одному (лимит
   * multipart), строки со всех чеков складываются в общий список, и только
   * потом раскладываются по позициям: одна строка — одной позиции.
   *
   * Ставим цену только там, где её ещё нет: разобранный чек не должен затирать
   * то, что человек уже поправил руками.
   */
  const applyCosts = async (files: File[]) => {
    const lines: { name: string; unitPrice: string; qty: string; source: string }[] = [];
    const failed: string[] = [];

    for (const file of files) {
      try {
        const r = await parseCosts.mutateAsync(file);
        r.items.forEach((i) =>
          lines.push({ name: i.name, unitPrice: i.unitPrice, qty: i.qty, source: r.source }),
        );
        r.warnings.forEach((w) => toast.error(`${file.name}: ${w}`));
      } catch (e) {
        failed.push(file.name);
        toast.error(`${file.name}: ${e instanceof Error ? e.message : 'не разобрался'}`);
      }
    }

    if (lines.length === 0) {
      if (failed.length < files.length) toast.error('В чеках не нашлось позиций с ценами');
      return;
    }

    // Решение целиком в чистой функции: сюда возвращается уже готовый план —
    // где ставим цену, где переносим количество, где не трогаем чужой ввод.
    const plan = planCostApplication(
      items.map((it) => ({ name: it.name, qty: it.qty || '1', unitCost: it.unitCost ?? '' })),
      lines,
    );
    // Считаем ДО setItems: updater в React вызывается больше одного раза, и
    // побочный эффект внутри него удваивал бы отчёт.
    const applied = plan.applications.filter((a) => a.applied);
    const matched = plan.applications.map((a) => ({
      name: items[a.itemIndex]?.name ?? '',
      cost: a.unitCost,
      qty: a.qty,
      applied: a.applied,
      why: a.reasons.join(', '),
    }));

    setItems((prev) =>
      prev.map((it, idx) => {
        const a = plan.applications.find((x) => x.itemIndex === idx);
        if (!a || !a.applied) return it;
        return { ...it, unitCost: a.unitCost, qty: a.qty };
      }),
    );

    setCostsReport({
      matched,
      unmatchedLines: plan.unusedLineIndexes.map((i) => ({
        name: lines[i]?.name ?? '',
        price: lines[i]?.unitPrice ?? '',
      })),
      files: files.length - failed.length,
    });
    toast.success(`Цены из чеков: ${applied.length} из ${items.length} позиций`);
  };

  /**
   * Спецификация заполняет форму, но ничего не решает за человека: позиции
   * приходят без цен (их в документе нет), клиент подставляется только если
   * такой уже заведён — иначе остаётся имя в комментарии, чтобы не плодить
   * дубли справочника.
   */
  const applySpec = (file: File) => {
    parseSpec.mutate(file, {
      onSuccess: (draft: OrderSpecDraft) => {
        if (draft.phone) setPhone(draft.phone);
        if (draft.title) setTitle(draft.title);
        if (draft.items.length > 0) {
          setItems(
            draft.items.map((it: OrderSpecDraft['items'][number]) => ({
              name: `${it.kind}: ${it.name}`,
              qty: '1',
              unitPrice: '',
              unitCost: '',
            })),
          );
        }
        if (draft.total) {
          setSpecTotal(draft.total);
          setAllocTotal(draft.total);
        }

        // Ищем сперва по телефону: люди приходят повторно, а имя в справочнике
        // может быть записано иначе («Иванов И.И.», с пометкой магазина).
        const list = clients.data ?? [];
        const byPhone = draft.phone
          ? list.find((c) => c.contact && normalizePhone(c.contact) === draft.phone)
          : undefined;
        const byName = draft.clientName
          ? list.find(
              (c) => c.name.trim().toLowerCase() === draft.clientName?.trim().toLowerCase(),
            )
          : undefined;
        const match = byPhone ?? byName;
        if (match) setClientId(match.id);
        setSpecClient(match ? null : (draft.clientName ?? null));

        const notes: string[] = [];
        if (draft.clientName && !match) notes.push(`Заказчик по спецификации: ${draft.clientName}`);
        if (draft.date) notes.push(`Дата спецификации: ${formatDate(draft.date)}`);
        if (notes.length > 0) {
          setDescription((prev) => (prev ? `${prev}\n${notes.join('\n')}` : notes.join('\n')));
        }

        const parts = [`Позиций: ${draft.items.length}`];
        if (draft.total) parts.push(`итог ${formatRub(draft.total)}`);
        toast.success(`Спецификация разобрана · ${parts.join(', ')}`);
        draft.warnings.forEach((w) => toast.error(w));
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось прочитать файл'),
    });
  };

  const applyPaste = (mode: 'replace' | 'append') => {
    const parsed = pasteParsed.items.map((it) => ({
      warehouseItemId: null,
      name: it.name,
      qty: it.qty,
      unitPrice: it.unitPrice,
      unitCost: it.unitCost,
    }));
    if (!parsed.length) return;
    setItems((arr) => {
      if (mode === 'replace') return parsed;
      // Запасная пустая строка формы не должна оставаться между вставками.
      const kept = arr.filter((it) => it.name.trim() || it.unitPrice.trim() || it.warehouseItemId);
      return [...kept, ...parsed];
    });
    setItemErrors({});
    setPasteText('');
    setPasteOpen(false);
    toast.success(`Позиций добавлено: ${parsed.length}`);
  };

  const applyAllocation = () => {
    const target = parseAmountInput(allocTotal);
    if (!target || !D(target).gt(0)) {
      setError('Итог для распределения — число больше нуля');
      return;
    }
    const filled = items.filter((it) => it.name.trim() || it.unitCost?.trim());
    if (!filled.length) {
      setError('Сначала заполните позиции — распределять пока не на что');
      return;
    }
    const prices = allocateSalePrices(
      filled.map((it) => ({ qty: it.qty || '1', unitCost: it.unitCost ?? '' })),
      target,
    );
    let k = 0;
    setItems((arr) =>
      arr.map((it) => {
        const counts = it.name.trim() || it.unitCost?.trim();
        if (!counts) return it;
        const price = prices[k++] ?? it.unitPrice;
        return { ...it, unitPrice: price };
      }),
    );
    setError(null);
  };

  // Превью-итоги черновика через Decimal (не JS number, D4). Ввод свободный —
  // невалидное значение считаем нулём, «жёсткая» валидация остаётся на сабмите.
  const parseDraft = (s: string | null | undefined) => {
    try {
      return D((s ?? '').replace(/\s/g, '').replace(',', '.') || '0');
    } catch {
      return D(0);
    }
  };
  const subtotal = useMemo(
    () =>
      items.reduce(
        (acc, it) => add(acc, mul(parseDraft(it.qty), parseDraft(it.unitPrice))),
        D(0),
      ),
    [items],
  );
  // Себестоимость превью — как считает бэкенд (F1): ручная закупка, а для
  // складской строки без неё — оценка по текущей стоимости остатка (avgCost).
  const { costTotal, costIsEstimate } = useMemo(() => {
    let acc = D(0);
    let est = false;
    for (const it of items) {
      const whCost = it.warehouseItemId
        ? warehouse.data?.find((w) => w.id === it.warehouseItemId)?.avgCost
        : null;
      const manual = it.unitCost ? parseDraft(it.unitCost) : null;
      const cost = manual ?? (whCost != null ? D(whCost) : null);
      if (cost == null) continue;
      if (manual == null) est = true;
      acc = add(acc, mul(parseDraft(it.qty), cost));
    }
    return { costTotal: acc, costIsEstimate: est };
  }, [items, warehouse.data]);
  const total = useMemo(() => {
    const t = sub(subtotal, parseDraft(discount));
    return t.gt(0) ? t : D(0);
  }, [subtotal, discount]);
  const estEarnings = sub(total, costTotal);

  // Честная валидация: полностью пустые строки игнорируются (запасная строка),
  // но частично заполненная невалидная строка — это ошибка, а не молчаливый
  // выброс (иначе заказ тихо создаётся без части позиций).
  const collectItems = ():
    | { ok: true; items: OrderItemInput[] }
    | { ok: false; errors: Record<number, string> } => {
    const cleaned: OrderItemInput[] = [];
    const errors: Record<number, string> = {};
    items.forEach((it, i) => {
      const blank = !it.name.trim() && !it.unitPrice.trim() && !it.warehouseItemId;
      if (blank) return;
      if (!it.name.trim()) {
        errors[i] = 'Укажите наименование';
        return;
      }
      const price = parseAmountInput(it.unitPrice);
      if (!price) {
        errors[i] = 'Укажите цену продажи — число больше нуля';
        return;
      }
      if (!parseDraft(it.qty).gt(0)) {
        errors[i] = 'Количество должно быть больше нуля';
        return;
      }
      if (it.unitCost && !parseAmountInput(it.unitCost)) {
        errors[i] = 'Закупочная цена — некорректное число';
        return;
      }
      const cost = it.unitCost ? parseAmountInput(it.unitCost) : null;
      cleaned.push({
        warehouseItemId: it.warehouseItemId ?? null,
        name: it.name.trim(),
        qty: it.qty,
        unitPrice: price,
        unitCost: cost,
      });
    });
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, items: cleaned };
  };

  // Σ плана: предоплата сейчас + сумма графика остатка. Сверяется с итогом заказа.
  const prepayDraft = payMode === 'full' ? total : parseDraft(prepayAmount);
  const scheduleDraft = scheduleRows.reduce((acc, r) => add(acc, parseDraft(r.amount)), D(0));
  const planTotal = add(prepayDraft, scheduleDraft);
  const planMatchesTotal = planTotal.eq(total);

  // Валидация плана оплаты (только при создании). Возвращает шаги для оркестрации
  // или ошибку. Предоплата = реальные деньги сейчас → требует счёт.
  const collectPaymentPlan = ():
    | { ok: true; prepay: { amount: string; accountId: string } | null; schedule: ScheduleEntryInput[] }
    | { ok: false; error: string } => {
    if (payMode === 'none') return { ok: true, prepay: null, schedule: [] };

    const todayIso = fromLocalDateInput(toLocalDateInput(new Date()));

    if (payMode === 'full') {
      if (!total.gt(0)) return { ok: false, error: 'Сумма заказа — 0, оплачивать нечего' };
      if (!payAccountFull) return { ok: false, error: 'Выберите счёт для оплаты' };
      const amount = toMoneyString(total);
      return {
        ok: true,
        prepay: { amount, accountId: payAccountFull },
        // График не нужен — заказ оплачен полностью.
        schedule: [],
      };
    }

    // payMode === 'schedule': предоплата (опц.) + строки остатка.
    let prepay: { amount: string; accountId: string } | null = null;
    const entries: ScheduleEntryInput[] = [];

    const prepayVal = parseAmountInput(prepayAmount);
    if (prepayAmount.trim() && !prepayVal) {
      return { ok: false, error: 'Сумма предоплаты указана некорректно' };
    }
    if (prepayVal && D(prepayVal).gt(0)) {
      if (!prepayAccount) return { ok: false, error: 'Выберите счёт для предоплаты' };
      prepay = { amount: prepayVal, accountId: prepayAccount };
      // Предоплата — первая строка графика (срок сегодня), чтобы FIFO-покрытие
      // и сверка с итогом сходились.
      entries.push({ dueDate: todayIso, amount: prepayVal, note: 'Предоплата' });
    }

    for (const r of scheduleRows) {
      if (!r.dueDate && !r.amount.trim()) continue;
      const amount = parseAmountInput(r.amount);
      if (!r.dueDate || !amount || D(amount).lte(0)) {
        return { ok: false, error: 'В каждой строке графика нужны дата и положительная сумма' };
      }
      entries.push({ dueDate: fromLocalDateInput(r.dueDate), amount });
    }

    if (!prepay && entries.length === 0) {
      return { ok: false, error: 'Добавьте предоплату или строки графика (или выберите «Без оплаты»)' };
    }
    return { ok: true, prepay, schedule: entries };
  };

  const submitCreate = async () => {
    setError(null);
    setPayError(null);
    const collected = collectItems();
    if (!collected.ok) {
      setItemErrors(collected.errors);
      setError('Исправьте выделенные позиции — они не будут сохранены в таком виде');
      return;
    }
    const cleaned = collected.items;
    if (!cleaned.length) {
      setError('Добавьте хотя бы одну позицию с названием и ценой');
      return;
    }
    const plan = collectPaymentPlan();
    if (!plan.ok) {
      setPayError(plan.error);
      return;
    }
    // Телефон — видимый номер заказа: без него заказ не опознать в списке.
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      setError('Укажите телефон клиента — он служит номером заказа');
      return;
    }
    try {
      const order = await create.mutateAsync({
        clientId: clientId || null,
        phone: normalizedPhone,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        discountAmount: discount ? parseAmountInput(discount) ?? undefined : undefined,
        items: cleaned,
      });
      // Заказ создан. Дальнейшие шаги оплаты — необязательные и восстановимые:
      // при сбое заказ НЕ теряется, сообщаем «внесите вручную в карточке».
      try {
        if (plan.schedule.length > 0) {
          await setSchedule.mutateAsync({ id: order.id, entries: plan.schedule });
        }
        if (plan.prepay) {
          await addPayment.mutateAsync({
            id: order.id,
            // Для «оплата 100%» берём авторитетную сумму созданного заказа
            // (бэкенд считает total из позиций/скидки) — платёж копейка-в-копейку.
            amount: payMode === 'full' ? order.totalAmount : plan.prepay.amount,
            accountId: plan.prepay.accountId,
          });
        }
        toast.success('Заказ создан', {
          description:
            plan.prepay || plan.schedule.length ? 'План оплаты сохранён' : undefined,
        });
      } catch (payErr) {
        toast.warning('Заказ создан, но оплату записать не удалось', {
          description: `${payErr instanceof Error ? payErr.message : 'Ошибка'}. Внесите оплату вручную в карточке заказа.`,
        });
      }
      onClose();
      onCreated?.(order.id, Boolean(plan.prepay));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    setError(null);
    const collected = collectItems();
    if (!collected.ok) {
      setItemErrors(collected.errors);
      setError('Исправьте выделенные позиции — они не будут сохранены в таком виде');
      return;
    }
    const cleaned = collected.items;
    if (!cleaned.length) {
      setError('Добавьте хотя бы одну позицию с названием и ценой');
      return;
    }
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      setError('Укажите телефон клиента — он служит номером заказа');
      return;
    }
    try {
      await update.mutateAsync({
        id: editing.id,
        clientId: clientId || null,
        phone: normalizedPhone,
        title: title.trim() || null,
        description: description.trim() || null,
        discountAmount: discount ? parseAmountInput(discount) ?? undefined : '0',
        items: cleaned,
      });
      toast.success('Заказ обновлён');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <>
    <Modal open={open} onOpenChange={(o) => !o && requestClose()}>
      <ModalContent hideClose size="2xl">
        <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <ModalTitle>{isEdit ? `Изменить ${editing?.number ?? 'заказ'}` : 'Новый заказ'}</ModalTitle>
          <Button variant="ghost" size="icon" onClick={requestClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </ModalHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void (isEdit ? submitEdit() : submitCreate());
          }}
        >
        <ModalBody className="space-y-4">
          <FormField label="Клиент" htmlFor="o-client">
            <Combobox
              id="o-client"
              value={clientId}
              onChange={setClientId}
              options={(clients.data ?? []).map((c) => ({
                value: c.id,
                label: c.name,
                description: c.contact ?? undefined,
              }))}
              placeholder="— Без клиента —"
              searchPlaceholder="Имя или контакт…"
              clearLabel="— Без клиента —"
              recentKey={`${wsId}:client`}
              onCreate={(q) => setCreateClientQuery(q)}
              createLabel={(q) => `Создать клиента «${q}»`}
            />
            {specClient && !clientId && (
              <button
                type="button"
                onClick={() => setCreateClientQuery(specClient)}
                className="mt-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                Завести клиента «{specClient}» с телефоном из спецификации
              </button>
            )}
          </FormField>
          <FormField label="Телефон — номер заказа" htmlFor="o-phone">
            <Input
              id="o-phone"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 924 363 40 29"
              aria-invalid={error?.includes('Телефон') ? true : undefined}
            />
          </FormField>
          <FormField label="Название" htmlFor="o-title">
            <Input
              id="o-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="напр. «Сборка ПК для офиса»"
            />
          </FormField>
          <FormField label="Комментарий" htmlFor="o-description">
            <Textarea
              id="o-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Детали заказа: договорённости, сроки, нюансы"
              rows={3}
            />
          </FormField>

          <div className="space-y-3">
            <div className="text-sm font-medium">Позиции</div>
            {/* Постоянные заголовки колонок числовой строки — вместо угадывания
                по плейсхолдерам. Скрыты на узком экране (там подписи в placeholder). */}
            <div className="hidden items-center gap-2 px-3 text-xs font-medium uppercase text-muted-foreground sm:flex">
              <div className="flex-1">Наименование</div>
              <div className="w-16">Кол-во</div>
              <div className="w-24">Цена прод.</div>
              <div className="w-24">Закуп. цена</div>
              <div className="w-24 text-right">Сумма</div>
            </div>
            {items.map((it, i) => {
              const wh = warehouse.data?.find((w) => w.id === it.warehouseItemId);
              const rowError = itemErrors[i];
              const lineSum = mul(parseDraft(it.qty), parseDraft(it.unitPrice));
              return (
                <div
                  key={i}
                  className={cn(
                    'space-y-1.5 rounded-md border p-2.5',
                    rowError ? 'border-destructive' : 'border-border',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Combobox
                      value={it.warehouseItemId ?? ''}
                      onChange={(v) => {
                        const item = warehouse.data?.find((w) => w.id === v);
                        patchItem(i, {
                          warehouseItemId: v || null,
                          ...(item ? { name: item.name } : {}),
                        });
                      }}
                      options={skuOptions}
                      placeholder="Услуга / без склада"
                      searchPlaceholder="Название, цвет или артикул…"
                      clearLabel="Услуга / без склада"
                      recentKey={`${wsId}:sku`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setItems((arr) => arr.filter((_, j) => j !== i));
                        setItemErrors({});
                      }}
                      aria-label="Удалить позицию"
                      disabled={items.length === 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        value={it.name}
                        onChange={(e) => patchItem(i, { name: e.target.value })}
                        placeholder="Наименование"
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    <div className="w-16">
                      <Input
                        inputMode="decimal"
                        value={it.qty}
                        onChange={(e) => patchItem(i, { qty: e.target.value })}
                        placeholder="Кол."
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        inputMode="decimal"
                        value={it.unitPrice}
                        onChange={(e) => patchItem(i, { unitPrice: e.target.value })}
                        placeholder="Цена прод."
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        inputMode="decimal"
                        value={it.unitCost ?? ''}
                        onChange={(e) => patchItem(i, { unitCost: e.target.value })}
                        placeholder="Закуп. цена"
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    {/* Сумма строки qty×цена — только чтение, видно вклад позиции. */}
                    <div className="flex h-10 w-24 items-center justify-end text-sm tabular-nums sm:h-9">
                      {lineSum.gt(0) ? formatRub(toMoneyString(lineSum)) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                  {rowError && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {rowError}
                    </p>
                  )}
                  {wh && !it.unitCost && (
                    <p className="text-xs text-muted-foreground">
                      Себестоимость со склада {formatRub(wh.avgCost)} · спишется при
                      закрытии. Или впишите закупочную цену вручную.
                    </p>
                  )}
                  {!it.warehouseItemId && it.unitCost && (
                    <p className="text-xs text-amber-600">
                      Эта сумма уже попадёт в прибыль как себестоимость при закрытии заказа.
                      Не заводите её повторно отдельной расходной операцией — будет двойной учёт.
                    </p>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setItems((arr) => [
                    ...arr,
                    { warehouseItemId: null, name: '', qty: '1', unitPrice: '', unitCost: '' },
                  ])
                }
              >
                <Plus className="h-3.5 w-3.5" /> Позиция
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPasteOpen((v) => !v)}
                aria-expanded={pasteOpen}
              >
                <ClipboardList className="h-3.5 w-3.5" /> Вставить составом
              </Button>
              {/* Спецификация из архива клиента: телефон, ФИО, конфигурация,
                  позиции и итог заполняются разом. Цен по позициям в документе
                  нет — их раскидывает «Распределить цену продажи». */}
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary">
                <Paperclip className="h-3.5 w-3.5" />
                {parseSpec.isPending ? 'Читаю спецификацию…' : 'Из спецификации'}
                <input
                  type="file"
                  accept=".docx"
                  className="hidden"
                  disabled={parseSpec.isPending}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) applySpec(f);
                  }}
                />
              </label>
              {/* Второй шаг заведения из архива: чеки той же папки дают
                  закупочные цены — в спецификации их нет. */}
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary">
                <Receipt className="h-3.5 w-3.5" />
                {parseCosts.isPending ? 'Читаю чеки…' : 'Цены из чеков'}
                <input
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  disabled={parseCosts.isPending}
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    e.target.value = '';
                    if (files.length > 0) void applyCosts(files);
                  }}
                />
              </label>
            </div>

            {pasteOpen && (
              <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
                <p className="text-xs text-muted-foreground">
                  Строка на позицию: <span className="font-medium">название / закупка / цена продажи</span>.
                  Закупка и цена необязательны, разделители — «/», «|» или табуляция (вставка из
                  таблицы). Количество — хвостом названия: «Вентилятор 120мм ×4».
                </p>
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={'Процессор AMD Ryzen 7 9800X3D / 33202\nВидеокарта Palit RTX 5080 / 124999'}
                  rows={6}
                />
                {pasteText.trim() && (
                  <div className="space-y-1 text-xs">
                    <p className={pasteParsed.items.length ? 'text-success' : 'text-muted-foreground'}>
                      Распознано позиций: {pasteParsed.items.length}
                    </p>
                    {pasteParsed.errors.map((e) => (
                      <p key={e.line} className="text-destructive">
                        Строка {e.line}: {e.reason} — «{e.text}»
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => applyPaste('replace')}
                    disabled={!pasteParsed.items.length}
                  >
                    Заменить позиции
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPaste('append')}
                    disabled={!pasteParsed.items.length}
                  >
                    Добавить к текущим
                  </Button>
                </div>
              </div>
            )}

            {costsReport && (
              <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3 text-xs">
                <p className="font-medium text-foreground">
                  Разобрано чеков: {costsReport.files} · цены проставлены у{' '}
                  {costsReport.matched.filter((m) => m.applied).length} позиций
                </p>
                {costsReport.matched.map((m, i) => (
                  <p key={`${m.name}-${i}`} className="text-muted-foreground">
                    <span className="text-foreground">{m.name}</span> →{' '}
                    {Number(m.qty) > 1 ? `${m.qty} × ` : ''}
                    {formatRub(m.cost)}
                    {m.applied ? '' : ' (оставлена своя цена)'}{' '}
                    <span className="opacity-70">({m.why})</span>
                  </p>
                ))}
                {costsReport.unmatchedLines.length > 0 && (
                  <div className="border-t border-border pt-2">
                    <p className="text-muted-foreground">
                      Строки чеков без позиции — проверьте, не потерялось ли что-то:
                    </p>
                    {costsReport.unmatchedLines.map((l, i) => (
                      <p key={`${l.name}-${i}`} className="text-muted-foreground">
                        {formatRub(l.price)} · {l.name}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Клиент платит одну сумму за сборку — цены по позициям выводятся из
                неё пропорционально закупке, как считали в калькуляторе вручную. */}
            <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                <span>
                  Итог заказа для распределения
                  {specTotal && ` · из спецификации ${formatRub(specTotal)}`}
                </span>
                <Input
                  inputMode="decimal"
                  value={allocTotal}
                  onChange={(e) => setAllocTotal(e.target.value)}
                  placeholder="напр. 461468"
                />
              </label>
              <Button type="button" variant="secondary" size="sm" onClick={applyAllocation}>
                Распределить цену продажи
              </Button>
            </div>
          </div>

          <FormField label="Скидка (₽)" htmlFor="o-discount">
            <Input
              id="o-discount"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder="0"
            />
          </FormField>

          <div className="space-y-1 rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сумма позиций</span>
              <Money value={toMoneyString(subtotal)} />
            </div>
            {costTotal.gt(0) && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {costIsEstimate ? 'Себестоимость (оценка по складу)' : 'Себестоимость'}
                </span>
                <Money value={toMoneyString(costTotal)} />
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <span>Итого к оплате</span>
              <Money value={toMoneyString(total)} />
            </div>
            {costTotal.gt(0) && (
              <div className="flex justify-between font-semibold text-success">
                <span>Валовая прибыль (план)</span>
                <span className="tabular-nums">
                  {costIsEstimate ? '≈ ' : ''}
                  {formatRub(toMoneyString(estEarnings))}
                </span>
              </div>
            )}
          </div>

          {/* План оплаты — только при создании. В правке платежи/график живут
              в карточке заказа (вкладка «Оплата»). */}
          {!isEdit && (
            <div className="space-y-3">
              <div className="text-sm font-medium">Оплата</div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['none', 'Без оплаты'],
                    ['full', 'Оплата сразу 100%'],
                    ['schedule', 'Свой график'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setPayMode(mode);
                      setPayError(null);
                      // При переходе в «Свой график» — одна пустая строка остатка.
                      if (mode === 'schedule' && scheduleRows.length === 0) {
                        setScheduleRows([{ dueDate: '', amount: '' }]);
                      }
                    }}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                      payMode === mode
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background text-foreground hover:bg-secondary',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {payMode === 'full' && (
                <div className="space-y-1.5">
                  <FormField label="Счёт зачисления" htmlFor="o-pay-full" required>
                    <Combobox
                      id="o-pay-full"
                      value={payAccountFull}
                      onChange={setPayAccountFull}
                      options={accountOptions}
                      placeholder="— Счёт —"
                      searchPlaceholder="Счёт…"
                    />
                  </FormField>
                  <p className="text-xs text-muted-foreground">
                    Запишем платёж на всю сумму {formatRub(toMoneyString(total))} сегодня.
                  </p>
                </div>
              )}

              {payMode === 'schedule' && (
                <div className="space-y-3 rounded-md border border-border p-3">
                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">
                      Предоплата сейчас (если получена)
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="w-32">
                        <Input
                          inputMode="decimal"
                          value={prepayAmount}
                          onChange={(e) => setPrepayAmount(e.target.value)}
                          placeholder="Сумма, ₽"
                          aria-label="Сумма предоплаты"
                        />
                      </div>
                      <div className="flex-1">
                        <Combobox
                          value={prepayAccount}
                          onChange={setPrepayAccount}
                          options={accountOptions}
                          placeholder="— Счёт —"
                          searchPlaceholder="Счёт…"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Реальный платёж сегодня. Оставьте пустым, если предоплаты нет.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">
                      Остаток по датам
                    </div>
                    {scheduleRows.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          type="date"
                          value={r.dueDate}
                          onChange={(e) =>
                            setScheduleRows((arr) =>
                              arr.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                            )
                          }
                          className="w-[150px]"
                        />
                        <Input
                          inputMode="decimal"
                          value={r.amount}
                          onChange={(e) =>
                            setScheduleRows((arr) =>
                              arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                            )
                          }
                          placeholder="Сумма, ₽"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setScheduleRows((arr) => arr.filter((_, j) => j !== i))
                          }
                          aria-label="Удалить строку"
                          disabled={scheduleRows.length === 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setScheduleRows((arr) => [...arr, { dueDate: '', amount: '' }])
                      }
                    >
                      <Plus className="h-3.5 w-3.5" /> Дата
                    </Button>
                  </div>

                  {/* Σ плана vs итог — предупреждение, а не блокировка. */}
                  <div className="flex justify-between border-t border-border pt-2 text-sm">
                    <span className="text-muted-foreground">План (предоплата + остаток)</span>
                    <span className={cn('tabular-nums', !planMatchesTotal && 'text-amber-600')}>
                      {formatRub(toMoneyString(planTotal))} из {formatRub(toMoneyString(total))}
                    </span>
                  </div>
                  {!planMatchesTotal && planTotal.gt(0) && (
                    <p className="text-xs text-amber-600">
                      План не сходится с итогом заказа — проверьте суммы (можно сохранить как есть).
                    </p>
                  )}
                </div>
              )}

              {payError && <p className="text-sm text-destructive">{payError}</p>}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </ModalBody>
        <ModalFooter>
          {isEdit ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={requestClose}
                disabled={update.isPending}
              >
                Отмена
              </Button>
              <Button type="submit" loading={update.isPending}>
                Сохранить
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              loading={create.isPending || setSchedule.isPending || addPayment.isPending}
            >
              Создать заказ
            </Button>
          )}
        </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
    <ConfirmDialog
      open={confirmClose}
      onOpenChange={setConfirmClose}
      title="Закрыть без сохранения?"
      description="В форме заказа есть несохранённые изменения — они будут потеряны."
      confirmText="Закрыть"
      cancelText="Вернуться к форме"
      onConfirm={() => {
        setConfirmClose(false);
        onClose();
      }}
    />
    <QuickCreateCounterpartyDialog
      wsId={wsId}
      role="CLIENT"
      open={createClientQuery !== null}
      initialName={createClientQuery ?? ''}
      initialContact={phone}
      onOpenChange={(o) => !o && setCreateClientQuery(null)}
      onCreated={(id) => {
        setClientId(id);
        setSpecClient(null);
      }}
    />
    </>
  );
}

// ─────────────────────────── Order detail / manage ───────────────────────────
