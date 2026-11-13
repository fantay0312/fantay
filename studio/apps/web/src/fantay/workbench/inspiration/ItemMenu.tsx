'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — one item menu, drawn as a right-click ContextMenu or a ⋯ DropdownMenu.
 * Actions started on an item that is part of the selection apply to the whole selection.
 */
import type { ReactNode } from 'react';
import type { WorkbenchItem } from '@open-design/contracts';
import {
  ArchiveRestore, BookOpen, Check, ExternalLink, FileText, FolderInput, FolderPlus, Info, Sparkles, Star, StarOff, Tag, Trash2, WandSparkles, X,
} from 'lucide-react';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
  DropdownMenu, DropdownMenuCaption, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
  Icon,
} from '../../ui';
import { useL } from '../lang';
import { useActions, useLibraryState, type LibraryActions, type LibraryState } from './context';
import { SpaceGlyph } from './SpaceGlyph';

type Entry =
  | { type: 'item'; key: string; label: string; icon: ReactNode; onSelect(): void; tone?: 'danger'; shortcut?: string; disabled?: boolean }
  | { type: 'sep'; key: string }
  | { type: 'label'; key: string; label: string }
  | { type: 'sub'; key: string; label: string; icon: ReactNode; entries: Entry[] };

const glyph = (component: Parameters<typeof Icon>[0]['icon']) => <Icon icon={component} size="sm" />;

export function itemMenuEntries(item: WorkbenchItem, state: LibraryState, actions: LibraryActions, L: (zh: string, en: string) => string): Entry[] {
  const ids = actions.targetsFor(item.id);
  const targets = ids.map(id => state.byId.get(id)).filter((row): row is WorkbenchItem => Boolean(row));
  const many = targets.length > 1;
  const n = targets.length;
  const head: Entry[] = many ? [{ type: 'label', key: 'count', label: L(`已选 ${n} 条`, `${n} selected`) }] : [];

  if (item.trashedAt) {
    return [
      ...head,
      { type: 'item', key: 'restore', label: L('恢复', 'Restore'), icon: glyph(ArchiveRestore), onSelect: () => actions.restore(ids) },
      { type: 'sep', key: 's1' },
      { type: 'item', key: 'destroy', label: L('永久删除…', 'Delete forever…'), icon: glyph(X), tone: 'danger', onSelect: () => actions.deleteForever(ids) },
    ];
  }

  const allStarred = targets.every(row => row.starred);
  const anyInbox = targets.some(row => !row.triagedAt);
  const single = many ? null : item;
  const spaceEntries: Entry[] = [
    ...state.spaces.map<Entry>(space => ({
      type: 'item', key: `space-${space.id}`, label: space.name, icon: <SpaceGlyph color={space.color} size={16} />,
      disabled: targets.every(row => row.spaceId === space.id),
      onSelect: () => actions.moveToSpace(ids, space.id),
    })),
    ...(state.spaces.length ? [{ type: 'sep', key: 'space-sep' } as Entry] : []),
    { type: 'item', key: 'space-none', label: L('不放进空间', 'No space'), icon: glyph(X), disabled: targets.every(row => !row.spaceId), onSelect: () => actions.moveToSpace(ids, null) },
    { type: 'item', key: 'space-new', label: L('新建空间…', 'New space…'), icon: glyph(FolderPlus), onSelect: () => actions.createSpace(ids) },
  ];

  return [
    ...head,
    ...(single ? [
      { type: 'item', key: 'open', label: L('查看详情', 'Show details'), icon: glyph(Info), shortcut: 'enter', onSelect: () => actions.open(item.id) } as Entry,
      ...(single.kind === 'web' ? [{ type: 'item', key: 'read', label: L('阅读', 'Read'), icon: glyph(BookOpen), shortcut: 'r', onSelect: () => actions.openReader(item.id) } as Entry] : []),
      ...(single.url ? [{ type: 'item', key: 'url', label: L('打开原链接', 'Open original'), icon: glyph(ExternalLink), onSelect: () => window.open(single.url!, '_blank', 'noopener,noreferrer') } as Entry] : []),
      { type: 'sep', key: 's0' } as Entry,
    ] : []),
    { type: 'item', key: 'star', label: allStarred ? L('取消星标', 'Unstar') : L('加星标', 'Star'), icon: glyph(allStarred ? StarOff : Star), shortcut: 's', onSelect: () => actions.star(ids, !allStarred) },
    { type: 'sub', key: 'space', label: L('移到空间', 'Move to space'), icon: glyph(FolderInput), entries: spaceEntries },
    { type: 'item', key: 'tags', label: L('编辑标签…', 'Edit tags…'), icon: glyph(Tag), onSelect: () => actions.editTags(ids) },
    ...(anyInbox ? [{ type: 'item', key: 'keep', label: L('保留（移出收件箱）', 'Keep (leave Inbox)'), icon: glyph(Check), shortcut: 'e', onSelect: () => actions.keep(ids) } as Entry] : []),
    { type: 'sep', key: 's1' },
    { type: 'item', key: 'organize', label: L('AI 整理', 'Organise with AI'), icon: glyph(Sparkles), disabled: ids.some(id => state.organizing.has(id)), onSelect: () => { void actions.organize(ids); } },
    ...(single ? [
      { type: 'item', key: 'produce', label: L('一键成稿', 'Produce'), icon: glyph(WandSparkles), disabled: single.production?.status === 'running', onSelect: () => actions.produce(item.id) } as Entry,
      ...(single.production ? [{ type: 'item', key: 'studio', label: L('打开成稿', 'Open production'), icon: glyph(FileText), onSelect: () => actions.openProduction(item.id) } as Entry] : []),
    ] : []),
    { type: 'sep', key: 's2' },
    { type: 'item', key: 'trash', label: many ? L(`移到回收站（${n}）`, `Move ${n} to Trash`) : L('移到回收站', 'Move to Trash'), icon: glyph(Trash2), tone: 'danger', shortcut: 'backspace', onSelect: () => actions.trash(ids) },
  ];
}

function ContextEntries({ entries }: { entries: Entry[] }) {
  return (
    <>
      {entries.map((entry) => {
        if (entry.type === 'sep') return <ContextMenuSeparator key={entry.key} />;
        if (entry.type === 'label') return <ContextMenuLabel key={entry.key}>{entry.label}</ContextMenuLabel>;
        if (entry.type === 'sub') {
          return (
            <ContextMenuSub key={entry.key}>
              <ContextMenuSubTrigger icon={entry.icon}>{entry.label}</ContextMenuSubTrigger>
              <ContextMenuSubContent><ContextEntries entries={entry.entries} /></ContextMenuSubContent>
            </ContextMenuSub>
          );
        }
        return (
          <ContextMenuItem key={entry.key} icon={entry.icon} {...(entry.tone ? { tone: entry.tone } : {})} {...(entry.shortcut ? { shortcut: entry.shortcut } : {})} disabled={entry.disabled} onSelect={() => entry.onSelect()}>
            {entry.label}
          </ContextMenuItem>
        );
      })}
    </>
  );
}

function DropdownEntries({ entries }: { entries: Entry[] }) {
  return (
    <>
      {entries.map((entry) => {
        if (entry.type === 'sep') return <DropdownMenuSeparator key={entry.key} />;
        if (entry.type === 'label') return <DropdownMenuCaption key={entry.key}>{entry.label}</DropdownMenuCaption>;
        if (entry.type === 'sub') {
          return (
            <DropdownMenuSub key={entry.key}>
              <DropdownMenuSubTrigger icon={entry.icon}>{entry.label}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent><DropdownEntries entries={entry.entries} /></DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }
        return (
          <DropdownMenuItem key={entry.key} icon={entry.icon} {...(entry.tone ? { tone: entry.tone } : {})} {...(entry.shortcut ? { shortcut: entry.shortcut } : {})} disabled={entry.disabled} onSelect={() => entry.onSelect()}>
            {entry.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function ContextBody({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const state = useLibraryState();
  const actions = useActions();
  const live = state.byId.get(item.id) ?? item;
  return <ContextEntries entries={itemMenuEntries(live, state, actions, L)} />;
}

function DropdownBody({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const state = useLibraryState();
  const actions = useActions();
  const live = state.byId.get(item.id) ?? item;
  return <DropdownEntries entries={itemMenuEntries(live, state, actions, L)} />;
}

/** Right-click menu around a card. Right-clicking an unselected card selects it first (Finder). */
export function ItemContextMenu({ item, selected, children }: { item: WorkbenchItem; selected: boolean; children: ReactNode }) {
  const actions = useActions();
  return (
    <ContextMenu onOpenChange={(open) => { if (open && !selected) actions.select(item.id); }}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextBody item={item} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The same menu behind a ⋯ button. */
export function ItemDropdownMenu({ item, trigger, align = 'end' }: { item: WorkbenchItem; trigger: ReactNode; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent width="md" align={align}>
        <DropdownBody item={item} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
