'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { FormField } from '@/components/ui/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton } from '@/components/ui/Skeleton';
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
import { plural } from '@/lib/plural';
import {
  useCrmPipelines,
  useCrmStages,
  useDisconnectCrm,
  useUpdateCrmConnection,
} from '@/hooks/useCrm';
import type { CrmConnection, CrmPipeline } from '@/lib/types';

/** Воронка по умолчанию (решение владельца 20.09.2026). */
const DEFAULT_PIPELINE = 'воронка';
/**
 * Этапы «ждут заказа» по умолчанию (решение владельца 20.09.2026): оплаченные
 * сделки в работе. Именно набор, а не порог «с этапа и дальше» — на доске
 * сервисные этапы (Гарантия, Проверка, Отложенная покупка) стоят после
 * «Отправлен», а оплаченные в работе — до него.
 */
const DEFAULT_WAITING = [
  'уведомление по срокам',
  'фото комплектующих',
  'фото после сборки',
  'оформление доставки',
  'отправлен',
];

const norm = (s: string) => s.trim().toLowerCase();
const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Настройки подключения: наблюдаемая воронка, этапы «ждут заказа» (галочки с
 * числом открытых сделок), замена токена, пауза синхронизации и удаление.
 * Только владелец.
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
  // Число открытых сделок по этапам — из снимка на сервере, без похода в amo.
  const stages = useCrmStages(wsId, open);

  const [pipelineId, setPipelineId] = useState('');
  const [waiting, setWaiting] = useState<number[]>([]);
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
    setWaiting(connection.waitingStatusIds);
  }, [open, connection]);

  // Первое открытие после подключения: подставить воронку и этапы по именам,
  // чтобы владелец только подтвердил, а не собирал набор с нуля.
  useEffect(() => {
    if (!open || pipelineId || pipelines.length === 0) return;
    const p =
      pipelines.find((x) => norm(x.name) === DEFAULT_PIPELINE) ??
      pipelines.find((x) => x.isMain) ??
      pipelines[0];
    if (!p) return;
    setPipelineId(String(p.id));
    if (connection.waitingStatusIds.length === 0) {
      setWaiting(p.statuses.filter((s) => DEFAULT_WAITING.includes(norm(s.name))).map((s) => s.id));
    }
  }, [open, pipelines, pipelineId, connection.waitingStatusIds]);

  const pipelineStatuses = useMemo(
    () =>
      pipelines.find((p) => String(p.id) === pipelineId)?.statuses.filter((s) => s.type === 0) ??
      [],
    [pipelines, pipelineId],
  );
  const openCount = useMemo(
    () => new Map((stages.data ?? []).map((s) => [s.id, s.openCount])),
    [stages.data],
  );
  const waitingOpen = pipelineStatuses
    .filter((s) => waiting.includes(s.id))
    .reduce((acc, s) => acc + (openCount.get(s.id) ?? 0), 0);

  const dirty =
    token.trim() !== '' ||
    enabled !== (connection.status !== 'DISABLED') ||
    pipelineId !== (connection.pipelineId != null ? String(connection.pipelineId) : '') ||
    !sameSet(waiting, connection.waitingStatusIds);

  const toggle = (id: number, on: boolean) =>
    setWaiting((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const submit = () => {
    if (update.isPending) return;
    setError(null);
    update.mutate(
      {
        ...(token.trim() ? { token: token.trim() } : {}),
        status: enabled ? 'ACTIVE' : 'DISABLED',
        pipelineId: pipelineId ? Number(pipelineId) : null,
        // Только этапы выбранной воронки: смена воронки не должна тащить чужие id.
        waitingStatusIds: waiting.filter((id) => pipelineStatuses.some((s) => s.id === id)),
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
                  setWaiting([]);
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
              label="Этапы «ждут заказа»"
              hint={
                pipelineId
                  ? waiting.length === 0
                    ? 'Ничего не отмечено — ждущей считается любая открытая сделка воронки.'
                    : `Отмечено ${plural(waiting.length, 'этап', 'этапа', 'этапов')} · открытых сделок на них: ${waitingOpen}`
                  : 'Сначала выберите воронку.'
              }
            >
              {pipelineId ? (
                stages.isLoading && pipelineStatuses.length === 0 ? (
                  <Skeleton className="h-24" />
                ) : (
                  <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border p-3">
                    {pipelineStatuses.map((s) => (
                      <Checkbox
                        key={s.id}
                        checked={waiting.includes(s.id)}
                        onChange={(e) => toggle(s.id, e.target.checked)}
                        label={
                          <span className="flex items-center gap-2">
                            <span>{s.name}</span>
                            <span className="tabular-nums text-xs text-muted-foreground">
                              {openCount.get(s.id) ?? 0}
                            </span>
                          </span>
                        }
                      />
                    ))}
                    {pipelineStatuses.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        У воронки нет этапов — нажмите «Обновить» в разделе.
                      </p>
                    )}
                  </div>
                )
              ) : null}
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
