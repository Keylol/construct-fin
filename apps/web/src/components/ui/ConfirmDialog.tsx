'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from './Modal';
import { Button, type ButtonVariant } from './Button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: ButtonVariant;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/**
 * Подтверждение опасного действия. Построен на том же `Modal`, что и формы:
 * на телефоне — панель снизу, Cmd/Ctrl+Enter — подтвердить. Кнопка
 * подтверждения в фокусе сразу, Enter не нужен — действие уже названо в
 * заголовке.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = 'Подтвердить',
  cancelText = 'Отмена',
  variant = 'destructive',
  onConfirm,
  loading,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBusy = loading ?? busy;

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  // Отказ сервера показываем в окне: без этого окно молча не закрывалось, и
  // причину («нельзя удалить счёт с операциями») никто не видел.
  const handleConfirm = async () => {
    try {
      setBusy(true);
      setError(null);
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="md" hideClose onConfirm={() => void handleConfirm()}>
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          {description && <ModalDescription>{description}</ModalDescription>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </ModalHeader>
        <ModalFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isBusy}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={() => void handleConfirm()} loading={isBusy} autoFocus>
            {confirmText}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
