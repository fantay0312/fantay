'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — rows above the cards (今天重温, inbox triage hints, trash, search status)
 * and the empty / loading / error states of every view.
 */
import type { CSSProperties, ReactElement } from 'react';
import type { WorkbenchItem } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import { ArchiveX, Inbox, Library, SearchX, Shuffle, Sparkles, Star, Tag, Trash2, X, Zap } from 'lucide-react';
import { Button, EmptyState, Icon, IconButton, KbdCombo, Skeleton } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, kindLabel, posterOf, relativeDay } from '../shared/format';
import { useActions } from './context';
import type { LibNav } from './library';
import styles from './Views.module.css';

export function ResurfaceStrip({ items, onMore, onHide }: { items: WorkbenchItem[]; onMore(): void; onHide(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const actions = useActions();
  if (!items.length) return null;
  return (
    <section className={styles.strip} aria-label={L('今天重温', 'Resurfaced today')}>
      <header className={styles.stripHead}>
        <Icon icon={Shuffle} size={14} />
        <b>{L('今天重温', 'Resurfaced today')}</b>
        <span>{L('很久没看的几条，也许今天用得上', 'A few you have not seen in a while')}</span>
        <span className={styles.stripSpacer} />
        <Button variant="bare" size="sm" onClick={onMore}>{L('再来几条', 'More')}</Button>
        <IconButton size="sm" aria-label={L('今天不再显示', 'Hide for today')} onClick={onHide}><Icon icon={X} /></IconButton>
      </header>
      <div className={styles.stripRow}>
        {items.map((raw, index) => {
          const item = displayItem(raw);
          const poster = workbenchMediaUrl(posterOf(item));
          return (
            <Button
              key={raw.id}
              variant="bare"
              className={styles.resurface}
              style={{ animationDelay: `${index * 60}ms` } as CSSProperties}
              onClick={() => actions.open(raw.id)}
            >
              <span className={styles.resurfaceThumb}>
                {poster ? <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>{(item.title || '·').slice(0, 1)}</span>}
              </span>
              <span className={styles.resurfaceText}>
                <span className={styles.resurfaceTitle}>{item.title || L('无标题', 'Untitled')}</span>
                <span className={styles.resurfaceMeta}>
                  {kindLabel(raw.kind, lang)} · {raw.lastSurfacedAt ? L(`上次见 ${relativeDay(raw.lastSurfacedAt, lang)}`, `seen ${relativeDay(raw.lastSurfacedAt, lang)}`) : L(`记于 ${relativeDay(raw.createdAt, lang)}`, `saved ${relativeDay(raw.createdAt, lang)}`)}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

const HINTS: Array<[string, string, string]> = [
  ['j', '下一条', 'next'], ['k', '上一条', 'previous'], ['s', '星标', 'star'], ['e', '保留', 'keep'], ['backspace', '删除', 'delete'], ['enter', '打开', 'open'],
];

export function TriageRow({ count, spaces, organizing, onOrganize }: { count: number; spaces: number; organizing: boolean; onOrganize(): void }) {
  const L = useL();
  return (
    <div className={styles.triage}>
      <span className={styles.triageLead}>{L(`${count} 条待整理`, `${count} to triage`)}</span>
      <div className={styles.hints} aria-label={L('键盘整理', 'Keyboard triage')}>
        {HINTS.map(([key, zh, en]) => (
          <span key={key} className={styles.hint}><KbdCombo shortcut={key} />{L(zh, en)}</span>
        ))}
        {spaces ? (
          <span className={styles.hint}>
            <KbdCombo shortcut="1" />–<KbdCombo shortcut={String(Math.min(spaces, 9))} />
            {L('移到第 N 个空间', 'move to space N')}
          </span>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" loading={organizing} disabled={!count} onClick={onOrganize}>
        <Icon icon={Sparkles} />
        {L('AI 整理收件箱', 'Organise the Inbox')}
      </Button>
    </div>
  );
}

export function TrashRow({ count, onEmpty }: { count: number; onEmpty(): void }) {
  const L = useL();
  return (
    <div className={styles.triage}>
      <span className={styles.triageLead}>{L(`回收站里有 ${count} 条`, `${count} in Trash`)}</span>
      <span className={styles.hints}>{L('选中后可以恢复，或者永久删除。', 'Select items to restore them or delete them for good.')}</span>
      <Button variant="danger" size="sm" disabled={!count} onClick={onEmpty}>
        <Icon icon={Trash2} />
        {L('清空回收站', 'Empty Trash')}
      </Button>
    </div>
  );
}

export function SearchRow({ query, count, mode, busy, failed, onClear }: { query: string; count: number; mode: 'text' | 'meaning'; busy: boolean; failed: boolean; onClear(): void }) {
  const L = useL();
  const note = mode === 'meaning'
    ? failed ? L('按含义搜索暂时不可用，先按文字匹配。', 'Search by meaning is unavailable; matching words instead.')
      : busy ? L('正在按含义找…', 'Searching by meaning…') : L('按含义排序，最接近的在前。', 'Ranked by meaning, closest first.')
    : L('也会搜网页正文和图片里的文字。', 'Also searches page text and text in images.');
  return (
    <div className={styles.triage}>
      <span className={styles.triageLead}>{L(`「${query}」：${count} 条`, `“${query}”: ${count}`)}</span>
      <span className={styles.hints}>{note}</span>
      <Button variant="ghost" size="sm" onClick={onClear}>{L('清空搜索', 'Clear search')}</Button>
    </div>
  );
}

export function LoadingState({ columns = 4 }: { columns?: number }) {
  const heights = [[220, 140, 260], [160, 240, 180], [260, 150, 210], [180, 230, 160], [200, 170, 240]];
  return (
    <div className={styles.scroll} aria-busy aria-label="loading">
      <div className={styles.skeletons}>
        {Array.from({ length: columns }, (_, c) => (
          <div key={c} className={styles.skeletonColumn}>
            {(heights[c % heights.length] ?? []).map((h, i) => <Skeleton key={i} index={c + i * columns} className={styles.skeletonCard} style={{ height: h }} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string | null; onRetry(): void }) {
  const L = useL();
  return (
    <div className={styles.center}>
      <EmptyState
        className={styles.empty}
        variant="dashed"
        illustration={<span className={styles.emptyMark}><Icon icon={ArchiveX} size={20} /></span>}
        title={L('灵感库没有加载出来', 'The library did not load')}
        description={message ?? L('连不上 Fantay 本地服务。', 'Fantay is not reachable.')}
        action={<Button variant="primary" onClick={onRetry}>{L('重试', 'Retry')}</Button>}
      />
    </div>
  );
}

export function EmptyView({ nav, filtered, onClearFilters }: { nav: LibNav; filtered: boolean; onClearFilters(): void }) {
  const L = useL();
  const actions = useActions();
  if (filtered) {
    return (
      <div className={styles.center}>
        <EmptyState
          className={styles.empty}
          variant="dashed"
          illustration={<span className={styles.emptyMark}><Icon icon={SearchX} size={20} /></span>}
          title={L('没有找到匹配的灵感', 'No matching ideas')}
          description={L('换个关键词，或者清除筛选再看看。', 'Try other words, or clear the filters.')}
          action={<Button variant="secondary" onClick={onClearFilters}>{L('清除搜索和筛选', 'Clear search and filters')}</Button>}
        />
      </div>
    );
  }
  const capture = <Button variant="primary" onClick={() => actions.capture()}><Icon icon={Zap} />{L('记一条', 'Capture one')}</Button>;
  const copy: Record<LibNav['kind'], { icon: typeof Inbox; title: string; description: string; action?: ReactElement }> = {
    library: {
      icon: Library,
      title: L('灵感库还是空的', 'Your library is empty'),
      description: L('写一句话、贴一个链接，或者把图片、视频、PDF 拖进来。也可以在任何地方粘贴。', 'Write a sentence, paste a link, or drop images, videos and PDFs. Pasting anywhere works too.'),
      action: capture,
    },
    inbox: {
      icon: Inbox,
      title: L('收件箱清空了', 'Inbox zero'),
      description: L('新记下的灵感会先放在这里。加星标、放进空间或者保留，它就离开收件箱。', 'New captures land here. Star them, file them in a space or keep them, and they leave the Inbox.'),
      action: capture,
    },
    starred: {
      icon: Star,
      title: L('还没有星标', 'Nothing starred yet'),
      description: L('选中灵感按 S，或者把卡片拖到左边的「星标」上。', 'Select an idea and press S, or drag cards onto Starred.'),
    },
    tag: {
      icon: Tag,
      title: L('这个标签下没有灵感了', 'No ideas with this tag'),
      description: L('标签可能被移除了，回到「全部」看看。', 'The tag may have been removed. Go back to the library.'),
      action: <Button variant="secondary" onClick={() => actions.navigate({ kind: 'library' })}>{L('回到全部', 'Back to the library')}</Button>,
    },
    space: {
      icon: Library,
      title: L('这个空间还是空的', 'This space is empty'),
      description: L('把卡片拖到左边的空间上，或者选中后按空间的数字键，就能放进来。', 'Drag cards onto the space in the sidebar, or select them and press its number key.'),
      action: capture,
    },
    trash: {
      icon: Trash2,
      title: L('回收站是空的', 'Trash is empty'),
      description: L('删除的灵感会先放在这里，可以随时恢复。', 'Deleted ideas wait here and can be restored any time.'),
    },
  };
  const entry = copy[nav.kind];
  return (
    <div className={styles.center}>
      <EmptyState
        className={styles.empty}
        variant="dashed"
        illustration={<span className={styles.emptyMark}><Icon icon={entry.icon} size={20} /></span>}
        title={entry.title}
        description={entry.description}
        {...(entry.action ? { action: entry.action } : {})}
      />
    </div>
  );
}
