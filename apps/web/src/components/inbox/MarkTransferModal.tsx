'use client';

import { useMemo, useState } from 'react';
import { useAccounts } from '@/hooks/useAccounts';
import { useMarkTransfer } from '@/hooks/useInbox';
import type { InboxLine } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { toast } from '@/components/ui/Toaster';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { formatRub } from '@construct/shared';
import { formatDate } from '@/lib/dates';

/**
 * Перевод на счёт, выписку которого банк не отдаёт: карты физлиц (ВБ) второй
 * строкой никогда не приедут, поэтому встречную сторону заводим сами.
 */
export function MarkTransferModal({
  open,
  onClose,
  wsId,
  line,
}: {
  open: boolean;
  onClose: () => void;
  wsId: string;
  line: InboxLine;
}) {
  const accounts = useAccounts(wsId);
  const mark = useMarkTransfer(wsId);
  const [counterAccountId, setCounterAccountId] = useState('');

  const isOut = line.direction === 'EXPENSE';
  // Счёт самой строки исключаем: перевод сам на себя невозможен.
  const options = useMemo<ComboboxOption[]>(
    () =>
      (accounts.data ?? [])
        .filter((a) => !a.isArchived && a.id !== line.account.id)
        .map((a) => ({ value: a.id, label: a.name })),
    [accounts.data, line.account.id],
  );

  const submit = () => {
    if (!counterAccountId) return;
    mark.mutate(
      { lineId: line.id, counterAccountId },
      {
        onSuccess: () => {
          toast.success('Перевод создан — в доходы и расходы он не попадёт');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось создать перевод'),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent size="lg">
        <ModalHeader>
          <ModalTitle>{isOut ? 'Перевод на другой счёт' : 'Поступление с другого счёта'}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            <span className={isOut ? 'font-semibold text-destructive' : 'font-semibold text-success'}>
              {isOut ? '−' : '+'}
              {formatRub(line.amount, 2)}
            </span>{' '}
            от {formatDate(line.date)} · {line.account.name}
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{isOut ? 'Куда переведены деньги' : 'Откуда пришли деньги'}</span>
            <Combobox
              value={counterAccountId}
              onChange={setCounterAccountId}
              options={options}
              placeholder="Выберите счёт"
              searchPlaceholder="Название счёта…"
              className="h-9"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Перевод между своими счетами не доход и не расход: в отчёт о прибыли он не
            попадёт, изменятся только остатки счетов. Используйте, когда выписку второго
            счёта банк не отдаёт — например, для карт.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!counterAccountId || mark.isPending}>
            Создать перевод
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
