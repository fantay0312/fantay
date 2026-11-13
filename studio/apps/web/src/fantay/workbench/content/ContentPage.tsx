/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 内容 — every piece of content grouped 灵感 / 大纲 / 草稿 / 待发布 / 已发布, as a
 * board (drag between columns) or a sortable list, with search and inline platform/status filters.
 * Derived from dsh-media-desk client/content.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WorkbenchItem, WorkbenchStatus } from '@open-design/contracts';
import { WORKBENCH_STATUSES } from '@open-design/contracts';
import {
  Button,
  EmptyState,
  InputGroupClear,
  SearchField,
  Segmented,
  SegmentedItem,
  Skeleton,
  cn,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, platformChoices, platformName, statusLabel } from '../shared/format';
import { workbench } from '../store';
import type { WorkbenchPageProps } from '../types';
import { isContentItem, metricsByItem, useNow, useWorkbenchPageData } from '../pages-shared/data';
import type { ItemActions } from '../pages-shared/ItemMenu';
import page from '../pages-shared/page.module.css';
import { ScheduleDialog } from '../pages-shared/ScheduleDialog';
import { ContentBoard } from './ContentBoard';
import { ContentList } from './ContentList';
import { productionState } from './parts';
import styles from './ContentPage.module.css';

type View = 'board' | 'list';
const VIEW_KEY = 'fantay.workbench.content.view';
const NO_PLATFORM = '__none__';

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function matches(item: WorkbenchItem, query: string, lang: 'zh' | 'en'): boolean {
  if (!query) return true;
  const shown = displayItem(item);
  return [shown.title, item.title, item.body, item.source, item.platform, platformName(item.platform, lang), item.summary, ...(item.tags ?? [])]
    .some((value) => String(value ?? '').toLowerCase().includes(query));
}

export function ContentPage({ active, openItem, produce, navigate }: WorkbenchPageProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const { state, items, loading, error } = useWorkbenchPageData();
  const now = useNow(active);
  const [view, setView] = useState<View>('board');
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [status, setStatus] = useState<'all' | WorkbenchStatus>('all');
  const [scheduling, setScheduling] = useState<WorkbenchItem | null>(null);

  useEffect(() => setView(readView()), []);
  const changeView = (next: string) => {
    const value: View = next === 'list' ? 'list' : 'board';
    setView(value);
    try {
      window.localStorage.setItem(VIEW_KEY, value);
    } catch {
      /* per-viewer convenience only */
    }
  };

  const content = useMemo(() => items.filter(isContentItem), [items]);
  const totals = useMemo(() => metricsByItem(state?.metrics ?? []), [state?.metrics]);
  const q = query.trim().toLowerCase();
  const searched = useMemo(() => content.filter((item) => matches(item, q, lang)), [content, q, lang]);

  const platformOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of searched) counts.set(item.platform ?? NO_PLATFORM, (counts.get(item.platform ?? NO_PLATFORM) ?? 0) + 1);
    const present = platformChoices(lang).filter((p) => counts.has(p) || p === platform);
    return [
      { value: 'all', label: L('全部平台', 'All platforms'), count: searched.length },
      ...present.map((p) => ({ value: p, label: platformName(p, lang), count: counts.get(p) ?? 0 })),
      ...(counts.has(NO_PLATFORM) || platform === NO_PLATFORM ? [{ value: NO_PLATFORM, label: L('未设平台', 'No platform'), count: counts.get(NO_PLATFORM) ?? 0 }] : []),
    ];
  }, [searched, lang, platform, L]);

  const byPlatform = useMemo(
    () => searched.filter((item) => platform === 'all' || (platform === NO_PLATFORM ? !item.platform : item.platform === platform)),
    [searched, platform],
  );
  const statusCounts = useMemo(() => {
    const counts: Record<WorkbenchStatus, number> = { idea: 0, outline: 0, draft: 0, ready: 0, published: 0 };
    for (const item of byPlatform) counts[item.status] += 1;
    return counts;
  }, [byPlatform]);
  const listed = useMemo(() => (status === 'all' ? byPlatform : byPlatform.filter((item) => item.status === status)), [byPlatform, status]);

  const actions: ItemActions = useMemo(() => ({ openItem, produce, schedule: setScheduling }), [openItem, produce]);
  const scheduledItem = scheduling ? (items.find((item) => item.id === scheduling.id) ?? scheduling) : null;

  const counts = useMemo(() => {
    let ideas = 0;
    let produced = 0;
    let published = 0;
    let scheduled = 0;
    for (const item of content) {
      if (item.status === 'idea') ideas += 1;
      if (productionState(item) === 'done' || item.drafts?.article || item.drafts?.script) produced += 1;
      if (item.status === 'published') published += 1;
      if (item.scheduledAt && item.status !== 'published') scheduled += 1;
    }
    return { ideas, produced, published, scheduled };
  }, [content]);

  const filtered = q || platform !== 'all' || (view === 'list' && status !== 'all');
  const clearFilters = () => {
    setQuery('');
    setPlatform('all');
    setStatus('all');
  };

  let body: ReactNode;
  if (loading) {
    body = (
      <div className={styles.board} aria-busy>
        {WORKBENCH_STATUSES.map((s, index) => (
          <div key={s} className={styles.column}>
            <Skeleton shape="line" index={index} style={{ width: 64, margin: '6px 4px 14px' }} />
            <div className={styles.columnList}>
              <Skeleton shape="row" index={index} style={{ height: 120 }} />
              <Skeleton shape="row" index={index + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (error !== null) {
    body = (
      <div className={page.centerState}>
        <EmptyState
          variant="dashed"
          title={L('没能读取工作台', 'Could not load the workbench')}
          description={error || undefined}
          action={<Button variant="primary" onClick={() => void workbench.refresh()}>{L('重试', 'Retry')}</Button>}
        />
      </div>
    );
  } else if (!content.length) {
    body = (
      <div className={page.centerState}>
        <EmptyState
          title={L('还没有内容', 'No content yet')}
          description={L('灵感、大纲、草稿和已发布的内容都会在这里。先到灵感页记下第一条。', 'Ideas, outlines, drafts and published posts all land here. Capture your first idea on the Ideas page.')}
          action={<Button variant="primary" onClick={() => navigate('inspiration')}>{L('去记灵感', 'Capture an idea')}</Button>}
        />
      </div>
    );
  } else if (!listed.length) {
    body = (
      <div className={styles.noMatchWrap}>
        <p className={page.noMatch}>{L('没有匹配的内容，换个关键词或筛选试试。', 'Nothing matches. Try another search or filter.')}</p>
        {filtered ? <Button variant="ghost" size="sm" onClick={clearFilters}>{L('清除筛选', 'Clear filters')}</Button> : null}
      </div>
    );
  } else if (view === 'board') {
    body = <ContentBoard items={listed} totals={totals} actions={actions} now={now} onCaptureFallback={() => navigate('inspiration')} />;
  } else {
    body = <ContentList items={listed} totals={totals} actions={actions} now={now} />;
  }

  const summary = [
    L(`共 ${content.length} 条`, `${content.length} item${content.length === 1 ? '' : 's'}`),
    L(`${counts.ideas} 个灵感待推进`, `${counts.ideas} idea${counts.ideas === 1 ? '' : 's'} to develop`),
    L(`${counts.produced} 篇已成稿`, `${counts.produced} drafted`),
    L(`${counts.scheduled} 条已排期`, `${counts.scheduled} scheduled`),
    L(`${counts.published} 篇已发布`, `${counts.published} published`),
  ].join(' · ');

  return (
    <div className={page.page}>
      <div className={page.inner}>
        <header className={page.head}>
          <div className={page.headText}>
            <h1 className={page.title}>{L('内容', 'Content')}</h1>
            <p className={page.summary}>{loading ? ' ' : summary}</p>
          </div>
          <div className={page.headActions}>
            <SearchField
              className={styles.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={L('搜索标题、标签、平台', 'Search titles, tags, platforms')}
              aria-label={L('搜索内容', 'Search content')}
              trailing={query ? <InputGroupClear onClear={() => setQuery('')} /> : null}
            />
            <Segmented value={view} onValueChange={changeView} aria-label={L('显示方式', 'View')}>
              <SegmentedItem value="board">{L('看板', 'Board')}</SegmentedItem>
              <SegmentedItem value="list">{L('列表', 'List')}</SegmentedItem>
            </Segmented>
          </div>
        </header>

        {!loading && error === null && content.length ? (
          <div className={styles.filters}>
            <Segmented
              value={platform}
              onValueChange={setPlatform}
              aria-label={L('按平台筛选', 'Filter by platform')}
              className={cn('flex w-full', styles.filterRow)}
            >
              {platformOptions.map((option) => (
                <SegmentedItem key={option.value} value={option.value} className="min-w-0 flex-1">
                  <span className={styles.segLabel}>{option.label}</span>
                  <span className={styles.segCount}>{option.count}</span>
                </SegmentedItem>
              ))}
            </Segmented>
            {view === 'list' ? (
              <Segmented
                value={status}
                onValueChange={(value) => setStatus(value as 'all' | WorkbenchStatus)}
                aria-label={L('按状态筛选', 'Filter by status')}
                className={cn('flex w-full', styles.filterRow)}
              >
                <SegmentedItem value="all" className="min-w-0 flex-1">
                  <span className={styles.segLabel}>{L('全部状态', 'All statuses')}</span>
                  <span className={styles.segCount}>{byPlatform.length}</span>
                </SegmentedItem>
                {WORKBENCH_STATUSES.map((s) => (
                  <SegmentedItem key={s} value={s} className="min-w-0 flex-1">
                    <span className={page.statusDot} data-status={s} />
                    <span className={styles.segLabel}>{statusLabel(s, lang)}</span>
                    <span className={styles.segCount}>{statusCounts[s]}</span>
                  </SegmentedItem>
                ))}
              </Segmented>
            ) : null}
          </div>
        ) : null}

        <div key={view} className={styles.body}>
          {body}
        </div>
      </div>
      <ScheduleDialog item={scheduledItem} open={scheduling !== null} onClose={() => setScheduling(null)} />
    </div>
  );
}
