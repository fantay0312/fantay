// SPDX-License-Identifier: AGPL-3.0-only
// Archives (zip, tar, tar.gz, gz): what is inside, without unpacking anything to disk. The stage is
// a listing: a tree of folders and files with sizes, and a filter. Selecting a file opens a pane
// beside the list (below it in a narrow panel) with its text, its picture, or its facts; one file
// can be saved out on its own. The reading runs in a worker under limits (see archive-reader.ts).
// Open folders, the selected file, the filter and the scroll position belong to the file, so they
// survive a tab switch and a rewrite. Formats this cannot list (7z, rar, …) show the file card.
'use client';

import { ChevronsDownUp, ChevronsUpDown, FileArchive, LockKeyhole } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useI18n, useT } from '../../../i18n';
import { InputGroupClear, SearchField } from '../../ui';
import { downloadBlob } from '../../board/interaction/file-actions';
import { collectDirPaths, filterFileTree, flattenFileTree } from '../../workspace/code/file-tree';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import styles from './ArchiveViewer.module.css';
import { ArchivePeek, type PeekContent, type PeekReason } from './archive/ArchivePeek';
import { ArchiveTree } from './archive/ArchiveTree';
import { openArchiveSession, type ArchiveSession } from './archive/archive-client';
import { decodePeekText, planPeek } from './archive/archive-peek';
import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_SAVE_BYTES,
  ArchiveError,
  type ArchiveEntry,
  type ArchiveFailure,
  type ArchiveFormat,
  type ArchiveListing,
} from './archive/archive-reader';
import { buildArchiveTree, initialExpansion } from './archive/archive-tree';
import { FileCard } from './UnknownViewer';

/** The whole archive is read into memory (twice: here and in the worker), so it has a ceiling. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** Height of the column header the rows scroll under. */
const COLUMNS_HEIGHT = 28;
const FORMATS: ReadonlySet<string> = new Set<ArchiveFormat>(['zip', 'tar', 'tar.gz', 'gz']);

/** True once `pending` has lasted long enough to be worth a word on screen. */
function useSlow(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

function peekReasonFor(error: unknown): PeekReason {
  const code: ArchiveFailure = error instanceof ArchiveError ? error.code : 'invalid';
  if (code === 'too-large' || code === 'encrypted' || code === 'unsupported' || code === 'timeout') return code;
  return 'failed';
}

function ArchiveContents({ projectId, file, family, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const { locale } = useI18n();
  const fileActions = useArtifactFileActions(projectId, file);
  const hint = FORMATS.has(family.format) ? (family.format as ArchiveFormat) : undefined;

  // ── the archive ───────────────────────────────────────────────────────────────────────────────
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MAX_ARCHIVE_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;
  /** The listing on screen and the bytes it came from. It stays until a newer one has been read. */
  const [opened, setOpened] = useState<{ data: ArrayBuffer; listing: ArchiveListing } | null>(null);
  const [failed, setFailed] = useState<{ data: ArrayBuffer; code: ArchiveFailure } | null>(null);
  /** The worker behind the listing on screen: entry ids are only valid against it. */
  const sessionRef = useRef<ArchiveSession | null>(null);

  useEffect(() => {
    if (!data) return;
    let current = true;
    const session = openArchiveSession(data, file.name, hint);
    session.listing.then(
      (listing) => {
        if (!current) {
          session.close();
          return;
        }
        sessionRef.current?.close();
        sessionRef.current = session;
        setFailed(null);
        setOpened({ data, listing });
      },
      (error: unknown) => {
        session.close();
        if (current) setFailed({ data, code: error instanceof ArchiveError ? error.code : 'invalid' });
      },
    );
    return () => {
      current = false;
      if (sessionRef.current !== session) session.close();
    };
  }, [data, file.name, hint]);

  useEffect(
    () => () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    },
    [],
  );

  /** Unpacks one entry. A worker ended by a missed deadline is started again from the same bytes. */
  const readEntry = useCallback(
    async (id: number, limit: number): Promise<Uint8Array<ArrayBuffer>> => {
      let session = sessionRef.current;
      if ((!session || session.closed) && opened) {
        session = openArchiveSession(opened.data, file.name, hint);
        sessionRef.current = session;
        await session.listing;
      }
      if (!session) throw new ArchiveError('missing');
      return session.read(id, limit);
    },
    [opened, file.name, hint],
  );

  const listing = opened?.listing ?? null;
  const model = useMemo(() => (listing ? buildArchiveTree(listing) : null), [listing]);

  // ── what the reader set ───────────────────────────────────────────────────────────────────────
  const [query, setQuery] = useArtifactViewState(projectId, file.name, 'filter', '');
  /** null until the reader opens or closes a folder: the archive then decides (see initialExpansion). */
  const [expandedPaths, setExpandedPaths] = useArtifactViewState<string[] | null>(projectId, file.name, 'expanded', null);
  const [selectedPath, setSelectedPath] = useArtifactViewState<string | null>(projectId, file.name, 'selected', null);

  const expanded = useMemo(
    () => new Set(expandedPaths ?? (model ? initialExpansion(model) : [])),
    [expandedPaths, model],
  );
  const filtering = query.trim() !== '';
  const rows = useMemo(() => {
    if (!model) return [];
    const roots = filterFileTree(model.roots, query);
    return flattenFileTree(roots, filtering ? 'all' : expanded);
  }, [model, query, filtering, expanded]);

  const toggleDir = useCallback(
    (path: string, open?: boolean) => {
      const next = new Set(expanded);
      if (open ?? !next.has(path)) next.add(path);
      else next.delete(path);
      setExpandedPaths([...next]);
    },
    [expanded, setExpandedPaths],
  );

  const selected: ArchiveEntry | null = (selectedPath !== null ? model?.files.get(selectedPath) : null) ?? null;

  // ── scrolling ─────────────────────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || restored.current || rows.length === 0) return;
    restored.current = true;
    element.scrollTop = readArtifactViewState<number>(projectId, file.name, 'scroll') ?? 0;
  }, [rows.length, projectId, file.name]);

  // ── the selected entry's content ──────────────────────────────────────────────────────────────
  const [peek, setPeek] = useState<{ key: string; content: PeekContent } | null>(null);
  const peekKey = opened && selected ? `${file.name}:${file.mtime}:${selected.id}:${selected.path}` : null;
  const plan = useMemo(() => (selected ? planPeek(selected) : null), [selected]);

  useEffect(() => {
    if (!selected || !plan || !peekKey) return;
    if (plan.kind === 'facts') {
      setPeek({ key: peekKey, content: { status: 'facts', reason: plan.reason } });
      return;
    }
    let current = true;
    let url: string | null = null;
    readEntry(selected.id, plan.limit).then(
      (entryBytes) => {
        if (!current) return;
        if (plan.kind === 'image') {
          url = URL.createObjectURL(new Blob([entryBytes], { type: plan.mime }));
          setPeek({ key: peekKey, content: { status: 'image', url } });
          return;
        }
        const text = decodePeekText(entryBytes);
        setPeek({ key: peekKey, content: text === null ? { status: 'facts', reason: 'type' } : { status: 'text', text } });
      },
      (error: unknown) => {
        if (current) setPeek({ key: peekKey, content: { status: 'facts', reason: peekReasonFor(error) } });
      },
    );
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected, plan, peekKey, readEntry]);

  const content: PeekContent = peek && peek.key === peekKey ? peek.content : { status: 'pending' };
  const peekSlow = useSlow(selected !== null && content.status === 'pending');

  // ── saving one entry ──────────────────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ key: string; text: string } | null>(null);
  const saveEntry = useCallback(async () => {
    if (!selected || !peekKey) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const entryBytes = await readEntry(selected.id, ARCHIVE_SAVE_BYTES);
      downloadBlob(new Blob([entryBytes]), selected.path.split('/').pop() ?? selected.path);
    } catch (error) {
      const tooLarge = error instanceof ArchiveError && error.code === 'too-large';
      setSaveNote({ key: peekKey, text: t(tooLarge ? 'artifact.archive.peek.saveTooLarge' : 'artifact.archive.peek.saveFailed') });
    } finally {
      setSaving(false);
    }
  }, [selected, peekKey, readEntry, t]);

  // ── words ─────────────────────────────────────────────────────────────────────────────────────
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
    [locale],
  );
  const formatDate = useCallback((time: number) => dateFormat.format(time), [dateFormat]);
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const treeLabels = useMemo(
    () => ({ tree: t('artifact.archive.tree'), encrypted: t('artifact.archive.entryEncrypted'), link: t('artifact.archive.entryLink') }),
    [t],
  );

  const meta = listing
    ? listing.fileCount === 1
      ? t('artifact.archive.summaryOne', { size: formatBytes(listing.totalSize) })
      : t('artifact.archive.summary', { count: numberFormat.format(listing.fileCount), size: formatBytes(listing.totalSize) })
    : formatBytes(file.size);

  const menu = useMemo<ArtifactMenuEntry[]>(() => {
    const folders = model ? collectDirPaths(model.roots) : [];
    const disabled = folders.length === 0 || filtering;
    return [
      { id: 'expand-all', label: t('artifact.archive.expandAll'), icon: ChevronsUpDown, disabled, onSelect: () => setExpandedPaths(folders) },
      { id: 'collapse-all', label: t('artifact.archive.collapseAll'), icon: ChevronsDownUp, disabled, onSelect: () => setExpandedPaths([]) },
      ...fileActions.menu.map((entry, index) => (index === 0 ? { ...entry, separated: true } : entry)),
    ];
  }, [model, filtering, fileActions.menu, setExpandedPaths, t]);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const failure = failed && failed.data === data && !(opened && opened.data === data) ? failed.code : null;
  const parsing = data !== null && !opened && !failure;
  const parsingSlow = useSlow(parsing);
  let state: ArtifactShellState | null = null;
  if (failure === 'encrypted') {
    state = fileActions.unsupported(t('artifact.archive.failed.encrypted'), t('artifact.archive.failed.encryptedHint'), LockKeyhole);
  } else if (failure === 'timeout') {
    state = {
      kind: 'notice',
      icon: FileArchive,
      title: t('artifact.archive.failed.timeout'),
      action: { label: t('fileViewer.reload'), onSelect: bytes.reload },
      secondaryAction: { label: t('fileViewer.download'), onSelect: fileActions.downloadFile },
    };
  } else if (failure === 'too-large') {
    state = fileActions.unsupported(t('artifact.archive.failed.tooLarge'), undefined, FileArchive);
  } else if (failure) {
    state = fileActions.unsupported(t('artifact.archive.failed.invalid'), t('artifact.archive.failed.invalidHint'), FileArchive);
  } else if (!opened) {
    state = parsing
      ? parsingSlow
        ? { kind: 'loading', label: t('artifact.archive.reading') }
        : { kind: 'loading', quiet: true }
      : fileActions.sourceState(bytes.source, bytes.reload);
  } else if (listing && listing.entries.length === 0) {
    state = { kind: 'notice', icon: FileArchive, title: t('artifact.archive.empty') };
  }

  const filterRef = useRef<HTMLInputElement | null>(null);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // ⌘F / Ctrl+F goes to the filter, unless the text pane (which has its own find) has the focus.
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
    if ((event.target as HTMLElement).closest('[data-artifact-code]')) return;
    event.preventDefault();
    filterRef.current?.focus();
    filterRef.current?.select();
  };

  const notes = listing
    ? [
        listing.truncated ? t('artifact.archive.truncated', { count: numberFormat.format(ARCHIVE_MAX_ENTRIES) }) : null,
        listing.unsafePaths > 0 ? t('artifact.archive.unsafePaths', { count: numberFormat.format(listing.unsafePaths) }) : null,
        listing.encryptedCount > 0 ? t('artifact.archive.encryptedNote') : null,
      ].filter((note): note is string => note !== null)
    : [];

  return (
    <ArtifactShell
      viewer="archive"
      path={file.name}
      stage="fill"
      meta={meta}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {model ? (
        <div className={styles.layout} data-peek={selected ? '' : undefined} onKeyDown={onKeyDown}>
          <div className={styles.list}>
            <div className={styles.filter}>
              <SearchField
                ref={filterRef}
                value={query}
                placeholder={t('artifact.archive.filter')}
                aria-label={t('artifact.archive.filter')}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query !== '') {
                    event.stopPropagation();
                    setQuery('');
                  }
                }}
                trailing={query !== '' ? <InputGroupClear onClear={() => setQuery('')} /> : null}
              />
            </div>
            {notes.length > 0 ? (
              <div className={styles.notes} role="note">
                {notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            ) : null}
            <div
              ref={scrollRef}
              className={styles.scroller}
              onScroll={(event) => writeArtifactViewState(projectId, file.name, 'scroll', event.currentTarget.scrollTop)}
            >
              <div className={styles.columns} aria-hidden="true">
                <span className={styles.columnName}>{t('artifact.archive.columnName')}</span>
                <span className={styles.rowDate}>{t('artifact.archive.columnModified')}</span>
                <span className={styles.rowSize}>{t('artifact.archive.columnSize')}</span>
              </div>
              {rows.length > 0 ? (
                <ArchiveTree
                  rows={rows}
                  model={model}
                  selectedPath={selectedPath}
                  scrollRef={scrollRef}
                  scrollMargin={COLUMNS_HEIGHT}
                  labels={treeLabels}
                  lockExpansion={filtering}
                  formatDate={formatDate}
                  onToggleDir={toggleDir}
                  onSelectFile={setSelectedPath}
                />
              ) : (
                <p className={styles.noMatches}>{t('artifact.archive.noMatches', { query: query.trim() })}</p>
              )}
            </div>
          </div>
          {selected ? (
            <>
              <div className={styles.divider} aria-hidden="true" />
              <ArchivePeek
                entry={selected}
                content={content}
                slow={peekSlow}
                docKey={peekKey ?? selected.path}
                formatDate={formatDate}
                saveNote={saveNote && saveNote.key === peekKey ? saveNote.text : null}
                saving={saving}
                onSave={() => void saveEntry()}
                onClose={() => setSelectedPath(null)}
                onImageError={() => {
                  if (peekKey) setPeek({ key: peekKey, content: { status: 'facts', reason: 'failed' } });
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </ArtifactShell>
  );
}

export default function ArchiveViewer(props: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const { family } = props;
  if (family.format === 'unsupported') {
    const diskImage = family.extension === 'dmg' || family.extension === 'iso';
    return (
      <FileCard
        {...props}
        reason={diskImage ? t('artifact.archive.diskImageReason') : t('artifact.archive.unsupportedReason', { type: family.extension.toUpperCase() })}
      />
    );
  }
  return <ArchiveContents {...props} />;
}
