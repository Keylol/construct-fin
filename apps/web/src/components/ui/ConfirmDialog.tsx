'use client';

import { useState, type ReactNode } from 'react';
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
  const isBusy = loading ?? busy;

  const handleConfirm = async () => {
    try {
      setBusy(true);
      await onConfirm();
      onOpenChange(false);
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
