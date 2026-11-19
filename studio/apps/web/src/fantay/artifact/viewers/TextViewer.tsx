// SPDX-License-Identifier: AGPL-3.0-only
// Text, code and data files: the file as it is written, with line numbers, highlighting and find.
// About 150 extensions come here, and also mail and diagram sources until they have viewers of
// their own. The bar offers what a reader of text needs and nothing else: wrap, copy, download.
// A minified or irregular JSON file adds a "formatted | original" switch, and formatting only
// re-spaces the text, so no number ever changes. Size decides how much is read: up to 2 MB in full,
// up to 10 MB without highlighting, above that only the head of the file. Bytes that are not text
// become the file card instead of a screen of noise.
'use client';

import { Check, Copy, FileText, WrapText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import { copyText } from '../../board/interaction/file-actions';
import { normalizeNewlines } from '../../workspace/code/original-text';
import { LARGE_TEXT_BYTES, looksBinary } from '../../workspace/code/text-preview';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactBytes } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { parseAnsi, type AnsiSpan } from './text/ansi';
import { decodeTextBytes } from './text/decode-text';
import { readJson, readJsonLines, type JsonReading } from './text/json-format';
import { logLevelSpans } from './text/log-levels';
import { countLines, languageNameFor, textTier, wrapsByDefault } from './text/text-format';
import { TextPane } from './text/TextPane';
import { useTextHead } from './text/use-text-head';
import { FileCard } from './UnknownViewer';

/** How long the copy button shows its check. */
const COPIED_MS = 1500;
const NO_SPANS: readonly AnsiSpan[] = [];
const NO_JSON: JsonReading = { formatted: null, preferFormatted: false };

type TextMode = 'formatted' | 'raw';

interface Reading {
  /** The text as the reader sees it: "\n" line breaks, no terminal escape codes. */
  text: string;
  spans: readonly AnsiSpan[];
  /** Null for UTF-8. */
  encoding: string | null;
  binary: boolean;
}

export default function TextViewer(props: ArtifactViewerProps): JSX.Element {
  const { projectId, file, family, active } = props;
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const tier = textTier(file.size);
  const headOnly = tier === 'head';

  // ── the text ──────────────────────────────────────────────────────────────────────────────────
  const whole = useArtifactBytes(projectId, file, { enabled: active && !headOnly });
  const head = useTextHead(projectId, file, active && headOnly);
  const bytes = whole.source.status === 'ready' ? whole.source.data : null;
  const headData = head.source.status === 'ready' ? head.source.data : null;

  const reading = useMemo<Reading | null>(() => {
    const decoded = headOnly
      ? headData && { text: headData.text, encoding: null, binary: looksBinary(headData.text) }
      : bytes && decodeTextBytes(bytes);
    if (!decoded) return null;
    if (decoded.binary) return { text: '', spans: NO_SPANS, encoding: null, binary: true };
    const text = normalizeNewlines(decoded.text);
    // A log saved from a terminal: the colour codes leave the text and come back as tints.
    const terminal = family.format === 'log' || family.format === 'plain' ? parseAnsi(text) : null;
    const clean = terminal?.text ?? text;
    // A log that brought no colours of its own still gets its warnings and errors marked.
    const spans = terminal && terminal.spans.length > 0 ? terminal.spans : family.format === 'log' ? logLevelSpans(clean) : NO_SPANS;
    return { text: clean, spans, encoding: decoded.encoding, binary: false };
  }, [bytes, headData, headOnly, family.format]);

  // ── JSON: formatted or as written ─────────────────────────────────────────────────────────────
  const json = useMemo<JsonReading>(() => {
    if (!reading || tier !== 'full') return NO_JSON;
    if (family.format === 'json') return readJson(reading.text);
    if (family.format === 'jsonl') return readJsonLines(reading.text);
    return NO_JSON;
  }, [reading, tier, family.format]);
  /** Null until the reader chooses: a minified file opens formatted, a hand-written one as written. */
  const [chosenMode, setMode] = useArtifactViewState<TextMode | null>(projectId, file.name, 'mode', null);
  const mode: TextMode = json.formatted === null ? 'raw' : (chosenMode ?? (json.preferFormatted ? 'formatted' : 'raw'));
  const shownText = reading === null ? null : mode === 'formatted' && json.formatted !== null ? json.formatted : reading.text;

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const [wrap, setWrap] = useArtifactViewState<boolean>(projectId, file.name, 'wrap', wrapsByDefault(family.viewer, family.format));
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copyAll = useCallback(async () => {
    if (shownText === null || !(await copyText(shownText))) return;
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }, [shownText]);

  const reload = headOnly ? head.reload : whole.reload;
  const hasText = shownText !== null && shownText !== '';

  const actions = useMemo<ArtifactAction[]>(() => {
    const list: ArtifactAction[] = [
      { id: 'wrap', label: t('workspace.code.wrap'), icon: WrapText, on: wrap, disabled: !hasText, onSelect: () => setWrap((value) => !value) },
    ];
    // "Copy all" would be a lie for a file of which only the head is here.
    if (!headOnly) {
      list.push({
        id: 'copy',
        label: copied ? t('fileViewer.copied') : t('artifact.text.copyAll'),
        icon: copied ? Check : Copy,
        disabled: !hasText,
        onSelect: () => void copyAll(),
      });
    }
    list.push(fileActions.download);
    return list;
  }, [t, wrap, setWrap, hasText, headOnly, copied, copyAll, fileActions.download]);

  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [{ ...fileActions.reloadEntry(reload), separated: false }, ...fileActions.menu],
    [fileActions, reload],
  );

  // A file read in part has no line count; its size is the fact that matters.
  const facts = [
    reading && !headOnly ? t('artifact.text.lines', { count: countLines(reading.text).toLocaleString() }) : null,
    formatBytes(file.size),
    reading?.encoding ?? null,
  ].filter(Boolean);

  if (reading?.binary) return <FileCard {...props} reason={t('artifact.text.notText')} />;

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ArtifactShellState | null = headOnly
    ? fileActions.sourceState(head.source, head.reload)
    : fileActions.sourceState(whole.source, whole.reload);
  if (state === null && !hasText) state = { kind: 'notice', icon: FileText, title: t('artifact.text.empty') };

  // One quiet line when the file is not shown the usual way. "Highlighting is off" is only said of
  // a file that would have had any: a log or a letter never did.
  const highlightable = family.viewer === 'text' && family.format !== 'log' && family.format !== 'plain' && family.format !== 'subtitle';
  const notice = headOnly
    ? headData
      ? t('artifact.text.headOnly', { size: formatBytes(file.size), shown: formatBytes(headData.bytes) })
      : null
    : highlightable && shownText !== null && shownText.length > LARGE_TEXT_BYTES
      ? t('workspace.code.largeFile')
      : null;

  return (
    <ArtifactShell
      viewer="text"
      path={file.name}
      stage="fill"
      modes={
        json.formatted !== null
          ? [
              { id: 'formatted', label: t('artifact.text.formatted') },
              { id: 'raw', label: t('artifact.text.raw') },
            ]
          : undefined
      }
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'formatted' ? 'formatted' : 'raw')}
      meta={facts.join(' · ')}
      actions={actions}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {hasText && shownText !== null ? (
        <TextPane
          projectId={projectId}
          fileName={file.name}
          view={mode}
          languageName={languageNameFor(file.name, family.format, family.extension)}
          text={shownText}
          wrap={wrap}
          spans={mode === 'raw' ? reading?.spans : undefined}
          notice={notice}
        />
      ) : null}
    </ArtifactShell>
  );
}
