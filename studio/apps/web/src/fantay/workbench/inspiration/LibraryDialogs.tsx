'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — library management dialogs: create / edit a space, manage tags (rename,
 * delete, merge), edit tags of a selection, and the 重温 (resurface) batch.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchItem, WorkbenchSpace, WorkbenchSpaceColor } from '@open-design/contracts';
import { WORKBENCH_SPACE_COLORS } from '@open-design/contracts';
import { Check, Pencil, Shuffle, Trash2 } from 'lucide-react';
import {
  Button, Checkbox, ConfirmDialog, Icon, IconButton, Input, Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle, SearchField,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { relativeDay } from '../shared/format';
import { workbench } from '../store';
import { useActions, useLibraryState } from './context';
import { ItemCard } from './ItemCard';
import { SPACE_COLOR_LABEL, inLibrary, resurfaceBatch, tagStats } from './library';
import { SpaceGlyph } from './SpaceGlyph';
import { TagEditor } from './TagEditor';
import styles from './Dialogs.module.css';

// ── Space ───────────────────────────────────────────────────────────

export interface SpaceDialogState { space: WorkbenchSpace | null; moveIds: string[] }

export function SpaceDialog({ request, onClose }: { request: SpaceDialogState | null; onClose(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const state = useLibraryState();
  const [name, setName] = useState('');
  const [color, setColor] = useState<WorkbenchSpaceColor>('blue');
  const [busy, setBusy] = useState(false);
  const open = Boolean(request);
  const editing = request?.space ?? null;

  useEffect(() => {
    if (!request) return;
    setName(request.space?.name ?? '');
    const used = new Set(state.spaces.map(space => space.color));
    setColor(request.space?.color ?? WORKBENCH_SPACE_COLORS.find(c => !used.has(c)) ?? 'blue');
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const save = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    if (editing) {
      await workbench.ops([{ op: 'update_space', id: editing.id, name: value, color }], { label: L('修改空间', 'Edit space') });
      setBusy(false);
      onClose();
      return;
    }
    const before = new Set(state.spaces.map(space => space.id));
    const response = await workbench.ops([{ op: 'add_space', name: value, color }], { label: L('新建空间', 'New space'), quiet: Boolean(request?.moveIds.length) });
    const created = response?.state.spaces.find(space => !before.has(space.id));
    if (created && request?.moveIds.length) {
      await workbench.ops([{ op: 'move_to_space', ids: request.moveIds, spaceId: created.id }], { label: L(`移到「${created.name}」`, `Move to ${created.name}`) });
    }
    setBusy(false);
    if (response && !response.errors.length) onClose();
  };

  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalTitle>{editing ? L('编辑空间', 'Edit space') : L('新建空间', 'New space')}</ModalTitle>
      <ModalLede>
        {request?.moveIds.length
          ? L(`建好后，选中的 ${request.moveIds.length} 条灵感会放进去。`, `The ${request.moveIds.length} selected idea${request.moveIds.length === 1 ? '' : 's'} will move in.`)
          : L('空间像文件夹：一条灵感放在一个空间里，拖动卡片到左侧就能放进来。', 'Spaces are folders: drag cards onto one in the sidebar to file them.')}
      </ModalLede>
      <form className={styles.spaceForm} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className={styles.spacePreview}>
          <SpaceGlyph color={color} size={40} />
          <Input
            variant="well"
            inputSize="lg"
            autoFocus
            value={name}
            maxLength={40}
            placeholder={L('空间名称，例如「选题库」', 'Space name, e.g. "Topics"')}
            onChange={event => setName(event.target.value)}
            aria-label={L('空间名称', 'Space name')}
          />
        </div>
        <div className={styles.swatches} role="radiogroup" aria-label={L('颜色', 'Colour')}>
          {WORKBENCH_SPACE_COLORS.map(value => (
            <IconButton
              key={value}
              size="lg"
              role="radio"
              aria-checked={color === value}
              aria-label={SPACE_COLOR_LABEL[value][lang === 'zh' ? 0 : 1]}
              className={styles.swatch}
              onClick={() => setColor(value)}
            >
              <SpaceGlyph color={value} size={22} />
              {color === value ? <span className={styles.swatchCheck}><Icon icon={Check} size={10} strokeWidth={2.5} /></span> : null}
            </IconButton>
          ))}
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!name.trim()}>{editing ? L('保存', 'Save') : L('创建', 'Create')}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Tags management ─────────────────────────────────────────────────

export function TagsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const L = useL();
  const state = useLibraryState();
  const actions = useActions();
  const stats = useMemo(() => tagStats(state.items), [state.items]);
  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setChecked(new Set());
    setRenaming(null);
  }, [open]);

  useEffect(() => {
    // Default merge target: the most used of the checked tags.
    const first = stats.find(row => checked.has(row.tag));
    setMergeInto(first?.tag ?? '');
  }, [checked, stats]);

  const shown = stats.filter(row => !filter.trim() || row.tag.toLowerCase().includes(filter.trim().toLowerCase().replace(/^#/, '')));
  const toggle = (tag: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    return next;
  });

  const rename = async (from: string) => {
    const to = renameValue.trim().replace(/^#/, '');
    setRenaming(null);
    if (!to || to === from) return;
    await workbench.ops([{ op: 'rename_tag', from, to }], { label: L('重命名标签', 'Rename tag') });
  };
  const merge = async () => {
    const to = mergeInto.trim().replace(/^#/, '');
    if (!to) return;
    const ops = [...checked].filter(tag => tag !== to).map(from => ({ op: 'rename_tag' as const, from, to }));
    if (!ops.length) return;
    const response = await workbench.ops(ops, { label: L('合并标签', 'Merge tags') });
    if (response && !response.errors.length) setChecked(new Set());
  };
  const deletingCount = stats.find(row => row.tag === deleting)?.count ?? 0;

  return (
    <>
      <Modal open={open} onClose={onClose} size="md">
        <ModalTitle>{L('标签', 'Tags')}</ModalTitle>
        <ModalLede>
          {stats.length
            ? L(`${stats.length} 个标签。点名字查看灵感，勾选几个可以合并成一个。`, `${stats.length} tag${stats.length === 1 ? '' : 's'}. Click a name to browse; check several to merge them.`)
            : L('还没有标签。在详情面板里给灵感加标签，或者让 AI 整理时自动打上。', 'No tags yet. Add them in the inspector, or let AI organise tag them for you.')}
        </ModalLede>
        {stats.length ? (
          <>
            <SearchField className={styles.tagsSearch} value={filter} onChange={event => setFilter(event.target.value)} placeholder={L('筛选标签', 'Filter tags')} />
            <ul className={styles.tagRows}>
              {shown.map(row => (
                <li key={row.tag} className={styles.tagRow} data-checked={checked.has(row.tag) ? '' : undefined}>
                  <Checkbox checked={checked.has(row.tag)} onChange={() => toggle(row.tag)} aria-label={L(`选择 ${row.tag}`, `Select ${row.tag}`)} />
                  {renaming === row.tag ? (
                    <Input
                      inputSize="sm"
                      autoFocus
                      value={renameValue}
                      onChange={event => setRenameValue(event.target.value)}
                      onBlur={() => { void rename(row.tag); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void rename(row.tag); }
                        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); }
                      }}
                      className={styles.tagRename}
                    />
                  ) : (
                    <Button variant="bare" size="sm" className={styles.tagName} onClick={() => { actions.navigate({ kind: 'tag', tag: row.tag }); onClose(); }}>
                      #{row.tag}
                    </Button>
                  )}
                  <span className={styles.tagCount}>{row.count}</span>
                  <span className={styles.tagRowActions}>
                    <IconButton size="sm" aria-label={L('重命名', 'Rename')} onClick={() => { setRenaming(row.tag); setRenameValue(row.tag); }}><Icon icon={Pencil} /></IconButton>
                    <IconButton size="sm" variant="danger" aria-label={L('删除标签', 'Delete tag')} onClick={() => setDeleting(row.tag)}><Icon icon={Trash2} /></IconButton>
                  </span>
                </li>
              ))}
              {!shown.length ? <li className={styles.tagEmpty}>{L('没有匹配的标签', 'No matching tags')}</li> : null}
            </ul>
          </>
        ) : null}
        <ModalActions className={styles.mergeRow}>
          {checked.size >= 2 ? (
            <>
              <span className={styles.mergeLabel}>{L(`把 ${checked.size} 个标签合并为`, `Merge ${checked.size} tags into`)}</span>
              <Input inputSize="md" className={styles.mergeInput} value={mergeInto} onChange={event => setMergeInto(event.target.value)} aria-label={L('合并后的标签', 'Merged tag')} />
              <Button variant="primary" onClick={() => { void merge(); }} disabled={!mergeInto.trim()}>{L('合并', 'Merge')}</Button>
            </>
          ) : (
            <>
              <ModalSpacer />
              <Button variant="ghost" onClick={onClose}>{L('完成', 'Done')}</Button>
            </>
          )}
        </ModalActions>
      </Modal>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => { if (!next) setDeleting(null); }}
        title={L(`删除标签「${deleting ?? ''}」？`, `Delete tag "${deleting ?? ''}"?`)}
        description={L(`会从 ${deletingCount} 条灵感上移除这个标签，灵感本身不受影响。`, `It is removed from ${deletingCount} idea${deletingCount === 1 ? '' : 's'}; the ideas stay.`)}
        confirmLabel={L('删除标签', 'Delete tag')}
        cancelLabel={L('取消', 'Cancel')}
        destructive
        onConfirm={() => {
          const tag = deleting;
          setDeleting(null);
          if (tag) void workbench.ops([{ op: 'delete_tag', tag }], { label: L('删除标签', 'Delete tag') });
        }}
      />
    </>
  );
}

// ── Tags of a selection ─────────────────────────────────────────────

export function TagEditDialog({ ids, onClose }: { ids: string[] | null; onClose(): void }) {
  const L = useL();
  const n = ids?.length ?? 0;
  return (
    <Modal open={Boolean(ids)} onClose={onClose} size="sm">
      <ModalTitle>{n > 1 ? L(`编辑 ${n} 条灵感的标签`, `Tags of ${n} ideas`) : L('编辑标签', 'Edit tags')}</ModalTitle>
      <ModalLede>{n > 1 ? L('带数字的标签只在部分灵感上，点一下加到全部。', 'Numbered tags are on some of them; click one to add it to all.') : L('回车添加，点 × 移除。', 'Enter adds a tag, × removes it.')}</ModalLede>
      <div className={styles.tagDialogBody}>{ids ? <TagEditor ids={ids} autoFocus /> : null}</div>
      <ModalActions>
        <Button variant="primary" onClick={onClose}>{L('完成', 'Done')}</Button>
      </ModalActions>
    </Modal>
  );
}

// ── Resurface ───────────────────────────────────────────────────────

export function ResurfaceDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const state = useLibraryState();
  const actions = useActions();
  const [batch, setBatch] = useState<WorkbenchItem[]>([]);
  const itemsRef = useRef(state.items);
  itemsRef.current = state.items;

  const roll = () => {
    const next = resurfaceBatch(itemsRef.current, 6);
    setBatch(next);
    if (next.length) void workbench.ops([{ op: 'mark_surfaced', ids: next.map(item => item.id) }], { undoable: false, quiet: true });
  };

  useEffect(() => {
    if (open) roll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // `batch` keeps the snapshot from before mark_surfaced, so it still knows when each was last seen.
  const seenBefore = new Map(batch.map(item => [item.id, item.lastSurfacedAt ?? null]));
  const live = batch.map(item => state.byId.get(item.id) ?? item).filter(inLibrary);

  return (
    <Modal open={open} onClose={onClose} size="2xl">
      <ModalTitle>{L('重温', 'Resurface')}</ModalTitle>
      <ModalLede>{L('从很久没看的灵感里随机挑几条。点一张卡片在详情里打开。', 'A few ideas you have not seen in a while. Click a card to open it.')}</ModalLede>
      {live.length ? (
        <div className={styles.resurfaceGrid}>
          {live.map(item => (
            <div
              key={item.id}
              className={styles.resurfaceCell}
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest('button')) return;
                event.stopPropagation();
                actions.open(item.id);
                onClose();
              }}
            >
              <ItemCard item={item} selected={false} />
              <p className={styles.resurfaceWhen}>
                {seenBefore.get(item.id)
                  ? L(`上次重温：${relativeDay(seenBefore.get(item.id)!, lang)}`, `Last seen ${relativeDay(seenBefore.get(item.id)!, lang)}`)
                  : L(`记于 ${relativeDay(item.createdAt, lang)}，还没重温过`, `Saved ${relativeDay(item.createdAt, lang)}, never resurfaced`)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.resurfaceEmpty}>{L('灵感库里还没有可以重温的内容。', 'Nothing to resurface yet.')}</p>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>{L('关闭', 'Close')}</Button>
        <Button variant="primary" onClick={roll} disabled={!state.items.some(inLibrary)}>
          <Icon icon={Shuffle} />
          {L('换一批', 'Shuffle again')}
        </Button>
      </ModalActions>
    </Modal>
  );
}
