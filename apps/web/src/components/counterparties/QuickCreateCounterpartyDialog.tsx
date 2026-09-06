'use client';

import { useEffect, useState } from 'react';
import { useCounterparties, useCreateCounterparty } from '@/hooks/useCounterparties';
import { findClient, normalizeClientName } from '@construct/shared';
import type { CounterpartyRole } from '@/lib/types';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { toast } from '@/components/ui/Toaster';

const ROLE_TITLES: Record<string, string> = {
  CLIENT: 'Новый клиент',
  SUPPLIER: 'Новый поставщик',
  OTHER: 'Новый контрагент',
};

/**
 * Мини-диалог «создать на лету» из комбобокса: имя + контакт, роль задаётся
 * контекстом формы (в заказе — CLIENT, в закупке — SUPPLIER). Созданный id
 * отдаётся наверх и сразу подставляется в поле.
 */
export function QuickCreateCounterpartyDialog({
  wsId,
  role,
  open,
  initialName,
  initialContact,
  onOpenChange,
  onCreated,
}: {
  wsId: string;
  role: CounterpartyRole;
  open: boolean;
  /** Предзаполнение имени — то, что пользователь набрал в поиске комбобокса. */
  initialName: string;
  /** Предзаполнение контакта: телефон из спецификации, чтобы не набирать заново. */
  initialContact?: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateCounterparty(wsId);
  // Второй рубеж против дублей: карточка с таким же именем или телефоном уже
  // может быть в справочнике — тогда её надо выбрать, а не заводить вторую.
  const existing = useCounterparties(wsId, undefined, false, role);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setContact(initialContact ?? '');
      setError(null);
    }
  }, [open, initialName, initialContact]);

  const twin =
    name.trim() && existing.data ? findClient(existing.data, name, contact || null) : null;

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Укажите имя или название');
      return;
    }
    // Справочник ещё грузится — ждём: создать вслепую значит рискнуть дублем.
    if (!existing.data) {
      setError('Справочник ещё загружается, секунду');
      return;
    }
    if (twin && normalizeClientName(twin.name) === normalizeClientName(name)) {
      onOpenChange(false);
      onCreated(twin.id);
      toast.success(`Выбран существующий: ${twin.name}`, {
        description: 'Такая карточка уже была — второй не завожу',
      });
      return;
    }
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        role,
        contact: contact.trim() || undefined,
      });
      toast.success(`${ROLE_TITLES[role] ?? 'Контрагент'}: ${created.name}`, {
        description: 'Создан и подставлен в форму',
      });
      onOpenChange(false);
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} dirty={!!name.trim() || !!contact.trim()}>
      <ModalContent size="md" onConfirm={submit}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            // Останавливаем всплытие: диалог может жить внутри <form> Sheet-а,
            // Enter здесь не должен сабмитить внешнюю форму.
            e.stopPropagation();
            void submit();
          }}
        >
          <ModalHeader>
            <ModalTitle>{ROLE_TITLES[role] ?? 'Новый контрагент'}</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-3">
            <FormField label="Имя / название" required error={error ?? undefined}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormField>
            <FormField label="Контакт" hint="Телефон, email или @username — можно позже">
              <Input value={contact} onChange={(e) => setContact(e.target.value)} />
            </FormField>
            {twin && (
              <p className="text-xs text-muted-foreground">
                Похоже, такая карточка уже есть: <b>{twin.name}</b>
                {twin.contact ? ` · ${twin.contact}` : ''}. По кнопке подставлю её.
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <ModalClose asChild>
              <Button type="button" variant="secondary">Отмена</Button>
            </ModalClose>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              {twin && normalizeClientName(twin.name) === normalizeClientName(name)
                ? 'Выбрать существующего'
                : 'Создать'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
