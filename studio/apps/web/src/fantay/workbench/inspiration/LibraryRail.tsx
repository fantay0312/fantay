'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — the library rail (Resurf): 全部 / 收件箱 / 星标 / 标签 / 回收站, the coloured
 * spaces, and capture / import at the bottom. Cards dragged from the grid or feed drop onto a space
 * (move), 星标 (star) or 回收站 (trash).
 */
import { useState, type DragEvent, type ReactNode } from 'react';
import type { WorkbenchSpace } from '@open-design/contracts';
import { WORKBENCH_SPACE_COLORS } from '@open-design/contracts';
import { Download, Hash, Inbox, Library, MoreHorizontal, PanelLeftClose, Palette, Pencil, Plus, Star, Tags, Trash2, Zap } from 'lucide-react';
import {
  Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
  Icon, IconButton,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { workbench } from '../store';
import { captureFiles, draggedIds, isInternalDrag } from './capture';
import { useActions } from './context';
import { SPACE_COLOR_LABEL, navKey, type LibNav, type LibraryCounts } from './library';
import { SpaceGlyph } from './SpaceGlyph';
import styles from './LibraryRail.module.css';

interface RailProps {
  open: boolean;
  onCollapse(): void;
  nav: LibNav;
  counts: LibraryCounts;
  spaces: WorkbenchSpace[];
  onOpenTags(): void;
  onEditSpace(space: WorkbenchSpace): void;
  onDeleteSpace(space: WorkbenchSpace): void;
  onImport(): void;
}

type DropKind = 'star' | 'trash' | { space: string };

function useDrop(kind: DropKind) {
  const L = useL();
  const actions = useActions();
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        const files = typeof kind === 'object' && [...event.dataTransfer.types].includes('Files');
        if (!isInternalDrag(event.dataTransfer) && !files) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        if (!isInternalDrag(event.dataTransfer)) {
          // Files dropped straight onto a space are captured into it.
          const files = [...event.dataTransfer.files];
          if (typeof kind === 'object' && files.length) {
            event.preventDefault();
            event.stopPropagation();
            setOver(false);
            void captureFiles(files, { spaceId: kind.space }, L);
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const ids = draggedIds(event.dataTransfer);
        if (!ids.length) return;
        if (kind === 'star') actions.star(ids, true);
        else if (kind === 'trash') actions.trash(ids);
        else actions.moveToSpace(ids, kind.space);
      },
    },
  };
}

function Row({ icon, label, count, active, onClick, drop, children, title }: {
  icon: ReactNode; label: string; count?: number; active: boolean; onClick(): void; drop?: DropKind; children?: ReactNode; title?: string;
}) {
  const target = useDrop(drop ?? 'star');
  return (
    <div className={styles.row} data-active={active ? '' : undefined} data-over={drop && target.over ? '' : undefined} {...(drop ? target.handlers : {})}>
      <Button variant="bare" className={styles.rowButton} onClick={onClick} aria-current={active ? 'page' : undefined} title={title}>
        <span className={styles.rowIcon}>{icon}</span>
        <span className={styles.rowLabel}>{label}</span>
        {count !== undefined ? <span className={styles.rowCount}>{count}</span> : null}
      </Button>
      {children}
    </div>
  );
}

function SpaceMenuItems({ space, kind, onEdit, onDelete }: { space: WorkbenchSpace; kind: 'context' | 'dropdown'; onEdit(): void; onDelete(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const recolour = (color: (typeof WORKBENCH_SPACE_COLORS)[number]) => {
    if (color !== space.color) void workbench.ops([{ op: 'update_space', id: space.id, color }], { label: L('换颜色', 'Recolour'), quiet: true });
  };
  const swatches = WORKBENCH_SPACE_COLORS.map(color => ({ color, label: SPACE_COLOR_LABEL[color][lang === 'zh' ? 0 : 1] }));
  if (kind === 'context') {
    return (
      <>
        <ContextMenuItem icon={<Icon icon={Pencil} size="sm" />} onSelect={onEdit}>{L('重命名…', 'Rename…')}</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={<Icon icon={Palette} size="sm" />}>{L('颜色', 'Colour')}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {swatches.map(s => (
              <ContextMenuItem key={s.color} icon={<SpaceGlyph color={s.color} size={16} />} disabled={s.color === space.color} onSelect={() => recolour(s.color)}>{s.label}</ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem tone="danger" icon={<Icon icon={Trash2} size="sm" />} onSelect={onDelete}>{L('删除空间…', 'Delete space…')}</ContextMenuItem>
      </>
    );
  }
  return (
    <>
      <DropdownMenuItem icon={<Icon icon={Pencil} size="sm" />} onSelect={onEdit}>{L('重命名…', 'Rename…')}</DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger icon={<Icon icon={Palette} size="sm" />}>{L('颜色', 'Colour')}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {swatches.map(s => (
            <DropdownMenuItem key={s.color} icon={<SpaceGlyph color={s.color} size={16} />} disabled={s.color === space.color} onSelect={() => recolour(s.color)}>{s.label}</DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem tone="danger" icon={<Icon icon={Trash2} size="sm" />} onSelect={onDelete}>{L('删除空间…', 'Delete space…')}</DropdownMenuItem>
    </>
  );
}

function SpaceRow({ space, count, active, index, onEdit, onDelete }: { space: WorkbenchSpace; count: number; active: boolean; index: number; onEdit(): void; onDelete(): void }) {
  const L = useL();
  const actions = useActions();
  const target = useDrop({ space: space.id });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={styles.row} data-active={active ? '' : undefined} data-over={target.over ? '' : undefined} {...target.handlers}>
          <Button
            variant="bare"
            className={styles.rowButton}
            aria-current={active ? 'page' : undefined}
            onClick={() => actions.navigate({ kind: 'space', id: space.id })}
            title={index < 9 ? L(`选中灵感后按 ${index + 1} 移到这里`, `With ideas selected, press ${index + 1} to move them here`) : undefined}
          >
            <span className={styles.rowIcon}><SpaceGlyph color={space.color} size={18} /></span>
            <span className={styles.rowLabel}>{space.name}</span>
            <span className={styles.rowCount}>{count}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="xs" className={styles.rowMore} aria-label={L(`${space.name} 的更多操作`, `More for ${space.name}`)} tooltip={false}>
                <Icon icon={MoreHorizontal} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent width="md" align="start">
              <SpaceMenuItems space={space} kind="dropdown" onEdit={onEdit} onDelete={onDelete} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SpaceMenuItems space={space} kind="context" onEdit={onEdit} onDelete={onDelete} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function LibraryRail({ open, onCollapse, nav, counts, spaces, onOpenTags, onEditSpace, onDeleteSpace, onImport }: RailProps) {
  const L = useL();
  const actions = useActions();
  const key = navKey(nav);
  const go = (next: LibNav) => actions.navigate(next);
  return (
    <aside className={styles.dock} data-open={open ? '' : undefined} aria-label={L('灵感库', 'Library')} aria-hidden={!open}>
      <div className={styles.inner} {...(open ? {} : { inert: true })}>
        <header className={styles.head}>
          <span className={styles.headTitle}>{L('灵感库', 'Library')}</span>
          <IconButton size="sm" aria-label={L('收起侧栏', 'Hide sidebar')} tooltipSide="right" onClick={onCollapse}><Icon icon={PanelLeftClose} /></IconButton>
        </header>

        <nav className={styles.scroll} aria-label={L('灵感库导航', 'Library navigation')}>
          <div className={styles.group}>
            <Row icon={<Icon icon={Library} />} label={L('全部', 'Library')} count={counts.library} active={key === 'library'} onClick={() => go({ kind: 'library' })} />
            <Row icon={<Icon icon={Inbox} />} label={L('收件箱', 'Inbox')} count={counts.inbox} active={key === 'inbox'} onClick={() => go({ kind: 'inbox' })} />
            <Row icon={<Icon icon={Star} />} label={L('星标', 'Starred')} count={counts.starred} active={key === 'starred'} onClick={() => go({ kind: 'starred' })} drop="star" title={L('把卡片拖到这里加星标', 'Drop cards here to star them')} />
            <Row icon={<Icon icon={Tags} />} label={L('标签', 'Tags')} count={counts.tags} active={nav.kind === 'tag'} onClick={onOpenTags} />
            {nav.kind === 'tag' ? (
              <div className={styles.subRow}>
                <Icon icon={Hash} size={12} />
                <span>{nav.tag}</span>
              </div>
            ) : null}
            <Row icon={<Icon icon={Trash2} />} label={L('回收站', 'Trash')} count={counts.trash} active={key === 'trash'} onClick={() => go({ kind: 'trash' })} drop="trash" title={L('把卡片拖到这里删除', 'Drop cards here to trash them')} />
          </div>

          <div className={styles.sectionHead}>
            <span>{L('空间', 'Spaces')}</span>
            <IconButton size="xs" aria-label={L('新建空间', 'New space')} onClick={() => actions.createSpace()}><Icon icon={Plus} /></IconButton>
          </div>
          <div className={styles.group}>
            {spaces.map((space, index) => (
              <SpaceRow
                key={space.id}
                space={space}
                index={index}
                count={counts.spaces[space.id] ?? 0}
                active={key === `space:${space.id}`}
                onEdit={() => onEditSpace(space)}
                onDelete={() => onDeleteSpace(space)}
              />
            ))}
            {!spaces.length ? (
              <Button variant="bare" block className={styles.spaceEmpty} onClick={() => actions.createSpace()}>
                <Icon icon={Plus} size={13} />
                {L('建一个空间，像文件夹一样归类灵感', 'Create a space to file ideas like folders')}
              </Button>
            ) : null}
          </div>
        </nav>

        <footer className={styles.foot}>
          <Button variant="ghost" size="sm" className={styles.captureButton} onClick={() => actions.capture()}>
            <Icon icon={Zap} />
            {L('快速记录', 'Quick capture')}
          </Button>
          <IconButton size="md" aria-label={L('导入账号内容', 'Import from an account')} onClick={onImport}><Icon icon={Download} /></IconButton>
        </footer>
      </div>
    </aside>
  );
}
