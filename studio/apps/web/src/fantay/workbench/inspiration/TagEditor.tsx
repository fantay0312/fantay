'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — tag editor for one or many items (inspector, bulk popover, tag dialog).
 * Tags present on only some of the items show how many carry them; clicking one adds it to all.
 */
import { useMemo, useState } from 'react';
import type { WorkbenchItem } from '@open-design/contracts';
import { Plus } from 'lucide-react';
import { Chip, Icon, Input } from '../../ui';
import { useL } from '../lang';
import { workbench } from '../store';
import { parseTags } from './capture';
import { useActions, useLibraryState } from './context';
import { tagStats } from './library';
import styles from './Dialogs.module.css';

export function TagEditor({ ids, autoFocus = false, placeholder }: { ids: string[]; autoFocus?: boolean; placeholder?: string }) {
  const L = useL();
  const state = useLibraryState();
  const actions = useActions();
  const [draft, setDraft] = useState('');
  const targets = useMemo(() => ids.map(id => state.byId.get(id)).filter((item): item is WorkbenchItem => Boolean(item)), [ids, state.byId]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of targets) for (const tag of item.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [targets]);
  const all = useMemo(() => tagStats(state.items), [state.items]);
  const query = draft.trim().replace(/^#/, '').toLowerCase();
  const suggestions = all
    .filter(row => (counts.find(([tag]) => tag === row.tag)?.[1] ?? 0) < targets.length)
    .filter(row => !query || row.tag.toLowerCase().includes(query))
    .slice(0, 10);

  const add = (tags: string[]) => {
    if (!tags.length || !targets.length) return;
    void workbench.ops([{ op: 'tag_items', ids: targets.map(item => item.id), add: tags }], { label: L('添加标签', 'Add tags'), quiet: true });
  };
  const remove = (tag: string) => {
    void workbench.ops([{ op: 'tag_items', ids: targets.map(item => item.id), remove: [tag] }], { label: L('移除标签', 'Remove tag'), quiet: true });
  };
  const commit = () => {
    const tags = parseTags(draft);
    if (!tags.length) return;
    add(tags);
    setDraft('');
  };

  return (
    <div className={styles.tagEditor}>
      {counts.length ? (
        <div className={styles.tagList}>
          {counts.map(([tag, n]) => (n < targets.length ? (
            <Chip
              key={tag}
              size="sm"
              variant="suggestion"
              className={styles.tagChip}
              title={L(`${n}/${targets.length} 条带这个标签，点一下加到全部`, `On ${n} of ${targets.length}; click to add to all`)}
              onClick={() => add([tag])}
              onRemove={() => remove(tag)}
            >
              #{tag}
              <small className={styles.tagChipCount}>{n}/{targets.length}</small>
            </Chip>
          ) : (
            <Chip
              key={tag}
              size="sm"
              on
              className={styles.tagChip}
              title={L(`查看 #${tag} 下的灵感`, `Browse #${tag}`)}
              onClick={() => actions.navigate({ kind: 'tag', tag })}
              onRemove={() => remove(tag)}
            >
              #{tag}
            </Chip>
          )))}
        </div>
      ) : null}
      <div className={styles.tagInputRow}>
        <Input
          inputSize="sm"
          value={draft}
          autoFocus={autoFocus}
          placeholder={placeholder ?? L('添加标签，回车确认', 'Add a tag, press Enter')}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && !draft && counts.length) {
              const last = counts[counts.length - 1];
              if (last && last[1] === targets.length) remove(last[0]);
            }
            event.stopPropagation();
          }}
        />
      </div>
      {suggestions.length ? (
        <div className={styles.tagSuggestions}>
          {suggestions.map(row => (
            <Chip key={row.tag} size="sm" variant="suggestion" className={styles.tagChip} icon={<Icon icon={Plus} size={11} />} onClick={() => add([row.tag])}>
              {row.tag}
              <small className={styles.tagChipCount}>{row.count}</small>
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
