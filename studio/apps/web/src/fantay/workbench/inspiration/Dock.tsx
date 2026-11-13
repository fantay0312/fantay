'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — the floating bottom chrome: the view dock (网格 / 画布 / 信息流, sort,
 * density), the bulk bar that replaces it while items are selected, and the 🔀 resurface button.
 * Both bars stay mounted and cross-fade, so the exit plays.
 */
import type { WorkbenchItem } from '@open-design/contracts';
import {
  ArchiveRestore, ArrowDownUp, Check, FolderInput, FolderPlus, Grid2x2, Grid3x3, LayoutGrid, Rows3, Shapes, Shuffle, Sparkles, Star, Tag, Trash2, WandSparkles, X,
} from 'lucide-react';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Icon, IconButton, Popover, PopoverContent, PopoverTrigger, Segmented, SegmentedIconItem, SegmentedIcons, SegmentedItem, Tooltip,
} from '../../ui';
import { useL } from '../lang';
import { useActions, useLibraryState } from './context';
import type { Density, SortMode, ViewMode } from './library';
import { SpaceGlyph } from './SpaceGlyph';
import { TagEditor } from './TagEditor';
import styles from './Dock.module.css';

const SORTS: Array<[SortMode, string, string]> = [['newest', '最新', 'Newest'], ['oldest', '最早', 'Oldest'], ['updated', '最近更新', 'Recently updated'], ['random', '随机', 'Random']];

export function ViewDock({ hidden, mode, onMode, sort, onSort, density, onDensity, canvasAllowed }: {
  hidden: boolean;
  mode: ViewMode;
  onMode(mode: ViewMode): void;
  sort: SortMode;
  onSort(sort: SortMode): void;
  density: Density;
  onDensity(density: Density): void;
  canvasAllowed: boolean;
}) {
  const L = useL();
  const sortLabel = SORTS.find(([value]) => value === sort)!;
  return (
    <div className={styles.dock} data-hidden={hidden ? '' : undefined} role="toolbar" aria-label={L('视图', 'View')} {...(hidden ? { inert: true } : {})}>
      <Segmented value={mode} onValueChange={value => onMode(value as ViewMode)} aria-label={L('展示方式', 'Layout')} className={styles.views}>
        <SegmentedItem value="grid"><Icon icon={LayoutGrid} />{L('网格', 'Grid')}</SegmentedItem>
        <SegmentedItem value="canvas" disabled={!canvasAllowed}><Icon icon={Shapes} />{L('画布', 'Canvas')}</SegmentedItem>
        <SegmentedItem value="feed"><Icon icon={Rows3} />{L('信息流', 'Feed')}</SegmentedItem>
      </Segmented>
      {mode !== 'canvas' ? (
        <>
          <span className={styles.sep} />
          <DropdownMenu>
            <Tooltip label={L('排序', 'Sort')}>
              <DropdownMenuTrigger asChild>
                <Button variant="bare" size="sm" className={styles.sortButton} aria-label={L(`排序：${sortLabel[1]}`, `Sort: ${sortLabel[2]}`)}>
                  <Icon icon={ArrowDownUp} size={14} />
                  {L(sortLabel[1], sortLabel[2])}
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent width="sm" align="center" side="top">
              <DropdownMenuRadioGroup value={sort} onValueChange={value => onSort(value as SortMode)}>
                {SORTS.map(([value, zh, en]) => <DropdownMenuRadioItem key={value} value={value}>{L(zh, en)}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
      {mode === 'grid' ? (
        <SegmentedIcons value={density} onValueChange={value => onDensity(value as Density)} aria-label={L('卡片大小', 'Card size')} size="sm" className={styles.density}>
          <Tooltip label={L('小卡片', 'Small cards')}><SegmentedIconItem value="s" aria-label={L('小卡片', 'Small cards')}><Icon icon={Grid3x3} /></SegmentedIconItem></Tooltip>
          <Tooltip label={L('中卡片', 'Medium cards')}><SegmentedIconItem value="m" aria-label={L('中卡片', 'Medium cards')}><Icon icon={LayoutGrid} /></SegmentedIconItem></Tooltip>
          <Tooltip label={L('大卡片', 'Large cards')}><SegmentedIconItem value="l" aria-label={L('大卡片', 'Large cards')}><Icon icon={Grid2x2} /></SegmentedIconItem></Tooltip>
        </SegmentedIcons>
      ) : null}
    </div>
  );
}

export function BulkBar({ ids, visible, inTrash }: { ids: string[]; visible: boolean; inTrash: boolean }) {
  const L = useL();
  const state = useLibraryState();
  const actions = useActions();
  const items = ids.map(id => state.byId.get(id)).filter((item): item is WorkbenchItem => Boolean(item));
  const n = items.length;
  const allStarred = n > 0 && items.every(item => item.starred);
  const anyInbox = items.some(item => !item.triagedAt);
  const busy = ids.some(id => state.organizing.has(id));
  const single = n === 1 ? items[0]! : null;
  const label = (zh: string, en: string) => L(zh, en);
  return (
    <div className={styles.bulk} data-hidden={visible ? undefined : ''} role="toolbar" aria-label={L('批量操作', 'Bulk actions')} {...(visible ? {} : { inert: true })}>
      <span className={styles.bulkCount}>{L(`已选 ${n} 条`, `${n} selected`)}</span>
      <IconButton size="sm" aria-label={L('取消选择', 'Clear selection')} shortcut="esc" onClick={actions.clearSelection}><Icon icon={X} /></IconButton>
      <span className={styles.sep} />
      {inTrash ? (
        <>
          <Button variant="bare" size="sm" className={styles.bulkButton} onClick={() => actions.restore(ids)}><Icon icon={ArchiveRestore} size={14} />{label('恢复', 'Restore')}</Button>
          <Button variant="bare" size="sm" className={styles.bulkButton} data-tone="danger" onClick={() => actions.deleteForever(ids)}><Icon icon={Trash2} size={14} />{label('永久删除', 'Delete forever')}</Button>
        </>
      ) : (
        <>
          <Button variant="bare" size="sm" className={styles.bulkButton} onClick={() => actions.star(ids, !allStarred)}>
            <Icon icon={Star} size={14} fill={allStarred ? 'currentColor' : 'none'} />
            {allStarred ? label('取消星标', 'Unstar') : label('星标', 'Star')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="bare" size="sm" className={styles.bulkButton}><Icon icon={FolderInput} size={14} />{label('移到空间', 'Move')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent width="md" side="top" align="center">
              {state.spaces.map(space => (
                <DropdownMenuItem key={space.id} icon={<SpaceGlyph color={space.color} size={16} />} onSelect={() => actions.moveToSpace(ids, space.id)}>{space.name}</DropdownMenuItem>
              ))}
              {state.spaces.length ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem icon={<Icon icon={X} size="sm" />} onSelect={() => actions.moveToSpace(ids, null)}>{label('不放进空间', 'No space')}</DropdownMenuItem>
              <DropdownMenuItem icon={<Icon icon={FolderPlus} size="sm" />} onSelect={() => actions.createSpace(ids)}>{label('新建空间…', 'New space…')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="bare" size="sm" className={styles.bulkButton}><Icon icon={Tag} size={14} />{label('标签', 'Tags')}</Button>
            </PopoverTrigger>
            <PopoverContent side="top" width="lg" className={styles.tagPop}>
              <TagEditor ids={ids} autoFocus />
            </PopoverContent>
          </Popover>
          {anyInbox ? (
            <Tooltip label={L('留在灵感库，移出收件箱', 'Keep in the library, leave the Inbox')} shortcut="e">
              <Button variant="bare" size="sm" className={styles.bulkButton} onClick={() => actions.keep(ids)}><Icon icon={Check} size={14} />{label('保留', 'Keep')}</Button>
            </Tooltip>
          ) : null}
          <Button variant="bare" size="sm" className={styles.bulkButton} disabled={busy} onClick={() => { void actions.organize(ids); }}>
            <Icon icon={Sparkles} size={14} />{busy ? label('整理中…', 'Organising…') : label('AI 整理', 'Organise')}
          </Button>
          <Button
            variant="bare"
            size="sm"
            className={styles.bulkButton}
            disabled={!single || single.production?.status === 'running'}
            disabledReason={!single ? L('一次成稿一条：先只选一条', 'Produce one at a time: select a single idea') : L('这条正在成稿', 'Already producing')}
            onClick={() => { if (single) actions.produce(single.id); }}
          >
            <Icon icon={WandSparkles} size={14} />{label('一键成稿', 'Produce')}
          </Button>
          <span className={styles.sep} />
          <Button variant="bare" size="sm" className={styles.bulkButton} data-tone="danger" onClick={() => actions.trash(ids)}><Icon icon={Trash2} size={14} />{label('删除', 'Delete')}</Button>
        </>
      )}
    </div>
  );
}

export function ShuffleButton({ onClick }: { onClick(): void }) {
  const L = useL();
  return (
    <div className={styles.shuffle}>
      <IconButton variant="frosted" size="lg" shape="round" aria-label={L('重温：随机看几条很久没看的灵感', 'Resurface: a few ideas you have not seen in a while')} tooltipSide="right" onClick={onClick}>
        <Icon icon={Shuffle} />
      </IconButton>
    </div>
  );
}
