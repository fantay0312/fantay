// SPDX-License-Identifier: AGPL-3.0-only
// The 文件 tab of the side workspace: the project's files as a library. A 40px bar in the grammar of
// the file viewers (where you are at the left; search, sort, view and one "add" menu at the right),
// a quiet row of type filters, then the content: folders as compact tiles with their true size,
// files as cards that each show what they are, or as rows in a list.
// It takes the props of the inherited `DesignFilesPanel` unchanged, so the workspace mounts either
// one, and keeps the behaviour the workspace depends on: the open folder is reported on every change
// (uploads land there), the empty states follow the same conditions, and the callbacks are the
// workspace's own. Deleting is confirmed by the workspace (it knows about active shares), so this
// surface asks nothing itself.
// The search field with a clear control and the bar's density follow the 代码 surface's file rail
// (see ../code/FileRail.tsx).
'use client';

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Blocks,
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  FilePlus2,
  Layers,
  LayoutGrid,
  List as ListGlyph,
  Pencil,
  Plus,
  Search,
  SearchX,
  SquareArrowOutUpRight,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { workspaceProjectHeaders } from '../../../collab/workspace-identity';
import type { DesignFilesPanel } from '../../../components/DesignFilesPanel';
import { LIBRARY_UI_VISIBLE } from '../../../features/libraryUi';
import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { copyToClipboard } from '../../../lib/copy-to-clipboard';
import { projectFileUrl } from '../../../providers/registry';
import { FILE_SYSTEM_READ_ERROR_MESSAGE, isFileSystemReadError } from '../../../utils/fileSystemErrors';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FxRoot,
  IconButton,
  InputGroupClear,
  SearchField,
  SegmentedIconItem,
  SegmentedIcons,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from '../../ui';
import styles from './FilesSurface.module.css';
import { LibraryContent, type LibraryEntry, type RenameState } from './LibraryContent';
import {
  buildLibraryScope,
  describeLibraryFile,
  indexLibraryFolders,
  libraryCrumbs,
  nearestExistingDir,
  parentDir,
  selectLibraryView,
  SORT_START,
  writingFiles,
  type LibraryFilter,
  type LibrarySortKey,
} from './library-model';
import { readLibraryPrefs, writeLibraryPrefs, type LibraryPrefs, type LibraryViewMode } from './library-store';
import { dragHasFiles, filesFromClipboard, filesFromDataTransfer, isEditableTarget } from './transfer-files';

/** The inherited panel's props, exactly: the workspace mounts either panel with the same ones. */
export type FilesSurfaceProps = ComponentProps<typeof DesignFilesPanel>;

/** Below this width the search folds to an icon. */
const NARROW_WIDTH = 520;

const FILTER_LABEL: Record<LibraryFilter, keyof Dict> = {
  all: 'common.all',
  page: 'workspace.files.filter.page',
  document: 'workspace.files.filter.document',
  image: 'workspace.files.filter.image',
  sheet: 'workspace.files.filter.sheet',
  slides: 'workspace.files.filter.slides',
  code: 'workspace.files.filter.code',
  media: 'workspace.files.filter.media',
  other: 'workspace.files.filter.other',
};

const SORT_OPTIONS: ReadonlyArray<{ key: LibrarySortKey; label: keyof Dict }> = [
  { key: 'modified', label: 'designFiles.colModified' },
  { key: 'name', label: 'designFiles.colName' },
  { key: 'size', label: 'workspace.files.size' },
  { key: 'type', label: 'designFiles.colKind' },
];

/** A clock that ticks slowly: relative times stay true and "being written" expires. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function saveAs(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function FilesSurface({
  projectId,
  viewerOnly = false,
  downloadPending = false,
  filesAuthoritative = true,
  emptyLookBeforeFirstListing = false,
  rootDirName,
  reloading = false,
  running = false,
  runStartedAt,
  files,
  folders,
  liveArtifacts,
  onOpenFile,
  onOpenLiveArtifact,
  onRenameFile,
  onDeleteFile,
  onDeleteFiles,
  onUpload,
  onUploadFiles,
  onPaste,
  onCreateDesignSystemFromProject,
  createDesignSystemFromProjectBusy = false,
  onDuplicateProject,
  duplicateProjectBusy = false,
  onSelectFromLibrary,
  onCurrentDirChange,
  uploadError = null,
  onClearUploadError,
  navState,
  onNavStateChange,
}: FilesSurfaceProps): JSX.Element {
  const t = useT();
  const { workspaceContext } = useProjectCollabContext();
  const readOnlyReason = viewerOnly ? t('fileViewer.readonlySharedNoExport') : undefined;

  // ── where we are ──────────────────────────────────────────────────────────────────────────────
  const [currentDir, setCurrentDir] = useState(() => navState?.currentDir ?? '');
  // The workspace creates new files (uploads, pastes, sketches, drops) in the folder being viewed.
  useEffect(() => {
    onCurrentDirChange?.(currentDir);
  }, [currentDir, onCurrentDirChange]);
  // The workspace keeps this while the tab is away; the shape is the inherited panel's.
  const kindFilter = navState?.kindFilter;
  useEffect(() => {
    onNavStateChange?.({ kindFilter: kindFilter ?? new Set(), currentDir, page: 0, pageSize: 30 });
  }, [currentDir, kindFilter, onNavStateChange]);

  // ── what the library remembers ────────────────────────────────────────────────────────────────
  const [prefs, setPrefs] = useState<LibraryPrefs>(() => readLibraryPrefs(projectId));
  const prefsRef = useRef(prefs);
  const updatePrefs = useCallback(
    (patch: Partial<LibraryPrefs>) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      writeLibraryPrefs(projectId, next);
      setPrefs(next);
    },
    [projectId],
  );

  // ── the listing ───────────────────────────────────────────────────────────────────────────────
  const described = useMemo(() => files.map(describeLibraryFile), [files]);
  const folderIndex = useMemo(() => indexLibraryFolders(files, folders), [files, folders]);
  // A folder that is gone (its last file deleted, the project reloaded) gives way to the nearest
  // one that still exists. Only a real listing can say a folder is gone.
  useEffect(() => {
    if (!filesAuthoritative || reloading) return;
    const existing = nearestExistingDir(currentDir, folderIndex);
    if (existing !== currentDir) setCurrentDir(existing);
  }, [currentDir, folderIndex, filesAuthoritative, reloading]);

  const scope = useMemo(() => buildLibraryScope(described, folderIndex, currentDir), [described, folderIndex, currentDir]);
  // A filter whose last file is gone falls back to "all" without a stale frame.
  const filter: LibraryFilter = prefs.filter !== 'all' && scope.counts[prefs.filter] > 0 ? prefs.filter : 'all';
  const query = prefs.query;
  const needle = query.trim().toLowerCase();
  const listing = useMemo(
    () => selectLibraryView(scope, { filter, query, sort: prefs.sort }),
    [scope, filter, query, prefs.sort],
  );
  const entries = useMemo<LibraryEntry[]>(() => {
    const list: LibraryEntry[] = [];
    // Live artifacts belong to the project, not to a folder or a file type.
    if (currentDir === '' && filter === 'all') {
      for (const artifact of liveArtifacts) {
        if (needle && !artifact.title.toLowerCase().includes(needle)) continue;
        list.push({ type: 'live', id: `live:${artifact.tabId}`, artifact });
      }
    }
    for (const folder of listing.folders) list.push({ type: 'folder', id: `dir:${folder.path}`, folder });
    for (const item of listing.files) list.push({ type: 'file', id: `file:${item.path}`, item });
    return list;
  }, [currentDir, filter, liveArtifacts, needle, listing]);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry] as const)), [entries]);

  const now = useNow(running ? 10_000 : 60_000);
  const writing = useMemo(() => writingFiles(files, { running, startedAt: runStartedAt, now }), [files, running, runStartedAt, now]);

  // ── selection and rename ──────────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  // Each folder has its own selection.
  useEffect(() => {
    setSelected(new Set());
    setRenaming(null);
  }, [currentDir]);
  // A file that is gone is no longer selected.
  useEffect(() => {
    setSelected((previous) => {
      if (previous.size === 0) return previous;
      const names = new Set(files.map((file) => file.name));
      const next = new Set([...previous].filter((name) => names.has(name)));
      return next.size === previous.size ? previous : next;
    });
  }, [files]);

  const goTo = useCallback(
    (dir: string) => {
      setCurrentDir(dir);
      // A search that led to a folder has done its job.
      if (prefsRef.current.query !== '') updatePrefs({ query: '' });
    },
    [updatePrefs],
  );
  const goUp = useCallback(() => setCurrentDir((dir) => parentDir(dir)), []);

  const openEntry = useCallback(
    (entry: LibraryEntry) => {
      if (entry.type === 'file') onOpenFile(entry.item.path);
      else if (entry.type === 'folder') goTo(entry.folder.path);
      else onOpenLiveArtifact(entry.artifact.tabId);
    },
    [onOpenFile, onOpenLiveArtifact, goTo],
  );

  const startRename = useCallback(
    (path: string) => {
      if (viewerOnly) return;
      setRenaming({ path, draft: path.slice(path.lastIndexOf('/') + 1), saving: false });
    },
    [viewerOnly],
  );
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const changeRename = useCallback((draft: string) => {
    setRenaming((current) => (current ? { ...current, draft } : current));
  }, []);
  const cancelRename = useCallback(() => setRenaming(null), []);
  const commitRename = useCallback(async () => {
    const current = renamingRef.current;
    if (!current || current.saving) return;
    const base = current.draft.trim();
    // The file stays in its own folder, wherever the library is showing it from.
    const dir = parentDir(current.path);
    const nextName = dir === '' ? base : `${dir}/${base}`;
    if (!base || nextName === current.path) {
      setRenaming(null);
      return;
    }
    setRenaming({ ...current, saving: true });
    try {
      const renamed = await onRenameFile(current.path, nextName);
      if (!renamed) throw new Error('rename failed');
      setSelected((previous) => {
        if (!previous.has(current.path)) return previous;
        const next = new Set(previous);
        next.delete(current.path);
        next.add(renamed.name);
        return next;
      });
      setRenaming(null);
    } catch {
      toast({ title: t('workspace.files.renameFailed'), tone: 'danger' });
      setRenaming({ ...current, saving: false });
    }
  }, [onRenameFile, t]);

  const deletePaths = useCallback(
    (paths: string[]) => {
      if (viewerOnly || paths.length === 0) return;
      if (paths.length === 1) onDeleteFile(paths[0] as string);
      else void onDeleteFiles(paths);
    },
    [viewerOnly, onDeleteFile, onDeleteFiles],
  );

  const downloadPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      if (paths.length === 1) {
        const path = paths[0] as string;
        saveAs(projectFileUrl(projectId, path, workspaceContext), path.slice(path.lastIndexOf('/') + 1));
        return;
      }
      // Several files leave as one archive, built by the daemon.
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/archive/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}) },
          body: JSON.stringify({ files: paths }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const named = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '');
        let name = 'project.zip';
        if (named?.[1]) {
          try {
            name = decodeURIComponent(named[1]);
          } catch {
            name = named[1];
          }
        }
        const url = URL.createObjectURL(blob);
        saveAs(url, name);
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch {
        toast({ title: t('workspace.files.downloadFailed'), tone: 'danger' });
      }
    },
    [projectId, workspaceContext, t],
  );

  const copyPath = useCallback(
    async (path: string, localPath?: string) => {
      if (await copyToClipboard(localPath ?? path)) toast({ title: t('designFiles.copiedPath') });
    },
    [t],
  );

  // ── the scroller: its width and its position ──────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const narrow = width > 0 && width < NARROW_WIDTH;

  // One listing, one scroll position: the first listing shown gets the remembered offset back, a
  // different one (another folder, filter, search or view) starts at the top.
  const scrollKey = `${currentDir}\u0000${filter}\u0000${needle}\u0000${prefs.view}`;
  const shownKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    // Heights are unknown until the scroller has a width.
    if (!element || width === 0 || shownKey.current === scrollKey) return;
    const first = shownKey.current === null;
    shownKey.current = scrollKey;
    element.scrollTop = first && prefsRef.current.scrollKey === scrollKey ? prefsRef.current.scrollTop : 0;
  }, [scrollKey, width]);
  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element || shownKey.current === null) return;
    // Written straight to the store: remembering the offset must not re-render the library.
    prefsRef.current = { ...prefsRef.current, scrollTop: element.scrollTop, scrollKey: shownKey.current };
    writeLibraryPrefs(projectId, prefsRef.current);
  };

  // ── search ────────────────────────────────────────────────────────────────────────────────────
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchFolded = narrow && !searchOpen && query === '';
  const focusSearch = useCallback(() => {
    setSearchOpen(true);
    // The field may not be mounted yet (it was folded to an icon).
    window.requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, []);
  const focusContent = useCallback(() => {
    scrollRef.current?.querySelector<HTMLElement>('[data-active]')?.focus();
  }, []);

  // ── adding things ─────────────────────────────────────────────────────────────────────────────
  const nothing = files.length === 0 && liveArtifacts.length === 0 && (folders?.length ?? 0) === 0;
  // Before the first real listing nothing may act on a guess; a read-only viewer never adds.
  const unconfirmed = nothing && !filesAuthoritative;
  const canAdd = !viewerOnly && !unconfirmed;
  const [dropError, setDropError] = useState<string | null>(null);
  const visibleError = uploadError ?? dropError;
  const dismissError = (): void => {
    setDropError(null);
    onClearUploadError?.();
  };

  // Files pasted anywhere outside a text field are uploaded into the open folder.
  useEffect(() => {
    if (!canAdd) return;
    const onPasteEvent = (event: ClipboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      const pasted = filesFromClipboard(event.clipboardData);
      if (pasted.length === 0) return;
      event.preventDefault();
      setDropError(null);
      onClearUploadError?.();
      onUploadFiles(pasted);
    };
    window.addEventListener('paste', onPasteEvent);
    return () => window.removeEventListener('paste', onPasteEvent);
  }, [canAdd, onClearUploadError, onUploadFiles]);

  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!canAdd || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!canAdd || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!dragging) return;
    dragDepth.current = event.currentTarget.contains(event.relatedTarget as Node | null) ? Math.max(0, dragDepth.current - 1) : 0;
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!canAdd) return;
    setDropError(null);
    try {
      const dropped = await filesFromDataTransfer(event.dataTransfer);
      if (dropped.length > 0) onUploadFiles(dropped);
    } catch (error) {
      if (!isFileSystemReadError(error)) throw error;
      setDropError(FILE_SYSTEM_READ_ERROR_MESSAGE);
    }
  };

  // ── the item menu ─────────────────────────────────────────────────────────────────────────────
  // One menu for the whole library. A right click names its target on the way in; the "more"
  // button of an item opens the same menu from where the button is.
  const [menuTarget, setMenuTarget] = useState<LibraryEntry | null>(null);
  const onContextMenu = (event: MouseEvent<HTMLElement>): void => {
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-id]');
    setMenuTarget(element ? (entryById.get(element.dataset.entryId ?? '') ?? null) : null);
  };
  const openMenuAt = useCallback((button: HTMLElement) => {
    const item = button.closest<HTMLElement>('[data-entry-id]');
    if (!item) return;
    const rect = button.getBoundingClientRect();
    item.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom + 4 }),
    );
  }, []);
  // A menu opened on one of several selected files acts on all of them.
  const menuPaths =
    menuTarget?.type === 'file'
      ? selected.size > 1 && selected.has(menuTarget.item.path)
        ? [...selected]
        : [menuTarget.item.path]
      : [];

  // ── keys that belong to the whole surface ─────────────────────────────────────────────────────
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const typing = isEditableTarget(event.target);
    const command = event.metaKey || event.ctrlKey;
    if ((command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') || (event.key === '/' && !command && !event.altKey && !typing)) {
      event.preventDefault();
      event.stopPropagation();
      focusSearch();
      return;
    }
    if (event.key === 'Escape' && !typing) {
      // Escape undoes the nearest thing first: the search, then the selection. Otherwise it is not ours.
      if (query !== '') updatePrefs({ query: '' });
      else if (selected.size > 0) setSelected(new Set());
      else return;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const setSort = useCallback(
    (key: LibrarySortKey) => {
      const current = prefsRef.current.sort;
      // Choosing the current key again turns it round.
      const direction = current.key === key ? (current.direction === 'asc' ? 'desc' : 'asc') : SORT_START[key];
      updatePrefs({ sort: { key, direction } });
    },
    [updatePrefs],
  );

  // ── pieces ────────────────────────────────────────────────────────────────────────────────────
  const rootLabel = rootDirName ?? t('designFiles.crumbs');
  const crumbs = libraryCrumbs(currentDir);
  // A deep path keeps its two last folders; the ones before fold into "…", which steps out of them.
  const foldedCrumb = crumbs.length > 2 ? crumbs[crumbs.length - 3] : undefined;
  const shownCrumbs = crumbs.length > 2 ? crumbs.slice(-2) : crumbs;
  const breadcrumb = (
    <nav className={styles.crumbs} aria-label={t('designFiles.crumbs')} data-testid="files-breadcrumb">
      {currentDir === '' ? (
        <span className={styles.crumbCurrent} aria-current="page">
          {rootLabel}
        </span>
      ) : (
        <Button variant="bare" size="sm" className={styles.crumb} onClick={() => goTo('')}>
          {rootLabel}
        </Button>
      )}
      {foldedCrumb ? (
        <>
          <ChevronRight className={styles.crumbSeparator} size={12} strokeWidth={1.75} aria-hidden="true" />
          <Button variant="bare" size="sm" className={styles.crumb} aria-label={foldedCrumb.path} onClick={() => goTo(foldedCrumb.path)}>
            …
          </Button>
        </>
      ) : null}
      {shownCrumbs.map((crumb, index) => (
        <Fragment key={crumb.path}>
          <ChevronRight className={styles.crumbSeparator} size={12} strokeWidth={1.75} aria-hidden="true" />
          {index === shownCrumbs.length - 1 ? (
            <span className={styles.crumbCurrent} aria-current="page" title={crumb.path}>
              {crumb.label}
            </span>
          ) : (
            <Button variant="bare" size="sm" className={styles.crumb} onClick={() => goTo(crumb.path)}>
              {crumb.label}
            </Button>
          )}
        </Fragment>
      ))}
    </nav>
  );

  const SortArrow = prefs.sort.direction === 'asc' ? ArrowUp : ArrowDown;
  const addItems = (
    <>
      <DropdownMenuItem
        icon={<Upload aria-hidden="true" strokeWidth={1.75} />}
        data-testid="files-add-upload"
        onSelect={() => onUpload()}
      >
        {t('designFiles.upload')}
      </DropdownMenuItem>
      {/* `onPaste` is the workspace's historical name for "new blank Markdown document". */}
      <DropdownMenuItem
        icon={<FilePlus2 aria-hidden="true" strokeWidth={1.75} />}
        data-testid="files-add-document"
        onSelect={() => onPaste()}
      >
        {t('designFiles.newDocument')}
      </DropdownMenuItem>
      {LIBRARY_UI_VISIBLE && onSelectFromLibrary ? (
        <DropdownMenuItem
          icon={<Layers aria-hidden="true" strokeWidth={1.75} />}
          data-testid="design-files-library-trigger"
          onSelect={() => onSelectFromLibrary()}
        >
          {t('designFiles.library.label')}
        </DropdownMenuItem>
      ) : null}
      {onCreateDesignSystemFromProject || onDuplicateProject ? <DropdownMenuSeparator /> : null}
      {onCreateDesignSystemFromProject ? (
        <DropdownMenuItem
          icon={<Blocks aria-hidden="true" strokeWidth={1.75} />}
          disabled={createDesignSystemFromProjectBusy}
          onSelect={() => onCreateDesignSystemFromProject()}
        >
          {t('designFiles.createDesignSystemFromProject')}
        </DropdownMenuItem>
      ) : null}
      {onDuplicateProject ? (
        <DropdownMenuItem
          icon={<CopyPlus aria-hidden="true" strokeWidth={1.75} />}
          disabled={duplicateProjectBusy}
          onSelect={() => onDuplicateProject()}
        >
          {t('designFiles.duplicateProject')}
        </DropdownMenuItem>
      ) : null}
    </>
  );

  const bar = (
    <div className={styles.bar} data-files-bar="" data-search-open={(narrow && !searchFolded) || undefined}>
      {narrow && !searchFolded ? null : breadcrumb}
      <div className={styles.actions}>
        {searchFolded ? (
          <IconButton size="sm" aria-label={t('common.search')} shortcut="/" tooltipSide="bottom" onClick={focusSearch}>
            <Search aria-hidden="true" strokeWidth={1.75} />
          </IconButton>
        ) : (
          <SearchField
            ref={searchRef}
            className={styles.search}
            value={query}
            placeholder={t('designFiles.searchPlaceholder')}
            aria-label={t('designFiles.searchPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            data-testid="files-search"
            trailing={
              query !== '' ? (
                <InputGroupClear
                  onClear={() => {
                    updatePrefs({ query: '' });
                    searchRef.current?.focus();
                  }}
                />
              ) : null
            }
            onChange={(event) => updatePrefs({ query: event.target.value })}
            onBlur={() => {
              if (prefsRef.current.query === '') setSearchOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // The first Escape clears the field; an empty field lets go of the focus.
                event.preventDefault();
                event.stopPropagation();
                if (query !== '') updatePrefs({ query: '' });
                else focusContent();
              } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
                event.preventDefault();
                focusContent();
              }
            }}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" aria-label={t('workspace.files.sort')} tooltipSide="bottom" data-testid="files-sort">
              <ArrowUpDown aria-hidden="true" strokeWidth={1.75} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="sm">
            {SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.key}
                data-testid={`files-sort-${option.key}`}
                aria-current={prefs.sort.key === option.key ? 'true' : undefined}
                onSelect={() => setSort(option.key)}
              >
                {t(option.label)}
                {prefs.sort.key === option.key ? (
                  <SortArrow
                    className={styles.sortArrow}
                    aria-label={t(prefs.sort.direction === 'asc' ? 'workspace.files.sortAscending' : 'workspace.files.sortDescending')}
                    strokeWidth={1.75}
                  />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <SegmentedIcons
          size="sm"
          className={styles.viewSwitch}
          value={prefs.view}
          aria-label={t('workspace.files.view')}
          onValueChange={(next) => updatePrefs({ view: next as LibraryViewMode })}
        >
          <SegmentedIconItem value="grid" aria-label={t('workspace.files.viewGrid')} title={t('workspace.files.viewGrid')} data-testid="files-view-grid">
            <LayoutGrid aria-hidden="true" strokeWidth={1.75} />
          </SegmentedIconItem>
          <SegmentedIconItem value="list" aria-label={t('workspace.files.viewList')} title={t('workspace.files.viewList')} data-testid="files-view-list">
            <ListGlyph aria-hidden="true" strokeWidth={1.75} />
          </SegmentedIconItem>
        </SegmentedIcons>
        <span className={styles.gap} aria-hidden="true" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={!canAdd} disabledReason={readOnlyReason} data-testid="files-add">
              <Plus aria-hidden="true" strokeWidth={1.75} />
              {t('workspace.files.add')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="md">{addItems}</DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const selectionPaths = [...selected];
  const filterRow =
    selected.size > 0 ? (
      <div className={styles.filters} data-testid="design-files-batch-bar">
        <span className={styles.selectionCount}>{t('workspace.files.selected', { n: selected.size })}</span>
        <Button size="sm" variant="bare" onClick={() => void downloadPaths(selectionPaths)}>
          <Download aria-hidden="true" strokeWidth={1.75} />
          {t('designFiles.download')}
        </Button>
        <Button
          size="sm"
          variant="bare"
          disabled={viewerOnly}
          disabledReason={readOnlyReason}
          data-testid="design-files-batch-delete"
          onClick={() => deletePaths(selectionPaths)}
        >
          <Trash2 aria-hidden="true" strokeWidth={1.75} />
          {t('common.delete')}
        </Button>
        <span className={styles.filtersEnd} />
        <Button size="sm" variant="bare" onClick={() => setSelected(new Set())}>
          {t('designFiles.clearSelection')}
        </Button>
      </div>
    ) : !nothing && scope.filters.length > 2 ? (
      <div className={styles.filters}>
        <Tabs value={filter} onValueChange={(next) => updatePrefs({ filter: next as LibraryFilter })}>
          <TabsList className={styles.filterList} aria-label={t('designFiles.filterBy')} data-testid="files-filters">
            {scope.filters.map((id) => (
              <TabsTrigger key={id} value={id} className={styles.filter} data-testid={`files-filter-${id}`}>
                {t(FILTER_LABEL[id])}
                <span className={styles.count}>{scope.counts[id]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    ) : null;

  // The add actions as buttons, for a project or a folder with nothing in it.
  const starters = (testIds: boolean) => (
    <div className={styles.stateActions}>
      <Button
        size="sm"
        variant="primary"
        disabled={viewerOnly}
        disabledReason={readOnlyReason}
        data-testid={testIds ? 'design-files-upload-trigger' : undefined}
        onClick={() => onUpload()}
      >
        <Upload aria-hidden="true" strokeWidth={1.75} />
        {t('designFiles.upload')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={viewerOnly}
        disabledReason={readOnlyReason}
        data-testid={testIds ? 'design-files-empty-new-document' : undefined}
        onClick={() => onPaste()}
      >
        <FilePlus2 aria-hidden="true" strokeWidth={1.75} />
        {t('designFiles.newDocument')}
      </Button>
    </div>
  );

  const skeleton = (testId: string) => (
    <div className={styles.skeleton} data-testid={testId} aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className={styles.skeletonCard}>
          <Skeleton className={styles.skeletonPreview} index={index} />
          <Skeleton shape="line" className={styles.skeletonName} index={index} />
          <Skeleton shape="line" className={styles.skeletonMeta} index={index} />
        </div>
      ))}
    </div>
  );

  let body: JSX.Element;
  if (unconfirmed) {
    // The list has not arrived: zero files is not yet "an empty project". A project just created
    // from Home keeps the empty look it was handed over with, inert until the listing confirms it.
    body = emptyLookBeforeFirstListing ? (
      <div
        className={styles.state}
        data-testid="design-files-empty-unconfirmed"
        aria-busy="true"
        ref={(element) => element?.setAttribute('inert', '')}
      >
        <p className={styles.stateTitle}>{t('workspace.files.empty')}</p>
        {starters(false)}
      </div>
    ) : (
      skeleton('design-files-loading')
    );
  } else if (nothing) {
    // A shared project still downloading reads exactly like an empty one; offering to create new
    // content there would mislead, so it says what is happening instead.
    body = downloadPending ? (
      <div className={styles.state} data-testid="design-files-syncing">
        <p className={styles.stateTitle}>{t('designFiles.syncing')}</p>
      </div>
    ) : (
      <div className={styles.state} data-testid="design-files-empty">
        <p className={styles.stateTitle}>{t('workspace.files.empty')}</p>
        {starters(true)}
      </div>
    );
  } else if (reloading) {
    body = skeleton('design-files-reloading');
  } else if (entries.length === 0) {
    body =
      needle !== '' ? (
        <div className={styles.state} data-testid="files-no-results">
          <span className={styles.stateGlyph}>
            <SearchX size={20} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <p className={styles.stateTitle}>{t('workspace.files.noResults', { query: query.trim() })}</p>
          <div className={styles.stateActions}>
            <Button size="sm" variant="ghost" onClick={() => updatePrefs({ query: '' })}>
              {t('workspace.files.clearSearch')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.state} data-testid="files-empty-folder">
          <p className={styles.stateTitle}>{t('workspace.files.emptyFolder')}</p>
          {starters(false)}
        </div>
      );
  } else {
    body = (
      <LibraryContent
        projectId={projectId}
        view={prefs.view}
        entries={entries}
        currentDir={currentDir}
        sort={prefs.sort}
        width={width}
        selected={selected}
        writing={writing}
        renaming={renaming}
        now={now}
        viewerOnly={viewerOnly}
        label={t('workspace.files.library')}
        t={t}
        scrollRef={scrollRef}
        onSort={setSort}
        onOpen={openEntry}
        onSelect={setSelected}
        onRenameStart={startRename}
        onRenameChange={changeRename}
        onRenameCommit={() => void commitRename()}
        onRenameCancel={cancelRename}
        onDelete={deletePaths}
        onGoUp={goUp}
        onMore={openMenuAt}
      />
    );
  }

  const menuFile = menuTarget?.type === 'file' ? menuTarget.item : null;
  const many = menuPaths.length > 1;
  return (
    <FxRoot
      className={styles.root}
      data-files-surface=""
      data-testid="files-surface"
      data-view={prefs.view}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      {bar}
      {visibleError ? (
        <div className={styles.notice} role="alert" data-testid="upload-error-banner">
          <span className={styles.noticeText}>{visibleError}</span>
          <IconButton size="xs" aria-label={t('common.close')} data-testid="upload-error-dismiss" onClick={dismissError}>
            <X aria-hidden="true" strokeWidth={1.75} />
          </IconButton>
        </div>
      ) : null}
      {filterRow}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={scrollRef} className={styles.scroll} data-files-scroll="" onScroll={onScroll} onContextMenu={onContextMenu}>
            {body}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="design-file-menu-popover">
          {menuFile ? (
            <>
              {many ? null : (
                <ContextMenuItem
                  icon={<SquareArrowOutUpRight aria-hidden="true" strokeWidth={1.75} />}
                  onSelect={() => onOpenFile(menuFile.path)}
                >
                  {t('designFiles.openInTab')}
                </ContextMenuItem>
              )}
              {many ? null : (
                <ContextMenuItem
                  icon={<Pencil aria-hidden="true" strokeWidth={1.75} />}
                  shortcut="F2"
                  disabled={viewerOnly}
                  onSelect={() => startRename(menuFile.path)}
                >
                  {t('common.rename')}
                </ContextMenuItem>
              )}
              <ContextMenuItem icon={<Download aria-hidden="true" strokeWidth={1.75} />} onSelect={() => void downloadPaths(menuPaths)}>
                {many ? t('workspace.files.downloadSelected', { n: menuPaths.length }) : t('designFiles.download')}
              </ContextMenuItem>
              {many ? null : (
                <ContextMenuItem
                  icon={<Copy aria-hidden="true" strokeWidth={1.75} />}
                  onSelect={() => void copyPath(menuFile.path, menuFile.file.localPath)}
                >
                  {t('workspace.files.copyPath')}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                tone="danger"
                icon={<Trash2 aria-hidden="true" strokeWidth={1.75} />}
                disabled={viewerOnly}
                data-testid={`design-file-delete-${menuFile.path}`}
                onSelect={() => deletePaths(menuPaths)}
              >
                {many ? t('designFiles.deleteSelected', { n: menuPaths.length }) : t('common.delete')}
              </ContextMenuItem>
              {viewerOnly ? <ContextMenuLabel className={styles.menuReason}>{readOnlyReason}</ContextMenuLabel> : null}
            </>
          ) : menuTarget ? (
            <>
              <ContextMenuItem icon={<SquareArrowOutUpRight aria-hidden="true" strokeWidth={1.75} />} onSelect={() => openEntry(menuTarget)}>
                {t('designFiles.previewOpen')}
              </ContextMenuItem>
              {menuTarget.type === 'folder' ? (
                <ContextMenuItem icon={<Copy aria-hidden="true" strokeWidth={1.75} />} onSelect={() => void copyPath(menuTarget.folder.path)}>
                  {t('workspace.files.copyPath')}
                </ContextMenuItem>
              ) : null}
            </>
          ) : (
            <>
              <ContextMenuItem icon={<Upload aria-hidden="true" strokeWidth={1.75} />} disabled={!canAdd} onSelect={() => onUpload()}>
                {t('designFiles.upload')}
              </ContextMenuItem>
              <ContextMenuItem icon={<FilePlus2 aria-hidden="true" strokeWidth={1.75} />} disabled={!canAdd} onSelect={() => onPaste()}>
                {t('designFiles.newDocument')}
              </ContextMenuItem>
              {viewerOnly ? <ContextMenuLabel className={styles.menuReason}>{readOnlyReason}</ContextMenuLabel> : null}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <div className={styles.drop} data-visible={dragging || undefined} aria-hidden="true">
        <span className={styles.dropGlyph}>
          <Upload size={20} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <p className={styles.dropTitle}>{t('workspace.files.dropTitle')}</p>
        <p className={styles.dropHint}>
          {t('workspace.files.dropHint', { folder: currentDir === '' ? rootLabel : currentDir.slice(currentDir.lastIndexOf('/') + 1) })}
        </p>
      </div>
    </FxRoot>
  );
}
