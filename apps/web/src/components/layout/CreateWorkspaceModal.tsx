'use client';

import { useState } from 'react';
import { useCreateWorkspace } from '@/hooks/useWorkspaces';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';

/** Форма нового пространства — та же, что открывается из меню и с пустого экрана. */
export function CreateWorkspaceModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateWorkspace();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const ws = await create.mutateAsync({ name: name.trim() });
      setName('');
      onOpenChange(false);
      onCreated(ws.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать');
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} dirty={name.trim().length > 0}>
      <ModalContent size="md" onConfirm={() => void submit()}>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <ModalHeader>
            <ModalTitle>Новое пространство</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-4">
            <FormField label="Название" htmlFor="ws-name" required>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Напр. «ИП Каменский»"
                autoFocus
              />
            </FormField>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Создать
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
