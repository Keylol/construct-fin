'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { FormField } from '@/components/ui/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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
import { useCrmPipelines, useDisconnectCrm, useUpdateCrmConnection } from '@/hooks/useCrm';
import type { CrmConnection, CrmPipeline } from '@/lib/types';

/** Имена по умолчанию (решение владельца 20.09.2026): воронка «Воронка», порог «Отправлен». */
const DEFAULT_PIPELINE = 'воронка';
const DEFAULT_TRIGGER = 'отправлен';

/**
 * Настройки подключения: наблюдаемая воронка, этап-порог «ждёт заказа»,
 * замена токена, пауза синхронизации и удаление. Только владелец.
 */
export function CrmSettingsModal({
  wsId,
  connection,
  open,
  onClose,
}: {
  wsId: string;
  connection: CrmConnection;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateCrmConnection(wsId);
  const disconnect = useDisconnectCrm(wsId);
  // Живой список воронок — чтобы новая воронка или переименованный этап были
  // видны сразу, а не после следующего синка. Пока грузится — снимок.
  const live = useCrmPipelines(wsId, open);
  const pipelines: CrmPipeline[] = live.data ?? connection.pipelines;

  const [pipelineId, setPipelineId] = useState('');
  const [triggerStatusId, setTriggerStatusId] = useState('');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToken('');
    setError(null);
    setEnabled(connection.status !== 'DISABLED');
    setPipelineId(connection.pipelineId != null ? String(connection.pipelineId) : '');
    setTriggerStatusId(
      connection.triggerStatusId != null ? String(connection.triggerStatusId) : '',
    );
  }, [open, connection]);

  // Первое открытие после подключения: подставить воронку и порог по именам,
  // чтобы владелец только подтвердил, а не искал.
  useEffect(() => {
    if (!open || pipelineId || pipelines.length === 0) return;
    const p =
      pipelines.find((x) => x.name.trim().toLowerCase() === DEFAULT_PIPELINE) ??
      pipelines.find((x) => x.isMain) ??
      pipelines[0];
    if (!p) return;
    setPipelineId(String(p.id));
    const s = p.statuses.find((x) => x.name.trim().toLowerCase() === DEFAULT_TRIGGER);
    if (s && !triggerStatusId) setTriggerStatusId(String(s.id));
  }, [open, pipelines, pipelineId, triggerStatusId]);

  const statuses = useMemo(
    () =>
      pipelines.find((p) => String(p.id) === pipelineId)?.statuses.filter((s) => s.type === 0) ??
      [],
    [pipelines, pipelineId],
  );

  const dirty =
    token.trim() !== '' ||
    enabled !== (connection.status !== 'DISABLED') ||
    pipelineId !== (connection.pipelineId != null ? String(connection.pipelineId) : '') ||
    triggerStatusId !==
      (connection.triggerStatusId != null ? String(connection.triggerStatusId) : '');

  const submit = () => {
    if (update.isPending) return;
    setError(null);
    update.mutate(
      {
        ...(token.trim() ? { token: token.trim() } : {}),
        status: enabled ? 'ACTIVE' : 'DISABLED',
        pipelineId: pipelineId ? Number(pipelineId) : null,
        triggerStatusId: triggerStatusId ? Number(triggerStatusId) : null,
      },
      {
        onSuccess: () => {
          toast.success('Настройки amoCRM сохранены');
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Не удалось сохранить'),
      },
    );
  };

  return (
    <>
      <Modal open={open} onOpenChange={(o) => !o && onClose()} dirty={dirty}>
        <ModalContent size="md" onConfirm={submit}>
          <ModalHeader>
            <ModalTitle>Настройки amoCRM</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-4">
            <div className="rounded-md bg-secondary/40 p-3 text-sm">
              <div className="font-medium">{connection.accountName ?? connection.subdomain}</div>
              <div className="text-xs text-muted-foreground">
                {connection.url} · токен …{connection.keyLast4}
              </div>
            </div>

            <FormField
              label="Воронка"
              htmlFor="crm-pipeline"
              hint="Сделки других воронок в панель не попадают."
            >
              <Select
                id="crm-pipeline"
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setTriggerStatusId('');
                }}
                disabled={live.isLoading && pipelines.length === 0}
              >
                <option value="">Все воронки</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Этап «ждёт заказа»"
              htmlFor="crm-trigger"
              hint="Сделка на этом этапе и дальше считается ожидающей заказа в учёте."
            >
              <Select
                id="crm-trigger"
                value={triggerStatusId}
                onChange={(e) => setTriggerStatusId(e.target.value)}
                disabled={!pipelineId}
              >
                <option value="">Любой этап</option>
                {statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Новый токен"
              htmlFor="crm-new-token"
              hint="Заполните только для замены: старый перестал работать или истёк."
              error={error ?? undefined}
            >
              <Textarea
                id="crm-new-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={3}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>

            <Checkbox
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              label="Синхронизация включена"
              hint="Выключенное подключение сделки не тянет; всё загруженное остаётся."
            />
            {live.isError && (
              <p className="text-xs text-destructive">
                {live.error instanceof Error
                  ? live.error.message
                  : 'Не удалось получить воронки из amoCRM'}
              </p>
            )}
          </ModalBody>
          <ModalFooter className="justify-between">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
              Удалить подключение
            </Button>
            <div className="flex gap-2">
              <ModalClose asChild>
                <Button variant="secondary">Отмена</Button>
              </ModalClose>
              <Button onClick={submit} loading={update.isPending}>
                Сохранить
              </Button>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title="Удалить подключение amoCRM?"
        description="Синхронизация остановится, токен будет удалён. Уже созданные заказы и их связи со сделками останутся."
        confirmText="Удалить"
        onConfirm={() => {
          disconnect.mutate(undefined, {
            onSuccess: () => {
              toast.success('Подключение amoCRM удалено');
              setDeleting(false);
              onClose();
            },
            onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось удалить'),
          });
        }}
      />
    </>
  );
}
