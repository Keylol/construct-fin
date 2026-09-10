'use client';

import { useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { Button } from '@/components/ui/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { ChevronDown, LogOut, Plus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useRole } from '@/hooks/useRole';
import { api } from '@/lib/api';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

/** Инициалы пространства для узких мест: «ИП Каменский» → «ИК». */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length >= 2 ? [words[0]!, words[1]!] : [name]).map((w) => w[0] ?? '');
  return letters.join('').toUpperCase().slice(0, 2) || '·';
}

/**
 * Пространство (один бизнес): кнопка с именем и меню — список пространств с
 * галочкой на текущем, «Новое пространство» (владельцу) и «Выйти». Одно меню
 * в трёх местах, отличается только кнопка:
 *   panel — развёрнутая боковая панель: подпись + имя в две строки;
 *   rail  — свёрнутая рейка: квадрат с инициалами и подсказкой справа;
 *   bar   — шапка на телефоне: инициалы + имя, вместо отсутствующей панели.
 * Раньше в рейке на месте пространства оставалась пустая дыра, а на телефоне
 * сменить пространство или выйти было негде.
 */
export function WorkspaceSwitcher({ variant = 'panel' }: { variant?: 'panel' | 'rail' | 'bar' }) {
  const { current, workspaces, select } = useCurrentWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = workspaces.data ?? [];
  const { ownerSections, label: roleLabel } = useRole();

  // Выход — полной перезагрузкой: серверный layout заново спросит /auth/me,
  // кэш запросов не переживёт смену человека за тем же экраном.
  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      window.location.assign('/login');
    }
  };

  const name = current?.name ?? 'Нет пространств';
  const initials = current ? workspaceInitials(current.name) : '·';

  const trigger =
    variant === 'rail' ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <MenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="h-8 w-8 font-semibold tracking-wide"
              aria-label={`Пространство: ${name}`}
            >
              {initials}
            </Button>
          </MenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
      </Tooltip>
    ) : variant === 'bar' ? (
      <MenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 gap-2 px-1.5" aria-label="Пространство">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-primary text-[11px] font-semibold text-primary-foreground">
            {initials}
          </span>
          <span className="min-w-0 truncate font-medium">{name}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </MenuTrigger>
    ) : (
      <MenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="w-full justify-between gap-2 px-2.5"
          aria-label="Пространство"
        >
          <span className="min-w-0 truncate text-left">
            <span className="block text-[10px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
              Пространство
            </span>
            <span className="block truncate leading-tight">{name}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </MenuTrigger>
    );

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        {trigger}
        <MenuContent
          align="start"
          className={cn(variant === 'panel' && 'w-[var(--radix-popover-trigger-width)]', 'min-w-[220px]')}
          label="Пространство"
        >
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
          {/* Пространства заводит владелец; оператор входит в существующие. */}
          {ownerSections && (
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
          )}
          <MenuItem icon={LogOut} value="__logout" hint={roleLabel} onSelect={() => void logout()}>
            Выйти
          </MenuItem>
        </MenuContent>
      </Menu>

      <CreateWorkspaceModal open={creating} onOpenChange={setCreating} onCreated={select} />
    </>
  );
}
