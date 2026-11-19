// SPDX-License-Identifier: AGPL-3.0-only
// Jupyter notebooks (`.ipynb`): a reading column of what was written and what it produced. Markdown
// cells are prose, code cells are highlighted source with a quiet `In [n]`, and each cell's saved
// outputs follow it: printed text, pictures, tables, errors with their traceback. Nothing is ever
// run; a notebook is read exactly as it was saved. "Source" shows the file's JSON for the reader
// who needs the raw thing. A file that is not a notebook says so and offers the source instead.
'use client';

import { Check, Copy, FileWarning, NotebookText, WrapText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import { copyText } from '../../board/interaction/file-actions';
import { LARGE_TEXT_BYTES } from '../../workspace/code/text-preview';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactText } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { NotebookPage } from './notebook/NotebookPage';
import { parseNotebook } from './notebook/parse-notebook';
import { TextPane } from './text/TextPane';

/** Notebooks carry their pictures inline, so they are large; past this, parsing would stall the tab. */
const MAX_NOTEBOOK_BYTES = 24 * 1024 * 1024;
const COPIED_MS = 1500;

type NotebookMode = 'notebook' | 'source';

export default function NotebookViewer({ projectId, file, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const [mode, setMode] = useArtifactViewState<NotebookMode>(projectId, file.name, 'mode', 'notebook');
  const [wrap, setWrap] = useArtifactViewState<boolean>(projectId, file.name, 'wrap', false);

  const text = useArtifactText(projectId, file, { enabled: active, maxBytes: MAX_NOTEBOOK_BYTES });
  const raw = text.source.status === 'ready' ? text.source.data : null;
  const parsed = useMemo(() => (raw === null ? null : parseNotebook(raw)), [raw]);
  const notebook = parsed?.ok ? parsed.notebook : null;

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copySource = useCallback(async () => {
    if (raw === null || !(await copyText(raw))) return;
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }, [raw]);

  const showingSource = mode === 'source';
  const actions = useMemo<ArtifactAction[]>(() => {
    if (!showingSource) return [fileActions.download];
    return [
      { id: 'wrap', label: t('workspace.code.wrap'), icon: WrapText, on: wrap, disabled: raw === null, onSelect: () => setWrap((value) => !value) },
      {
        id: 'copy',
        label: copied ? t('fileViewer.copied') : t('artifact.text.copyAll'),
        icon: copied ? Check : Copy,
        disabled: raw === null,
        onSelect: () => void copySource(),
      },
      fileActions.download,
    ];
  }, [showingSource, fileActions.download, t, wrap, setWrap, raw, copied, copySource]);

  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [{ ...fileActions.reloadEntry(text.reload), separated: false }, ...fileActions.menu],
    [fileActions, text.reload],
  );

  const facts = notebook
    ? [t('artifact.notebook.cells', { count: notebook.totalCells.toLocaleString() }), notebook.languageLabel]
    : [formatBytes(file.size)];

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ArtifactShellState | null = fileActions.sourceState(text.source, text.reload);
  if (state === null && !showingSource && parsed) {
    const toSource = { label: t('artifact.notebook.showSource'), onSelect: () => setMode('source') };
    if (!parsed.ok) {
      state = {
        kind: 'notice',
        icon: FileWarning,
        title: t('artifact.notebook.invalid'),
        description: t(parsed.reason === 'version' ? 'artifact.notebook.unsupportedVersion' : 'artifact.notebook.invalidHint'),
        action: toSource,
      };
    } else if (parsed.notebook.cells.length === 0) {
      state = { kind: 'notice', icon: NotebookText, title: t('artifact.notebook.empty') };
    }
  }

  return (
    <ArtifactShell
      viewer="notebook"
      path={file.name}
      stage={showingSource ? 'fill' : 'page'}
      modes={[
        { id: 'notebook', label: t('artifact.notebook.viewNotebook') },
        { id: 'source', label: t('artifact.notebook.viewSource') },
      ]}
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'source' ? 'source' : 'notebook')}
      meta={facts.filter(Boolean).join(' · ')}
      actions={actions}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {raw === null ? null : showingSource ? (
        <TextPane
          projectId={projectId}
          fileName={file.name}
          view="source"
          languageName={`${file.name}.json`}
          text={raw}
          wrap={wrap}
          notice={raw.length > LARGE_TEXT_BYTES ? t('workspace.code.largeFile') : null}
        />
      ) : notebook ? (
        <NotebookPage projectId={projectId} fileName={file.name} notebook={notebook} />
      ) : null}
    </ArtifactShell>
  );
}
