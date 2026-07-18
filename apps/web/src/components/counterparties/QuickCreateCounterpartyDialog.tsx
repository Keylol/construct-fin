'use client';

import { useEffect, useState } from 'react';
import { useCreateCounterparty } from '@/hooks/useCounterparties';
import type { CounterpartyRole } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
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
  onOpenChange,
  onCreated,
}: {
  wsId: string;
  role: CounterpartyRole;
  open: boolean;
  /** Предзаполнение имени — то, что пользователь набрал в поиске комбобокса. */
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateCounterparty(wsId);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setContact('');
      setError(null);
    }
  }, [open, initialName]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Укажите имя или название');
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
          <DialogHeader>
            <DialogTitle>{ROLE_TITLES[role] ?? 'Новый контрагент'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <FormField label="Имя / название" required error={error ?? undefined}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormField>
            <FormField label="Контакт" hint="Телефон, email или @username — можно позже">
              <Input value={contact} onChange={(e) => setContact(e.target.value)} />
            </FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
