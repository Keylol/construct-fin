'use client';

import { useEffect, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from './Modal';
import { Button } from './Button';

interface DeleteEntityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Название записи — в заголовке. */
  name: string;
  /** Что удаляем, с заглавной: «Счёт», «Клиент», «Статья». */
  noun: string;
  /** Уже в архиве — предлагать архив при отказе незачем. */
  isArchived: boolean;
  onDelete: () => Promise<void>;
  onArchive: () => Promise<void>;
}

/**
 * Удаление записи справочника (счёт, контрагент, статья). Удаление настоящее:
 * запись пропадает и из архива, из интерфейса её не вернуть. Поэтому окно
 * говорит об этом прямо, а убрать из работы предлагает архивом.
 *
 * Сервер отказывает, если у записи есть связи (операции, заказы, бюджет).
 * Тогда окно показывает причину и одним нажатием отправляет запись в архив.
 */
export function DeleteEntityDialog({
  open,
  onOpenChange,
  name,
  noun,
  isArchived,
  onDelete,
  onArchive,
}: DeleteEntityDialogProps) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (open) setRefusal(null);
  }, [open]);

  const run = async (action: () => Promise<void>) => {
    try {
      setBusy(true);
      await action();
      onOpenChange(false);
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const canArchive = refusal !== null && !isArchived;
  const primary = refusal === null ? () => run(onDelete) : canArchive ? () => run(onArchive) : undefined;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="md" hideClose onConfirm={primary && (() => void primary())}>
        <ModalHeader>
          <ModalTitle>{refusal === null ? `Удалить «${name}»?` : `«${name}» удалить нельзя`}</ModalTitle>
          {refusal === null ? (
            <ModalDescription>
              {noun} пропадёт из списков и из архива, восстановить будет нельзя. Чтобы только убрать
              из работы, отметьте «В архиве» в карточке.
            </ModalDescription>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {refusal}
            </p>
          )}
        </ModalHeader>
        <ModalFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {refusal === null || canArchive ? 'Отмена' : 'Закрыть'}
          </Button>
          {refusal === null && (
            <Button variant="destructive" onClick={() => void run(onDelete)} loading={busy} autoFocus>
              Удалить
            </Button>
          )}
          {canArchive && (
            <Button onClick={() => void run(onArchive)} loading={busy} autoFocus>
              В архив
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
