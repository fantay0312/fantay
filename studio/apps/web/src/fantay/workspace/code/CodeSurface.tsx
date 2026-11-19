// fx-governance-allow-raw: the header's quiet toggles and the state actions are tone-only controls drawn to this surface's spec, which no button primitive models
// SPDX-License-Identifier: AGPL-3.0-only
// The 代码 surface: one workspace tab with the selected file's source, what this turn changed in it,
// and the project's file tree on the right.
// Adapted from cindy apps/desktop/src/renderer/features/right-sidebar/plugins/file-browser/FileBrowserBody.tsx
// @ 88941ba7 (Apache-2.0): the viewer | divider | tree split with a draggable, double-click-to-reset
// divider. The header row follows t3code's file view (breadcrumb left, a few quiet actions right).
import {
  Check,
  CircleAlert,
  Copy,
  Ellipsis,
  Eye,
  FileCode,
  FileX,
  FolderOpen,
  PanelRight,
  WrapText,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { isOpenDesignHostAvailable, openHostProjectPath } from '@open-design/host';

import { useT } from '../../../i18n';
import { copyToClipboard } from '../../../lib/copy-to-clipboard';
import type { ProjectFile } from '../../../types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../ui/dropdown-menu';
import { FX } from '../../ui/fx';
import { toast } from '../../ui/toast';
import { useCodeSurfaceRequest } from '../surfaces/code-surface-store';
import type { TurnFileChange } from '../surfaces/surface-types';
import { Breadcrumb } from './Breadcrumb';
import { CodeEditor } from './CodeEditor';
import styles from './CodeSurface.module.css';
import { ChangeCounts, FileRail } from './FileRail';
import { buildFileTree, collectDirPaths, findDirRowPath } from './file-tree';
import { HunkList } from './HunkList';
import { reconstructOriginalText } from './original-text';
import { joinProjectPath } from './project-path';
import {
  INITIAL_SURFACE_STATE,
  firstSelectableChange,
  latestTextFile,
  reconcileSurfaceState,
  revealDir,
  selectFile,
  setView,
  toggleDir,
  type SurfaceState,
} from './selection';
import { readStoredFlag, writeStoredFlag } from './storage';
import { LARGE_TEXT_BYTES, classifyProjectFile } from './text-preview';
import { useFileText } from './use-file-text';
import { usePaneWidth } from './use-pane-width';

export interface CodeSurfaceProps {
  projectId: string;
  /** Flat project file list; names are project-relative paths with forward slashes, e.g. "src/app/page.tsx". */
  files: readonly ProjectFile[];
  /** Absolute project directory when known. */
  resolvedDir: string | null;
  /** What the latest agent turn changed (empty when nothing). */
  turnChanges: readonly TurnFileChange[];
  /** True while the agent is running; file contents may change underneath. */
  streaming: boolean;
  /** Open a file in its own viewer tab (rendered preview for pages, documents and media). */
  onOpenPreview(name: string): void;
  /** Reports the file being read, so the chat composer can reference it. */
  onActiveFileChange?(file: ProjectFile | null): void;
}

const TREE_OPEN_KEY = 'fantay:code-surface:tree';
const WRAP_KEY = 'fantay:code-surface:wrap';
const TREE_WIDTH_KEY = 'fantay:code-surface:tree-width';
/** Below this surface width the tree leaves the flow and opens over the viewer. */
const NARROW_BELOW = 560;
const COPIED_MS = 1500;
const ICON = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;

type Translate = ReturnType<typeof useT>;

/** CodeMirror's own phrases (the find bar, the collapsed-lines bar) in the app's language. */
function editorPhrases(t: Translate): Record<string, string> {
  return {
    Find: t('common.search'),
    close: t('common.close'),
    next: t('workspace.code.findNext'),
    previous: t('workspace.code.findPrevious'),
    // CodeMirror puts the count where "$" stands.
    '$ unchanged lines': t('workspace.code.unchangedLines', { count: '$' }),
  };
}

/** A whole-viewer state: one ghost glyph, one line, at most one action. */
function StateNotice({ icon: Glyph, text, action }: { icon: LucideIcon; text: string; action?: ReactNode }): JSX.Element {
  return (
    <div className={styles.state} role="status">
      <Glyph className={styles.stateIcon} size={20} strokeWidth={1.5} aria-hidden="true" />
      <p className={styles.stateText}>{text}</p>
      {action}
    </div>
  );
}

/** A few grey lines standing in for the text of a file that is slow to arrive. */
function SkeletonLines(): JSX.Element {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {[62, 38, 74, 51, 0, 68, 44, 57].map((width, index) => (
        <span key={index} className={styles.skeletonLine} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function CodeSurface(props: CodeSurfaceProps): JSX.Element {
  // Another project is another surface: no selection, filter or scroll position carries over.
  return <CodeSurfaceBody key={props.projectId} {...props} />;
}

function CodeSurfaceBody({
  projectId,
  files,
  resolvedDir,
  turnChanges,
  streaming,
  onOpenPreview,
  onActiveFileChange,
}: CodeSurfaceProps): JSX.Element {
  const t = useT();
  const request = useCodeSurfaceRequest(projectId);

  // Everything derived from the file list is built once per list, not per render.
  const fileByName = useMemo(() => {
    const map = new Map<string, ProjectFile>();
    for (const file of files) if (file.type !== 'dir') map.set(file.name, file);
    return map;
  }, [files]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const dirPaths = useMemo(() => collectDirPaths(tree), [tree]);
  const latestText = useMemo(() => latestTextFile(files), [files]);
  const changeByPath = useMemo(() => {
    const map = new Map<string, TurnFileChange>();
    for (const change of turnChanges) map.set(change.path, change);
    return map;
  }, [turnChanges]);
  const firstChange = useMemo(() => firstSelectableChange(turnChanges, fileByName), [turnChanges, fileByName]);

  // Selection, view and open folders. Settled while rendering, so the first frame already shows the
  // requested (or fallback) file instead of an empty surface that is corrected a moment later.
  const [stored, setStored] = useState<SurfaceState>(INITIAL_SURFACE_STATE);
  const state = reconcileSurfaceState(stored, {
    fileCount: fileByName.size,
    fileByName,
    dirPaths,
    turnChanges,
    firstChange,
    latestText,
    request,
  });
  if (state !== stored) setStored(state);

  const file = state.selected !== null ? (fileByName.get(state.selected) ?? null) : null;
  const fileName = file?.name ?? null;
  const fileChange = fileName !== null ? (changeByPath.get(fileName) ?? null) : null;

  // The composer follows the file being read; the callback may be a new function on every render.
  const activeFileCallback = useRef(onActiveFileChange);
  activeFileCallback.current = onActiveFileChange;
  const fileRef = useRef(file);
  fileRef.current = file;
  useEffect(() => {
    activeFileCallback.current?.(fileRef.current);
  }, [fileName]);
  useEffect(() => () => activeFileCallback.current?.(null), []);

  // ── text ────────────────────────────────────────────────────────────────────────────────────────
  const verdict = file ? classifyProjectFile(file) : null;
  const fileText = useFileText(projectId, file && verdict !== 'binary' ? file : null);
  const loaded = fileText.loaded;
  // The text of the file in the header, as opposed to one still on screen from before.
  const currentText = loaded !== null && loaded.name === fileName ? loaded : null;
  // A file nothing vouched for is judged by its bytes once they are here.
  const notText = file !== null && (verdict === 'binary' || (verdict === 'unknown' && currentText?.binary === true));
  // What the viewer shows. While the next file is on its way (and not yet slow) the previous one
  // stays up, so a fast load swaps text for text with nothing in between.
  const shown =
    loaded !== null && file !== null && !notText && !fileText.failed && (currentText !== null || !fileText.slow)
      ? loaded
      : null;
  const shownChange = shown ? (changeByPath.get(shown.name) ?? null) : null;
  const wantsChanges = state.view === 'changes' && shownChange !== null && shownChange.status !== 'deleted';
  const diff = useMemo((): { mode: 'source' | 'merge' | 'hunks'; original: string | null } => {
    if (!wantsChanges || !shown || !shownChange) return { mode: 'source', original: null };
    const original = reconstructOriginalText(shown.text, shownChange);
    return original === null ? { mode: 'hunks', original: null } : { mode: 'merge', original };
  }, [wantsChanges, shown, shownChange]);

  // ── remembered switches ─────────────────────────────────────────────────────────────────────────
  const [wrap, setWrap] = useState(() => readStoredFlag(WRAP_KEY, false));
  const [treeOpenWide, setTreeOpenWide] = useState(() => readStoredFlag(TREE_OPEN_KEY, true));
  const [treeOpenNarrow, setTreeOpenNarrow] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // False until the surface has had a width to measure. The tree stays unshown until then (see
  // `[data-unmeasured]` in the stylesheet), so a narrow surface does not mount with the tree in the
  // flow and then play the overlay's exit transition over the code.
  const [measured, setMeasured] = useState(false);
  const treeOpen = narrow ? treeOpenNarrow : treeOpenWide;
  const pane = usePaneWidth({ storageKey: TREE_WIDTH_KEY, min: 180, max: 420, fallback: 248, edge: 'right' });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const treeToggleRef = useRef<HTMLButtonElement | null>(null);
  // Read by the stable pick handler below.
  const overlayOpen = useRef(false);
  overlayOpen.current = narrow && treeOpenNarrow;

  // Measured before the first paint, so a narrow surface never flashes the in-flow tree.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.clientWidth;
      // No width: the surface is not laid out (the workspace keeps it mounted while another tab is
      // showing). The layout it had stands, so coming back does not replay wide → narrow.
      if (width === 0) return;
      setNarrow(width < NARROW_BELOW);
      setMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const revealSelected = useCallback(() => {
    setStored((current) =>
      current.selected === null
        ? current
        : { ...current, reveal: { path: current.selected, tick: (current.reveal?.tick ?? 0) + 1 } },
    );
  }, []);

  const toggleTree = (): void => {
    if (narrow) setTreeOpenNarrow((open) => !open);
    else {
      writeStoredFlag(TREE_OPEN_KEY, !treeOpenWide);
      setTreeOpenWide(!treeOpenWide);
    }
    // Opening: the row of the file being read should be the one in view.
    if (!treeOpen) revealSelected();
  };

  // The overlay is a panel the person works in: opening it puts the caret in the filter.
  useEffect(() => {
    if (narrow && treeOpenNarrow) filterRef.current?.focus();
  }, [narrow, treeOpenNarrow]);

  const closeOverlay = useCallback((returnFocus: boolean) => {
    setTreeOpenNarrow(false);
    if (returnFocus) treeToggleRef.current?.focus();
  }, []);

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !narrow || !treeOpenNarrow) return;
    // Portalled menus bubble through React, not through the DOM: their Escape is not ours.
    if (!rootRef.current?.contains(event.target as Node)) return;
    event.preventDefault();
    closeOverlay(true);
  };

  // ── actions ─────────────────────────────────────────────────────────────────────────────────────
  const onSelectFile = useCallback(
    (path: string, from: 'tree' | 'changes') => {
      setStored((current) =>
        // From the changed list the tree opens the file's folders but does not scroll: the list
        // shares the tree's scroller and must stay under the pointer for the next pick.
        selectFile(current, path, from === 'tree' ? { reveal: false } : { reveal: false, expand: true, view: 'changes' }),
      );
      // Picking a file is why the overlay was opened; it is done. Focus left inside the closing
      // panel would be lost with it, so it goes back to the button that opened the panel.
      const returnFocus = overlayOpen.current && (railRef.current?.contains(document.activeElement) ?? false);
      setTreeOpenNarrow(false);
      if (returnFocus) treeToggleRef.current?.focus();
    },
    [],
  );
  const onToggleDir = useCallback((path: string, open?: boolean) => {
    setStored((current) => toggleDir(current, path, open));
  }, []);
  const onRevealFolder = (dirPath: string): void => {
    const rowPath = findDirRowPath(tree, dirPath);
    if (rowPath === null) return;
    setStored((current) => revealDir(current, rowPath));
    if (narrow) setTreeOpenNarrow(true);
    else if (!treeOpenWide) {
      writeStoredFlag(TREE_OPEN_KEY, true);
      setTreeOpenWide(true);
    }
  };
  const hasFile = useCallback((path: string) => fileByName.has(path), [fileByName]);

  const toggleWrap = (): void => {
    writeStoredFlag(WRAP_KEY, !wrap);
    setWrap(!wrap);
  };

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copyContents = async (): Promise<void> => {
    if (currentText === null) return;
    if (!(await copyToClipboard(currentText.raw))) return;
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };

  const copyPath = async (): Promise<void> => {
    if (fileName === null) return;
    const path = resolvedDir ? joinProjectPath(resolvedDir, fileName) : fileName;
    if (await copyToClipboard(path)) toast({ title: t('workspace.code.pathCopied') });
  };
  const openFolder = async (): Promise<void> => {
    const result = await openHostProjectPath(projectId);
    if (!result.ok) toast({ title: result.reason, tone: 'danger' });
  };
  // Read after mount: the desktop bridge does not exist while the page is rendered on the server.
  const [hostAvailable, setHostAvailable] = useState(false);
  useEffect(() => setHostAvailable(isOpenDesignHostAvailable()), []);

  const phrases = useMemo(() => editorPhrases(t), [t]);

  // ── render ──────────────────────────────────────────────────────────────────────────────────────
  const canShowChanges = fileChange !== null && fileChange.status !== 'deleted' && !notText;
  const inChanges = canShowChanges && state.view === 'changes';
  const changesLabel = inChanges ? t('workspace.code.showSource') : t('workspace.code.showChanges');
  const readable = file !== null && !notText;
  const previewAction = fileName !== null && (
    <button type="button" className={`${styles.control} ${styles.stateAction}`} onClick={() => onOpenPreview(fileName)}>
      {t('workspace.code.openPreview')}
    </button>
  );

  let body: ReactNode;
  if (fileByName.size === 0) {
    body = <StateNotice icon={FileCode} text={t('workspace.code.emptyProject')} />;
  } else if (file === null) {
    body = <StateNotice icon={FileCode} text={t('workspace.code.selectFile')} />;
  } else if (notText) {
    body = <StateNotice icon={FileX} text={t('workspace.code.notText')} action={previewAction} />;
  } else if (fileText.failed) {
    body = (
      <StateNotice
        icon={CircleAlert}
        text={t('workspace.code.loadFailed')}
        action={
          <button type="button" className={`${styles.control} ${styles.stateAction}`} onClick={fileText.reload}>
            {t('fileViewer.reload')}
          </button>
        }
      />
    );
  } else if (shown === null) {
    // Nothing to keep on screen: stay blank through the grace period, then say it is loading.
    body = fileText.slow ? <SkeletonLines /> : null;
  } else if (diff.mode === 'hunks' && shownChange) {
    body = <HunkList change={shownChange} wrap={wrap} />;
  } else {
    body = (
      <CodeEditor
        docKey={shown.name}
        text={shown.text}
        fileName={shown.name}
        wrap={wrap}
        original={diff.original}
        plain={shown.size > LARGE_TEXT_BYTES}
        phrases={phrases}
      />
    );
  }

  const notice =
    shown === null
      ? null
      : shown.size > LARGE_TEXT_BYTES
        ? t('workspace.code.largeFile')
        : diff.mode === 'merge' && diff.original === shown.text
          ? t('workspace.code.noChanges')
          : null;

  return (
    <div
      ref={rootRef}
      className={`${FX} ${styles.root}`}
      data-narrow={narrow || undefined}
      data-unmeasured={!measured || undefined}
      data-tree-open={treeOpen}
      data-resizing={pane.dragging || undefined}
      data-testid="code-surface"
      style={{ '--code-tree-width': `${pane.width}px` } as CSSProperties}
      onKeyDown={onRootKeyDown}
    >
      <header className={styles.header}>
        {fileName !== null ? (
          <Breadcrumb key={fileName} path={fileName} onRevealFolder={onRevealFolder} />
        ) : (
          <span className={styles.title}>{t('workspace.code.title')}</span>
        )}
        {fileChange?.status === 'created' ? <span className={styles.tag}>{t('workspace.code.newFile')}</span> : null}
        {streaming && fileChange !== null ? <span className={styles.liveDot} aria-hidden="true" /> : null}
        <div className={styles.actions}>
          {canShowChanges ? (
            <button
              type="button"
              className={`${styles.control} ${styles.textButton}`}
              aria-pressed={inChanges}
              title={changesLabel}
              onClick={() => setStored((current) => setView(current, inChanges ? 'source' : 'changes'))}
            >
              {changesLabel}
              {inChanges || fileChange === null ? null : (
                <ChangeCounts added={fileChange.added} removed={fileChange.removed} />
              )}
            </button>
          ) : null}
          {readable ? (
            <>
              <button
                type="button"
                className={`${styles.control} ${styles.iconButton}`}
                aria-pressed={wrap}
                aria-label={t('workspace.code.wrap')}
                title={t('workspace.code.wrap')}
                onClick={toggleWrap}
              >
                <WrapText {...ICON} />
              </button>
              <button
                type="button"
                className={`${styles.control} ${styles.iconButton}`}
                aria-label={t('fileViewer.copyTitle')}
                title={t('fileViewer.copyTitle')}
                disabled={currentText === null}
                onClick={() => void copyContents()}
              >
                {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
              </button>
            </>
          ) : null}
          {fileName !== null ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={`${styles.control} ${styles.iconButton}`}
                  aria-label={t('designs.menuMore')}
                  title={t('designs.menuMore')}
                >
                  <Ellipsis {...ICON} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent width="md" align="end">
                <DropdownMenuItem icon={<Eye size={14} strokeWidth={1.75} />} onSelect={() => onOpenPreview(fileName)}>
                  {t('workspace.code.openPreview')}
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Copy size={14} strokeWidth={1.75} />} onSelect={() => void copyPath()}>
                  {t('workspace.code.copyPath')}
                </DropdownMenuItem>
                {hostAvailable ? (
                  <DropdownMenuItem
                    icon={<FolderOpen size={14} strokeWidth={1.75} />}
                    onSelect={() => void openFolder()}
                  >
                    {t('workspace.code.openFolder')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <button
            ref={treeToggleRef}
            type="button"
            className={`${styles.control} ${styles.iconButton}`}
            aria-pressed={treeOpen}
            aria-label={t('workspace.code.toggleTree')}
            title={t('workspace.code.toggleTree')}
            onClick={toggleTree}
          >
            <PanelRight {...ICON} />
          </button>
        </div>
      </header>
      <div className={styles.body}>
        <section className={styles.viewer} aria-label={fileName ?? t('workspace.code.title')}>
          {notice !== null ? <p className={styles.notice}>{notice}</p> : null}
          <div className={styles.viewerBody}>{body}</div>
        </section>
        {narrow && treeOpenNarrow ? (
          // Click-away for the overlay; the keyboard closes it with Escape.
          <div className={styles.scrim} aria-hidden="true" onClick={() => closeOverlay(false)} />
        ) : null}
        <div
          className={styles.divider}
          {...pane.dividerProps}
          aria-label={t('workspace.code.toggleTree')}
        />
        <aside ref={railRef} className={styles.rail} aria-label={t('workspace.code.toggleTree')}>
          <FileRail
            tree={tree}
            expanded={state.expanded}
            selectedPath={fileName}
            turnChanges={turnChanges}
            hasFile={hasFile}
            reveal={state.reveal}
            filterRef={filterRef}
            onSelectFile={onSelectFile}
            onToggleDir={onToggleDir}
          />
        </aside>
      </div>
    </div>
  );
}
