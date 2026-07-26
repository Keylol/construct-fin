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
                    {c.accountNumber && ` · счёт …${c.accountNumber.slice(-4)}`}
                  </div>
                  {c.tlsExpiresAt && <CertNote expiresAt={c.tlsExpiresAt} />}
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

/**
 * Срок действия клиентского сертификата. Предупреждаем заранее: истёкший
 * сертификат означает отказ TLS-рукопожатия, то есть молчаливо вставший синк.
 */
function CertNote({ expiresAt }: { expiresAt: string }) {
  const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  const tone =
    days < 0 ? 'text-destructive' : days <= 30 ? 'text-warning' : 'text-muted-foreground';
  const text =
    days < 0
      ? `Сертификат истёк ${formatDateTime(expiresAt)}`
      : days <= 30
        ? `Сертификат истекает через ${days} дн.`
        : `Сертификат до ${formatDateTime(expiresAt)}`;
  return <div className={`text-xs ${tone}`}>{text}</div>;
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
  const [accountNumber, setAccountNumber] = useState('');
  const [tlsCert, setTlsCert] = useState('');
  const [tlsKey, setTlsKey] = useState('');
  const [tlsPassphrase, setTlsPassphrase] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  // Оба банка принимают номер расчётного счёта параметром запроса выписки.
  const needsAccountNumber = provider === 'ALFA' || provider === 'TBANK';
  const accountNumberOk = !needsAccountNumber || /^\d{20}$/.test(accountNumber.trim());
  // Альфа пускает только по клиентскому сертификату, и он свой у каждой
  // компании — поэтому загружается в само подключение, а не в настройки сервера.
  const needsTls = provider === 'ALFA';
  const tlsOk = !needsTls || (tlsCert.trim() !== '' && tlsKey.trim() !== '');

  const readFile = (file: File | undefined, set: (v: string) => void) => {
    setFileError(null);
    if (!file) return;
    file
      .text()
      .then((text) => set(text))
      .catch(() => setFileError('Не удалось прочитать файл'));
  };

  const reset = () => {
    setProvider('ALFA');
    setAccountId('');
    setToken('');
    setAccountNumber('');
    setTlsCert('');
    setTlsKey('');
    setTlsPassphrase('');
    setFileError(null);
  };

  const submit = () => {
    if (!accountId || !token.trim() || !accountNumberOk || !tlsOk) return;
    create.mutate(
      {
        provider,
        accountId,
        token: token.trim(),
        ...(needsAccountNumber ? { accountNumber: accountNumber.trim() } : {}),
        ...(needsTls
          ? {
              tlsCert,
              tlsKey,
              ...(tlsPassphrase ? { tlsPassphrase } : {}),
            }
          : {}),
      },
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
          {needsAccountNumber && (
            <FormField
              label="Номер расчётного счёта"
              hint="20 цифр, как в реквизитах. По нему банк отдаёт выписку."
              error={
                accountNumber.trim() !== '' && !accountNumberOk ? 'Номер счёта — 20 цифр' : undefined
              }
            >
              <Input
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 20))}
                placeholder="40802810000000000000"
                inputMode="numeric"
                autoComplete="off"
              />
            </FormField>
          )}
          <FormField
            label={provider === 'ALFA' ? 'API Key' : 'Токен API'}
            hint={
              provider === 'ALFA'
                ? 'Выпускается на Портале разработчика Альфа-Банка. Хранится зашифрованным.'
                : 'ЛК Т-Бизнеса → Интеграции → Выпуск токена, доступ «Счета и выписки». Хранится зашифрованным.'
            }
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Вставьте ключ"
              autoComplete="off"
            />
          </FormField>
          {needsTls && (
            <>
              <FormField
                label="Сертификат (.cer)"
                hint="Клиентский сертификат из архива банка. Свой для каждой компании."
                error={fileError ?? undefined}
              >
                <input
                  type="file"
                  accept=".cer,.crt,.pem"
                  onChange={(e) => readFile(e.target.files?.[0], setTlsCert)}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
                />
                {tlsCert && <p className="mt-1 text-xs text-success">Файл загружен</p>}
              </FormField>
              <FormField
                label="Закрытый ключ (.key)"
                hint="Хранится в зашифрованном виде и наружу не отдаётся."
              >
                <input
                  type="file"
                  accept=".key,.pem"
                  onChange={(e) => readFile(e.target.files?.[0], setTlsKey)}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
                />
                {tlsKey && <p className="mt-1 text-xs text-success">Файл загружен</p>}
              </FormField>
              <FormField label="Пароль ключа" hint="Только если ключ защищён паролем.">
                <Input
                  type="password"
                  value={tlsPassphrase}
                  onChange={(e) => setTlsPassphrase(e.target.value)}
                  placeholder="Необязательно"
                  autoComplete="off"
                />
              </FormField>
            </>
          )}
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={submit}
            disabled={!accountId || !token.trim() || !accountNumberOk || !tlsOk || create.isPending}
          >
            Подключить
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
