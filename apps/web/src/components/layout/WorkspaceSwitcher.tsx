'use client';

import { useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { Button } from '@/components/ui/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { ChevronDown, Plus } from '@/components/ui/icons';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

/**
 * Пространство (один бизнес) в боковой панели: кнопка с именем и меню —
 * список пространств с галочкой на текущем и «Новое пространство». Раньше
 * здесь стоял native select с подписью и текстовая ссылка «+ Создать»,
 * не похожие ни на один контрол приложения.
 */
export function WorkspaceSwitcher() {
  const { current, workspaces, select } = useCurrentWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = workspaces.data ?? [];

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="w-full justify-between gap-2 px-2.5"
            aria-label="Пространство"
            title={current?.name}
          >
            <span className="min-w-0 truncate text-left">
              <span className="block text-[10px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
                Пространство
              </span>
              <span className="block truncate leading-tight">{current?.name ?? 'Нет пространств'}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="w-[var(--radix-popover-trigger-width)]" label="Пространство">
          {list.map((w) => (
            <MenuItem
              key={w.id}
              value={w.id}
              active={w.id === current?.id}
              onSelect={() => {
                select(w.id);
                setOpen(false);
              }}
            >
              {w.name}
            </MenuItem>
          ))}
          {list.length > 0 && <MenuSeparator />}
          <MenuItem
            icon={Plus}
            value="__new"
            onSelect={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            Новое пространство
          </MenuItem>
        </MenuContent>
      </Menu>

      <CreateWorkspaceModal open={creating} onOpenChange={setCreating} onCreated={select} />
    </>
  );
}
