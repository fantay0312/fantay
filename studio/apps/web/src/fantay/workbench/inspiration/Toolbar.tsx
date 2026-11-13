'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — toolbar: back / forward through the library, title and count, filter
 * popover (every chip visible), search (text, or 按含义 by meaning), AI, ⚡ capture and ⓘ.
 */
import type { RefObject } from 'react';
import type { WorkbenchKind, WorkbenchSpace, WorkbenchStatus } from '@open-design/contracts';
import { WORKBENCH_KINDS, WORKBENCH_STATUSES } from '@open-design/contracts';
import {
  ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Inbox, Info, Library, Link2, ListFilter, MessageCircle, Mic, PanelLeftOpen, Quote, Search, Sparkles, Star, StickyNote, Tag, Trash2, Video, X, Zap,
} from 'lucide-react';
import {
  Button, Chip, DropdownMenu, DropdownMenuCaption, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Icon, IconButton, Input, Popover, PopoverContent, PopoverTrigger, Spinner, Tooltip,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { kindLabel, statusLabel } from '../shared/format';
import { activeFilterCount, EMPTY_FILTERS, type DateRange, type LibNav, type LibraryFilters, type ProductionFilter } from './library';
import { SpaceGlyph } from './SpaceGlyph';
import styles from './Toolbar.module.css';

export const KIND_ICON: Record<WorkbenchKind, typeof StickyNote> = {
  note: StickyNote, quote: Quote, web: Link2, image: ImageIcon, video: Video, pdf: FileText, audio: Mic,
};

const KIND_FILTER_LABEL: Partial<Record<WorkbenchKind, [string, string]>> = { web: ['链接', 'Links'] };

function FilterPopover({ filters, onChange, resultCount }: { filters: LibraryFilters; onChange(next: LibraryFilters): void; resultCount: number }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const active = activeFilterCount(filters);
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  const productions: Array<[ProductionFilter, string, string]> = [['any', '全部', 'Any'], ['running', '成稿中', 'Running'], ['with', '已成稿', 'Produced'], ['without', '还没成稿', 'Not yet']];
  const ranges: Array<[DateRange, string, string]> = [['all', '全部时间', 'Any time'], ['today', '今天', 'Today'], ['week', '近 7 天', 'Last 7 days'], ['month', '近 30 天', 'Last 30 days'], ['year', '今年', 'This year'], ['custom', '自定义', 'Custom']];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton className={styles.toolButton} data-active={active ? '' : undefined} aria-label={active ? L(`筛选（${active} 项）`, `Filter (${active})`) : L('筛选', 'Filter')}>
          <Icon icon={ListFilter} />
          {active ? <span className={styles.badge}>{active}</span> : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent width={380} align="end" className={styles.filterPop}>
        <section className={styles.filterGroup}>
          <h4>{L('类型', 'Type')}</h4>
          <div className={styles.chips}>
            {WORKBENCH_KINDS.map(kind => (
              <Chip key={kind} size="sm" on={filters.kinds.includes(kind)} className={styles.chip} icon={<Icon icon={KIND_ICON[kind]} size={12} />} onClick={() => onChange({ ...filters, kinds: toggle(filters.kinds, kind) })}>
                {KIND_FILTER_LABEL[kind] ? L(...KIND_FILTER_LABEL[kind]!) : kindLabel(kind, lang)}
              </Chip>
            ))}
          </div>
        </section>
        <section className={styles.filterGroup}>
          <h4>{L('状态', 'Status')}</h4>
          <div className={styles.chips}>
            {WORKBENCH_STATUSES.map((status: WorkbenchStatus) => (
              <Chip key={status} size="sm" on={filters.statuses.includes(status)} className={styles.chip} onClick={() => onChange({ ...filters, statuses: toggle(filters.statuses, status) })}>
                <span className={styles.statusDot} data-status={status} />
                {statusLabel(status, lang)}
              </Chip>
            ))}
          </div>
        </section>
        <section className={styles.filterGroup}>
          <h4>{L('成稿', 'Production')}</h4>
          <div className={styles.chips}>
            {productions.map(([value, zh, en]) => (
              <Chip key={value} size="sm" on={filters.production === value} className={styles.chip} onClick={() => onChange({ ...filters, production: value })}>{L(zh, en)}</Chip>
            ))}
          </div>
        </section>
        <section className={styles.filterGroup}>
          <h4>{L('记录时间', 'Captured')}</h4>
          <div className={styles.chips}>
            {ranges.map(([value, zh, en]) => (
              <Chip key={value} size="sm" on={filters.range === value} className={styles.chip} onClick={() => onChange({ ...filters, range: value })}>{L(zh, en)}</Chip>
            ))}
          </div>
          {filters.range === 'custom' ? (
            <div className={styles.dates}>
              <Input type="date" inputSize="sm" value={filters.from} max={filters.to || undefined} onChange={event => onChange({ ...filters, from: event.target.value })} aria-label={L('开始日期', 'From')} />
              <span>—</span>
              <Input type="date" inputSize="sm" value={filters.to} min={filters.from || undefined} onChange={event => onChange({ ...filters, to: event.target.value })} aria-label={L('结束日期', 'To')} />
            </div>
          ) : null}
        </section>
        <footer className={styles.filterFoot}>
          <span>{L(`${resultCount} 条结果`, `${resultCount} result${resultCount === 1 ? '' : 's'}`)}</span>
          <Button variant="ghost" size="sm" disabled={!active} onClick={() => onChange(EMPTY_FILTERS)}>{L('清除筛选', 'Clear filters')}</Button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}

export interface SearchState {
  query: string;
  mode: 'text' | 'meaning';
  open: boolean;
  busy: boolean;
  /** The daemon search failed (meaning mode falls back to words). */
  failed: boolean;
}

function SearchBox({ search, onChange, inputRef }: { search: SearchState; onChange(next: Partial<SearchState>): void; inputRef: RefObject<HTMLInputElement> }) {
  const L = useL();
  const expanded = search.open || Boolean(search.query);
  return (
    <div className={styles.search} data-open={expanded ? '' : undefined}>
      {expanded ? (
        <label className={styles.searchField}>
          {search.busy ? <Spinner size="xs" /> : <Icon icon={Search} size={14} className={styles.searchIcon} />}
          <Input
            ref={inputRef}
            variant="bare"
            inputSize="auto"
            className={styles.searchInput}
            value={search.query}
            autoFocus
            placeholder={search.mode === 'meaning' ? L('描述你想找的意思…', 'Describe what you mean…') : L('搜索标题、正文、标签、图中文字…', 'Search titles, text, tags, text in images…')}
            aria-label={L('搜索灵感', 'Search ideas')}
            onChange={event => onChange({ query: event.target.value })}
            onBlur={() => { if (!search.query) onChange({ open: false }); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (search.query) onChange({ query: '' });
                else { onChange({ open: false }); event.currentTarget.blur(); }
              }
            }}
          />
          <Tooltip label={search.mode === 'meaning' ? L('按含义搜索：找意思相近的灵感', 'By meaning: finds ideas with a similar sense') : L('切换到按含义搜索', 'Switch to search by meaning')}>
            <Button
              variant="bare"
              size="sm"
              className={styles.meaning}
              aria-pressed={search.mode === 'meaning'}
              onMouseDown={event => event.preventDefault()}
              onClick={() => onChange({ mode: search.mode === 'meaning' ? 'text' : 'meaning' })}
            >
              <Icon icon={Sparkles} size={12} />
              {L('按含义', 'Meaning')}
            </Button>
          </Tooltip>
          {search.query ? (
            <IconButton size="xs" shape="round" aria-label={L('清空搜索', 'Clear search')} tooltip={false} onMouseDown={event => event.preventDefault()} onClick={() => onChange({ query: '' })}>
              <Icon icon={X} size={12} />
            </IconButton>
          ) : null}
        </label>
      ) : (
        <IconButton aria-label={L('搜索', 'Search')} shortcut="shift+mod+f" onClick={() => onChange({ open: true })}>
          <Icon icon={Search} />
        </IconButton>
      )}
    </div>
  );
}

export interface ToolbarProps {
  railOpen: boolean;
  onExpandRail(): void;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  nav: LibNav;
  space: WorkbenchSpace | null;
  count: number;
  total: number;
  filters: LibraryFilters;
  onFilters(next: LibraryFilters): void;
  search: SearchState;
  onSearch(next: Partial<SearchState>): void;
  searchRef: RefObject<HTMLInputElement>;
  selectionCount: number;
  inboxCount: number;
  organizing: boolean;
  onOrganizeSelected(): void;
  onOrganizeInbox(): void;
  onAsk(prompt?: string): void;
  onAskSelected(): void;
  onCapture(): void;
  inspectorOpen: boolean;
  onToggleInspector(): void;
}

export function navTitle(nav: LibNav, space: WorkbenchSpace | null, L: (zh: string, en: string) => string): string {
  switch (nav.kind) {
    case 'library': return L('全部', 'Library');
    case 'inbox': return L('收件箱', 'Inbox');
    case 'starred': return L('星标', 'Starred');
    case 'trash': return L('回收站', 'Trash');
    case 'tag': return `#${nav.tag}`;
    case 'space': return space?.name ?? L('空间', 'Space');
  }
}

export function Toolbar(props: ToolbarProps) {
  const L = useL();
  const { nav, space } = props;
  const icon = nav.kind === 'space' && space ? <SpaceGlyph color={space.color} size={18} />
    : <Icon icon={nav.kind === 'inbox' ? Inbox : nav.kind === 'starred' ? Star : nav.kind === 'trash' ? Trash2 : nav.kind === 'tag' ? Tag : Library} size={16} />;
  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        {!props.railOpen ? (
          <IconButton aria-label={L('展开侧栏', 'Show sidebar')} onClick={props.onExpandRail}><Icon icon={PanelLeftOpen} /></IconButton>
        ) : null}
        <div className={styles.history}>
          <IconButton aria-label={L('后退', 'Back')} shortcut="mod+[" disabled={!props.canBack} onClick={props.onBack}><Icon icon={ChevronLeft} /></IconButton>
          <IconButton aria-label={L('前进', 'Forward')} shortcut="mod+]" disabled={!props.canForward} onClick={props.onForward}><Icon icon={ChevronRight} /></IconButton>
        </div>
        <h1 className={styles.title}>
          <span className={styles.titleIcon}>{icon}</span>
          <span className={styles.titleText}>{navTitle(nav, space, L)}</span>
          <span className={styles.count}>{props.count === props.total ? props.count : `${props.count} / ${props.total}`}</span>
        </h1>
      </div>
      <div className={styles.right}>
        <SearchBox search={props.search} onChange={props.onSearch} inputRef={props.searchRef} />
        <FilterPopover filters={props.filters} onChange={props.onFilters} resultCount={props.count} />
        <span className={styles.divider} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton className={styles.toolButton} aria-label={L('AI 整理与提问', 'AI: organise and ask')}>
              {props.organizing ? <Spinner size="xs" /> : <Icon icon={Sparkles} />}
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="lg">
            <DropdownMenuCaption>{L('AI 整理：起标题、打标签、写摘要、认图中文字、放进合适的空间', 'Organise: title, tags, summary, text in images, a fitting space')}</DropdownMenuCaption>
            <DropdownMenuItem icon={<Icon icon={Sparkles} size="sm" />} disabled={!props.selectionCount || props.organizing} onSelect={props.onOrganizeSelected}>
              {props.selectionCount ? L(`整理选中的 ${props.selectionCount} 条`, `Organise ${props.selectionCount} selected`) : L('整理选中的灵感', 'Organise selected')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Icon icon={Inbox} size="sm" />} disabled={!props.inboxCount || props.organizing} onSelect={props.onOrganizeInbox}>
              {L(`整理收件箱（${props.inboxCount} 条）`, `Organise the Inbox (${props.inboxCount})`)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Icon icon={MessageCircle} size="sm" />} onSelect={() => props.onAsk(L('在我的灵感库里找找：', 'Look in my library for '))}>
              {L('问问我的灵感库', 'Ask my library')}
            </DropdownMenuItem>
            {props.selectionCount ? (
              <DropdownMenuItem icon={<Icon icon={MessageCircle} size="sm" />} onSelect={props.onAskSelected}>
                {L(`就选中的 ${props.selectionCount} 条提问`, `Ask about ${props.selectionCount} selected`)}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem icon={<Icon icon={MessageCircle} size="sm" />} onSelect={() => props.onAsk(L('从我的灵感库里挑 3 条这周最值得成稿的，说说理由。', 'Pick the 3 ideas in my library most worth producing this week, and say why.'))}>
              {L('这周该写哪条？', 'What should I write this week?')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton aria-label={L('快速记录', 'Quick capture')} onClick={props.onCapture}><Icon icon={Zap} /></IconButton>
        <IconButton aria-label={props.inspectorOpen ? L('收起详情', 'Hide inspector') : L('显示详情', 'Show inspector')} shortcut="mod+i" on={props.inspectorOpen} onClick={props.onToggleInspector}>
          <Icon icon={Info} />
        </IconButton>
      </div>
    </header>
  );
}
