'use client';

import { useState } from 'react';
import { Plug, Plus, Trash2, RotateCcw } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import {
  useIntegrations,
  useCreateIntegration,
  useDeleteIntegration,
  useSyncIntegration,
} from '@/hooks/useIntegrations';
import type { IntegrationConnection, IntegrationProvider, IntegrationStatus } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusDot } from '@/components/ui/StatusDot';
import { FormField } from '@/components/ui/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { formatDateTime } from '@/lib/dates';

const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  ALFA: 'Альфа-Банк',
  TBANK: 'Т-Банк',
  WB_CARD: 'Карта ВБ',
};

const STATUS: Record<IntegrationStatus, { tone: 'success' | 'warning' | 'destructive' | 'muted'; label: string }> = {
  ACTIVE: { tone: 'success', label: 'Активно' },
  ERROR: { tone: 'destructive', label: 'Ошибка' },
  DISABLED: { tone: 'muted', label: 'Выключено' },
};

export default function IntegrationsPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const isOwner = current?.role === 'OWNER';

  const connections = useIntegrations(isOwner ? wsId : null);
  const accounts = useAccounts(wsId);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<IntegrationConnection | null>(null);

  const del = useDeleteIntegration(wsId ?? '');
  const sync = useSyncIntegration(wsId ?? '');

  if (!current) {
    return (
      <>
        <PageHeader title="Интеграции" />
        <div className="p-6">
          <EmptyState icon={Plug} title="Нет активного пространства" hint="Выберите пространство." />
        </div>
      </>
    );
  }

  if (!isOwner) {
    return (
      <>
        <PageHeader title="Интеграции" />
        <div className="p-6">
          <EmptyState
            icon={Plug}
            title="Доступно только владельцу"
            hint="Управление банковскими подключениями и ключами доступно владельцу пространства."
          />
        </div>
      </>
    );
  }

  const runSync = (c: IntegrationConnection) => {
    sync.mutate(c.id, {
      onSuccess: (r) =>
        toast.success(
          r.created > 0
            ? `Загружено новых операций: ${r.created}${r.autoPosted ? `, из них проведено: ${r.autoPosted}` : ''}`
            : 'Новых операций нет',
        ),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Синхронизация не удалась'),
    });
  };

  const rows = connections.data ?? [];

  return (
    <>
      <PageHeader
        title="Интеграции"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Подключить банк
          </Button>
        }
      />

      <div className="px-6 py-4">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          Подключите расчётный счёт по API банка — операции будут поступать автоматически
          и попадать на обработку во «Входящие». Токен хранится в зашифрованном виде,
          наружу не отдаётся.
        </p>

        {rows.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="Пока нет подключений"
            hint="Подключите Альфа-Банк или Т-Банк, чтобы операции поступали автоматически."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                Подключить банк
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border rounded-md border border-border bg-card">
            {rows.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-[180px] flex-1">
                  <div className="font-medium">{PROVIDER_LABELS[c.provider]}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.account.name} · ключ …{c.keyLast4}
                  </div>
                </div>
                <div className="min-w-[140px]">
                  <StatusDot tone={STATUS[c.status].tone} label={STATUS[c.status].label} />
                  {c.status === 'ERROR' && c.lastSyncError && (
                    <div className="mt-0.5 max-w-[220px] truncate text-xs text-destructive" title={c.lastSyncError}>
                      {c.lastSyncError}
                    </div>
                  )}
                </div>
                <div className="min-w-[150px] text-xs text-muted-foreground">
                  {c.lastSyncAt
                    ? `Синхронизация: ${formatDateTime(c.lastSyncAt)}`
                    : 'Ещё не синхронизировано'}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => runSync(c)}
                    disabled={sync.isPending}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Обновить
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(c)} aria-label="Удалить">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateConnectionSheet
        open={creating}
        onClose={() => setCreating(false)}
        wsId={wsId ?? ''}
        accounts={(accounts.data ?? []).filter((a) => !a.isArchived).map((a) => ({ id: a.id, name: a.name }))}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Удалить подключение?"
        description="Синхронизация остановится. Уже загруженные операции останутся."
        confirmText="Удалить"
        onConfirm={() => {
          if (!deleting) return;
          del.mutate(deleting.id, {
            onSuccess: () => toast.success('Подключение удалено'),
            onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось удалить'),
          });
          setDeleting(null);
        }}
      />
    </>
  );
}

function CreateConnectionSheet({
  open,
  onClose,
  wsId,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  wsId: string;
  accounts: { id: string; name: string }[];
}) {
  const create = useCreateIntegration(wsId);
  const [provider, setProvider] = useState<IntegrationProvider>('ALFA');
  const [accountId, setAccountId] = useState('');
  const [token, setToken] = useState('');

  const reset = () => {
    setProvider('ALFA');
    setAccountId('');
    setToken('');
  };

  const submit = () => {
    if (!accountId || !token.trim()) return;
    create.mutate(
      { provider, accountId, token: token.trim() },
      {
        onSuccess: () => {
          toast.success('Банк подключён');
          reset();
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось подключить'),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px]">
        <SheetHeader>
          <SheetTitle>Подключить банк</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <FormField label="Банк">
            <Select value={provider} onChange={(e) => setProvider(e.target.value as IntegrationProvider)}>
              <option value="ALFA">Альфа-Банк</option>
              <option value="TBANK">Т-Банк</option>
            </Select>
          </FormField>
          <FormField label="Счёт" hint="Операции банка будут ложиться на этот счёт">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— выберите счёт —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Токен API" hint="Из личного кабинета банка. Хранится зашифрованным.">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Вставьте токен"
              autoComplete="off"
            />
          </FormField>
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!accountId || !token.trim() || create.isPending}>
            Подключить
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
