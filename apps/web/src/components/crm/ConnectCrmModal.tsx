'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { FormField } from '@/components/ui/FormField';
import { toast } from '@/components/ui/Toaster';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { useConnectCrm } from '@/hooks/useCrm';
import type { CrmConnection } from '@/lib/types';

/**
 * Подключение amoCRM: поддомен и долгосрочный токен частной интеграции.
 * Токен проверяется на сервере запросом к amo до записи и хранится только
 * зашифрованным — наружу возвращается маска.
 */
export function ConnectCrmModal({
  wsId,
  open,
  onClose,
  onConnected,
}: {
  wsId: string;
  open: boolean;
  onClose: () => void;
  onConnected?: (connection: CrmConnection) => void;
}) {
  const connect = useConnectCrm(wsId);
  const [subdomain, setSubdomain] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubdomain('');
    setToken('');
    setError(null);
  }, [open]);

  const dirty = subdomain.trim() !== '' || token.trim() !== '';
  const canSubmit = subdomain.trim().length >= 2 && token.trim().length >= 20 && !connect.isPending;

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    connect.mutate(
      { subdomain: subdomain.trim(), token: token.trim() },
      {
        onSuccess: (c) => {
          toast.success(`amoCRM подключён: ${c.accountName ?? c.subdomain}`);
          onClose();
          onConnected?.(c);
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Не удалось подключить amoCRM'),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} dirty={dirty}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>Подключить amoCRM</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <FormField
            label="Поддомен аккаунта"
            htmlFor="crm-subdomain"
            hint="Часть адреса до «.amocrm.ru», например constructpcdirect"
          >
            <Input
              id="crm-subdomain"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              placeholder="constructpcdirect"
              autoComplete="off"
              autoFocus
            />
          </FormField>
          <FormField
            label="Долгосрочный токен"
            htmlFor="crm-token"
            hint="amoCRM → Настройки → Интеграции → ваша интеграция → «Ключи и доступы» → «Долгосрочный токен». Хранится зашифрованным, наружу не отдаётся."
            error={error ?? undefined}
          >
            <Textarea
              id="crm-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9…"
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Отмена</Button>
          </ModalClose>
          <Button onClick={submit} disabled={!canSubmit} loading={connect.isPending}>
            Подключить
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
