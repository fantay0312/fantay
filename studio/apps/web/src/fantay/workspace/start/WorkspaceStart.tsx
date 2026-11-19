// fx-governance-allow-raw: the rows are cmdk listbox options and the clear control sits inside the search field; no button primitive models either
// SPDX-License-Identifier: AGPL-3.0-only
// Start page of the side workspace (the new-tab surface): a search field, the tools, the create
// actions and what was recently worked on, read as one list. cmdk owns the combobox / listbox
// semantics, the single arrow-key selection, Enter and scroll-into-view; this file only decides which
// rows exist (shouldFilter={false}, so matching stays deterministic) and draws them.
//
// Row anatomy (icon, label, description, a trailing chevron that slides in) and the container-query
// degradation for narrow panels are adapted from
//   cindy apps/desktop/src/renderer/features/right-sidebar/EmptyState.tsx @ 88941ba7 (Apache-2.0)
// The card-less column of plain highlight rows under one quiet heading follows RightPanelEmptyState in
//   t3code apps/web/src/components/RightPanelTabs.tsx @ c5e6b24f (MIT)
// Both are restyled with Fantay tokens in WorkspaceStart.module.css.
import { clsx } from 'clsx';
import { Command, useCommandState } from 'cmdk';
import { ArrowUpRight, ChevronRight, Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { WorkspaceContextItem } from '@open-design/contracts';

import { Icon, type IconName } from '../../../components/Icon';
import {
  kindIconName,
  workspaceContextIconName,
  workspaceContextSearchText,
  type TabLauncherTrackInput,
} from '../../../components/workspace/TabLauncherMenu';
import { useT } from '../../../i18n';
import type { ProjectFile } from '../../../types';
import { relativeTimeLong } from '../../../utils/chatTime';
import styles from './WorkspaceStart.module.css';

export interface WorkspaceStartTool {
  id: string;
  iconName: IconName;
  label: string;
  hint: string;
  run(): void;
}

export interface WorkspaceStartAction {
  id: string;
  iconName: IconName;
  label: string;
  run(): void;
}

export interface WorkspaceStartSuggestion {
  id: string;
  iconName: IconName;
  label: string;
  meta?: string;
  run(): void;
}

export interface WorkspaceStartProps {
  /** 画板 / 文件 / 代码 / 浏览器 / 设计系统, already translated. */
  tools: readonly WorkspaceStartTool[];
  /** 新建草图 / 新建文档 / 上传, already translated; empty for read-only viewers. */
  actions: readonly WorkspaceStartAction[];
  /** 0-2 items the surface router picked for the task at hand. */
  suggestions: readonly WorkspaceStartSuggestion[];
  /** Flat list; names are project-relative paths. */
  files: readonly ProjectFile[];
  /** Open workspace tabs that can be searched and focused. */
  openTabs: readonly WorkspaceContextItem[];
  /** Ids of the tabs currently open. */
  openTabNames: readonly string[];
  onOpenFile(name: string): void;
  onOpenTab(tabId: string): void;
  /** Opens the 文件 surface. */
  onShowAllFiles(): void;
  onTrack?(input: TabLauncherTrackInput): void;
}

type Translate = ReturnType<typeof useT>;

const RECENT_LIMIT = 8;
const TAB_RESULT_LIMIT = 20;
const FILE_RESULT_LIMIT = 50;
const ICON_STROKE = 1.75;
/** The 200ms rise plus its 30ms stagger over four sections, with slack. */
const ENTER_WINDOW_MS = 400;
/** Keys cmdk turns into selection moves. */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function WorkspaceStart({
  tools,
  actions,
  suggestions,
  files,
  openTabs,
  openTabNames,
  onOpenFile,
  onOpenTab,
  onShowAllFiles,
  onTrack,
}: WorkspaceStartProps): JSX.Element {
  const t = useT();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  // cmdk's selected item value, held here so a row focused with Tab can become the selection.
  const [selected, setSelected] = useState('');

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  // Fire once when the page opens (it is mounted only while the start tab is showing).
  useEffect(() => {
    onTrack?.({ element: 'open' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount: focus the field, and play the entrance once. The entrance marker is set and dropped on
  // the node itself, not through state, so sections that remount later (search and back) do not
  // replay it and nothing re-renders when the window closes.
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    const root = rootRef.current;
    if (!root) return;
    root.setAttribute('data-entering', 'true');
    const timer = window.setTimeout(() => root.removeAttribute('data-entering'), ENTER_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const openable = useMemo(() => files.filter((file) => file.type !== 'dir'), [files]);
  const openSet = useMemo(() => new Set(openTabNames), [openTabNames]);

  const recent = useMemo(
    () => [...openable].sort((a, b) => b.mtime - a.mtime || compareNames(a, b)).slice(0, RECENT_LIMIT),
    [openable],
  );

  const toolResults = useMemo(
    () => (needle ? tools.filter((tool) => includes(tool.label, needle) || includes(tool.hint, needle)) : []),
    [tools, needle],
  );
  const actionResults = useMemo(
    () => (needle ? actions.filter((action) => includes(action.label, needle)) : []),
    [actions, needle],
  );
  const fileResults = useMemo(
    () => (needle ? rankFiles(openable, needle).slice(0, FILE_RESULT_LIMIT) : []),
    [openable, needle],
  );
  const tabResults = useMemo(() => {
    if (!needle) return [];
    // An open file is listed once, under Files with its open mark; its tab row would repeat it.
    const listedFiles = new Set(fileResults.map((file) => file.name));
    return openTabs
      .filter(
        (item) =>
          item.tabId && !listedFiles.has(item.tabId) && includes(workspaceContextSearchText(item), needle),
      )
      .slice(0, TAB_RESULT_LIMIT);
  }, [openTabs, fileResults, needle]);

  // The selection always names a row that exists. cmdk re-selects after the selected row unmounts
  // only when that row is the last one to unmount in the commit (its scheduler keeps one callback
  // per kind), so a change that drops several rows at once could leave nothing selected.
  useLayoutEffect(() => {
    const items = rootRef.current?.querySelectorAll('[cmdk-item]');
    if (!items) return;
    let first: string | null = null;
    for (const item of items) {
      const value = item.getAttribute('data-value');
      if (value === selected) return;
      first ??= value;
    }
    setSelected(first ?? '');
  });

  function openFile(file: ProjectFile) {
    onTrack?.({ element: 'open_file', file_kind: file.kind });
    onOpenFile(file.name);
  }

  function openTab(item: WorkspaceContextItem) {
    if (!item.tabId) return;
    onTrack?.({ element: 'open_tab', tab_kind: item.kind });
    onOpenTab(item.tabId);
  }

  function runAction(action: WorkspaceStartAction) {
    onTrack?.({ element: 'create', action_id: action.id });
    action.run();
  }

  function clearQuery() {
    setQuery('');
    inputRef.current?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      // With nothing to clear, Escape belongs to the host.
      if (!query) return;
      event.preventDefault();
      event.stopPropagation();
      clearQuery();
      return;
    }
    if (event.key === 'Enter') {
      // cmdk runs the selected row on Enter, and the pointer can have moved the selection off the row
      // that holds focus. A focused row runs itself, as any button does. Preventing the default makes
      // cmdk skip the event and drops the button's own Enter click, so the row runs once.
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[cmdk-item]') : null;
      if (row) {
        event.preventDefault();
        row.click();
      }
      return;
    }
    // cmdk moves the selection, not the focus. Hand focus back to the field so a row reached with
    // Tab and the selected row cannot drift apart.
    if (NAVIGATION_KEYS.has(event.key) && event.target !== inputRef.current) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }

  // A row reached with Tab becomes the selection, so Enter and the arrow keys act on what is focused.
  function onListFocus(event: FocusEvent<HTMLDivElement>) {
    const value = event.target.closest('[cmdk-item]')?.getAttribute('data-value');
    if (value) setSelected(value);
  }

  const hasToolBlock = tools.length > 0 || actions.length > 0;
  const toolBlockRise = suggestions.length > 0 ? 2 : 1;
  const recentRise = toolBlockRise + (hasToolBlock ? 1 : 0);

  return (
    <Command
      ref={rootRef}
      className={styles.root}
      role="region"
      aria-label={t('workspace.newTab')}
      data-testid="workspace-start-page"
      data-mode={searching ? 'search' : 'browse'}
      label={t('workspace.start.searchPlaceholder')}
      shouldFilter={false}
      loop
      value={selected}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
    >
      <div className={styles.column}>
        <div className={clsx(styles.search, styles.rise)} style={riseStyle(0)}>
          <Search className={styles.searchGlyph} size={16} strokeWidth={ICON_STROKE} aria-hidden />
          <Command.Input
            ref={inputRef}
            className={styles.input}
            value={query}
            onValueChange={setQuery}
            placeholder={t('workspace.start.searchPlaceholder')}
            data-testid="tab-launcher-search"
            // With text in the field, Home and End move the caret as in any text field; cmdk would
            // take them for the first and last row. With no text there is no caret to move.
            onKeyDown={(event) => {
              if (query && (event.key === 'Home' || event.key === 'End')) event.stopPropagation();
            }}
          />
          {/* Stays mounted so it can fade out; hidden from focus and assistive tech while empty. */}
          <button
            type="button"
            className={styles.clear}
            data-visible={query ? 'true' : 'false'}
            tabIndex={query ? 0 : -1}
            aria-hidden={query ? undefined : true}
            aria-label={t('common.clear')}
            onClick={clearQuery}
            // cmdk runs the selected row on Enter anywhere inside the root; this button keeps its own.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.stopPropagation();
            }}
          >
            <X size={14} strokeWidth={ICON_STROKE} aria-hidden />
          </button>
        </div>

        <Command.List className={styles.list} label={t('workspace.newTab')} onFocus={onListFocus}>
          {searching ? (
            <>
              {toolResults.length + actionResults.length > 0 ? (
                <Command.Group className={styles.group} heading={t('workspace.start.tools')}>
                  {toolResults.map((tool, index) => (
                    <Row
                      key={tool.id}
                      value={`tool:${tool.id}`}
                      className={styles.row}
                      data-testid={`workspace-tool-${tool.id}`}
                      aria-label={tool.label}
                      aria-describedby={tool.hint ? `${uid}-tool-${index}` : undefined}
                      onSelect={() => tool.run()}
                    >
                      <Glyph name={tool.iconName} size={15} />
                      <span className={styles.name}>{tool.label}</span>
                      {tool.hint ? (
                        <span id={`${uid}-tool-${index}`} className={styles.detail}>
                          {tool.hint}
                        </span>
                      ) : null}
                    </Row>
                  ))}
                  {actionResults.map((action) => (
                    <Row
                      key={action.id}
                      value={`action:${action.id}`}
                      className={styles.row}
                      data-testid={`workspace-action-${action.id}`}
                      onSelect={() => runAction(action)}
                    >
                      <Glyph name={action.iconName} size={15} />
                      <span className={styles.name}>{action.label}</span>
                    </Row>
                  ))}
                </Command.Group>
              ) : null}

              {tabResults.length > 0 ? (
                <Command.Group className={styles.group} heading={t('workspace.openTabs')}>
                  {tabResults.map((item) => (
                    <Row
                      key={`${item.kind}:${item.id}`}
                      value={`tab:${item.kind}:${item.id}`}
                      className={styles.row}
                      data-testid="tab-launcher-tab-result"
                      aria-label={item.label}
                      onSelect={() => openTab(item)}
                    >
                      <Glyph name={workspaceContextIconName(item.kind)} size={15} />
                      <span className={styles.name}>{item.label}</span>
                      <span className={styles.trail}>{t('workspace.tabOpen')}</span>
                    </Row>
                  ))}
                </Command.Group>
              ) : null}

              {fileResults.length > 0 ? (
                <Command.Group className={styles.group} heading={t('workspace.start.files')}>
                  {fileResults.map((file) => (
                    <FileRow key={file.name} file={file} open={openSet.has(file.name)} t={t} onOpen={openFile} />
                  ))}
                </Command.Group>
              ) : null}

              {/* cmdk shows this only while no row is mounted. */}
              <Command.Empty className={styles.empty} data-testid="tab-launcher-empty">
                {t('workspace.start.noResults', { query: query.trim() })}
              </Command.Empty>
            </>
          ) : (
            <>
              {suggestions.length > 0 ? (
                <Command.Group
                  className={clsx(styles.group, styles.suggested, styles.rise)}
                  style={riseStyle(1)}
                  heading={t('workspace.start.suggested')}
                >
                  {suggestions.map((suggestion, index) => (
                    <Row
                      key={suggestion.id}
                      value={`suggestion:${suggestion.id}`}
                      className={styles.suggestion}
                      data-testid={`workspace-suggestion-${suggestion.id}`}
                      aria-label={suggestion.label}
                      aria-describedby={suggestion.meta ? `${uid}-suggestion-${index}` : undefined}
                      onSelect={() => suggestion.run()}
                    >
                      <Glyph name={suggestion.iconName} size={15} />
                      <span className={styles.label}>{suggestion.label}</span>
                      {suggestion.meta ? (
                        <span id={`${uid}-suggestion-${index}`} className={styles.meta}>
                          {suggestion.meta}
                        </span>
                      ) : null}
                      <ArrowUpRight className={styles.reveal} size={14} strokeWidth={ICON_STROKE} aria-hidden />
                    </Row>
                  ))}
                </Command.Group>
              ) : null}

              {hasToolBlock ? (
                <div className={styles.rise} style={riseStyle(toolBlockRise)}>
                  {tools.length > 0 ? (
                    <Command.Group className={styles.group} heading={t('workspace.start.tools')}>
                      {tools.map((tool, index) => (
                        <Row
                          key={tool.id}
                          value={`tool:${tool.id}`}
                          className={styles.tool}
                          data-testid={`workspace-tool-${tool.id}`}
                          aria-label={tool.label}
                          aria-describedby={tool.hint ? `${uid}-tool-${index}` : undefined}
                          onSelect={() => tool.run()}
                        >
                          <Glyph name={tool.iconName} size={16} />
                          <span className={styles.label}>{tool.label}</span>
                          {tool.hint ? (
                            <span id={`${uid}-tool-${index}`} className={styles.hint}>
                              {tool.hint}
                            </span>
                          ) : null}
                          <ChevronRight className={styles.reveal} size={14} strokeWidth={ICON_STROKE} aria-hidden />
                        </Row>
                      ))}
                    </Command.Group>
                  ) : null}
                  {actions.length > 0 ? (
                    <Command.Group className={styles.pills} value="create">
                      {actions.map((action) => (
                        <Row
                          key={action.id}
                          value={`action:${action.id}`}
                          className={styles.pill}
                          data-testid={`workspace-action-${action.id}`}
                          onSelect={() => runAction(action)}
                        >
                          <Glyph name={action.iconName} size={14} />
                          <span className={styles.label}>{action.label}</span>
                        </Row>
                      ))}
                    </Command.Group>
                  ) : null}
                </div>
              ) : null}

              {recent.length > 0 ? (
                <Command.Group
                  className={clsx(styles.group, styles.recent, styles.rise)}
                  style={riseStyle(recentRise)}
                  heading={t('workspace.start.recent')}
                >
                  {/* Sits on the heading line (see .link); first in the group, so the arrow keys
                      reach it between the create actions and the files. */}
                  <Row
                    value="show-all-files"
                    className={styles.link}
                    data-testid="workspace-start-all-files"
                    onSelect={() => onShowAllFiles()}
                  >
                    {t('workspace.code.allFiles')}
                    <ChevronRight size={12} strokeWidth={ICON_STROKE} aria-hidden />
                  </Row>
                  {recent.map((file) => (
                    <FileRow key={file.name} file={file} open={openSet.has(file.name)} t={t} onOpen={openFile} />
                  ))}
                </Command.Group>
              ) : null}
            </>
          )}
        </Command.List>
      </div>
      <ActiveDescendant inputRef={inputRef} />
    </Command>
  );
}

/**
 * Keeps the field's aria-activedescendant on the selected row. cmdk refreshes that attribute only for
 * selection changes it makes itself, and with a controlled value it reads the row one commit early.
 * This page also selects through the controlled value (a row that takes focus, the re-selection after
 * rows unmount), which left the attribute unset on mount and pointing at a removed row afterwards.
 * Lives inside Command, after the list: it re-renders with the page and with cmdk's store, so this
 * effect runs once the rows carry their values and after any write cmdk makes in the same commit.
 */
function ActiveDescendant({ inputRef }: { inputRef: RefObject<HTMLInputElement> }) {
  const value = useCommandState((state) => state.value);
  // Subscription only: cmdk rewrites the attribute when this changes, and the effect must follow it.
  useCommandState((state) => state.selectedItemId);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // The row is found by its value (cmdk's own test for "selected"); cmdk keeps item ids to itself.
    let id = '';
    if (value) {
      for (const row of input.closest('[cmdk-root]')?.querySelectorAll('[cmdk-item]') ?? []) {
        if (row.getAttribute('data-value') === value) {
          id = row.id;
          break;
        }
      }
    }
    if (id) input.setAttribute('aria-activedescendant', id);
    else input.removeAttribute('aria-activedescendant');
  });
  return null;
}

interface RowProps {
  /** Unique within the page; cmdk tracks the selection by it. */
  value: string;
  className: string | undefined;
  onSelect(): void;
  children: ReactNode;
  title?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'data-testid'?: string;
}

/** One selectable thing: a cmdk item rendered as a real button, so Tab reaches it too. */
function Row({ value, className, onSelect, children, ...button }: RowProps) {
  return (
    <Command.Item asChild value={value} onSelect={onSelect}>
      <button type="button" className={clsx(styles.item, className)} {...button}>
        {children}
      </button>
    </Command.Item>
  );
}

function FileRow({
  file,
  open,
  t,
  onOpen,
}: {
  file: ProjectFile;
  open: boolean;
  t: Translate;
  onOpen(file: ProjectFile): void;
}) {
  const trailId = useId();
  const { base, dir } = splitPath(file.name);
  const trail = open ? t('workspace.tabOpen') : file.mtime > 0 ? relativeTimeLong(file.mtime, t) : '';
  return (
    <Row
      value={`file:${file.name}`}
      className={styles.row}
      data-testid="tab-launcher-result"
      title={file.name}
      aria-label={file.name}
      aria-describedby={trail ? trailId : undefined}
      onSelect={() => onOpen(file)}
    >
      <Glyph name={kindIconName(file.kind)} size={15} />
      <span className={styles.name}>{base}</span>
      {dir ? <span className={styles.detail}>{dir}</span> : null}
      {trail ? (
        <span id={trailId} className={styles.trail}>
          {trail}
        </span>
      ) : null}
    </Row>
  );
}

function Glyph({ name, size }: { name: IconName; size: number }) {
  return (
    <span className={styles.glyph} aria-hidden>
      <Icon name={name} size={size} strokeWidth={ICON_STROKE} />
    </span>
  );
}

function riseStyle(index: number): CSSProperties {
  return { '--rise-index': index } as CSSProperties;
}

function includes(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

function compareNames(a: ProjectFile, b: ProjectFile): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function splitPath(name: string): { base: string; dir: string } {
  const cut = name.lastIndexOf('/');
  const base = name.slice(cut + 1);
  // A trailing slash leaves no base name; show the whole path rather than an empty row.
  return cut < 0 || !base ? { base: name, dir: '' } : { base, dir: name.slice(0, cut) };
}

/**
 * Files whose path contains the needle, best first: the file name starts with it, the file name
 * contains it, only a folder does. Ties go to the newest file.
 */
function rankFiles(files: readonly ProjectFile[], needle: string): ProjectFile[] {
  const ranked: { file: ProjectFile; rank: number }[] = [];
  for (const file of files) {
    const path = file.name.toLowerCase();
    if (!path.includes(needle)) continue;
    const base = path.slice(path.lastIndexOf('/') + 1);
    ranked.push({ file, rank: base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : 2 });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || b.file.mtime - a.file.mtime || compareNames(a.file, b.file))
    .map((entry) => entry.file);
}
