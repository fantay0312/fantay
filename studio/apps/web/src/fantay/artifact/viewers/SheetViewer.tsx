// SPDX-License-Identifier: AGPL-3.0-only
// Spreadsheets and delimited text: a grid that reads like the real thing. A workbook (.xlsx .xls
// .xlsb .ods .numbers …) shows its visible sheets as tabs under the grid, each value as the cell
// formats it. CSV and TSV show their rows as a table, with a "source" view beside it; the first row
// names the columns when it looks like a header, and the menu can say otherwise.
// The file is parsed in a worker (`sheet/sheet.worker.ts`) and rows arrive in windows, so a large
// file opens at once and fills in. What the reader left (sheet, selection, widths, scroll position)
// and the rows that were on screen are kept per file, so a tab switch or an update by the agent
// repaints where they were.
'use client';

import { FileSpreadsheet, Lock, Rows3, TimerOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import { MAX_TEXT_BYTES } from '../../workspace/code/text-preview';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { CodePane } from './parts/CodePane';
import { DataGrid, type DataGridColumn } from './parts/DataGrid';
import { columnLabel, formatCount, looksLikeHeader } from './sheet/grid-model';
import { fileGridSession, gridSession, trimIdleGrids, type GridSession } from './sheet/grid-session';
import { openSheet, type SheetClient } from './sheet/sheet-client';
import { SHEET_MAX_BYTES, type SheetBook, type SheetFailure, type SheetFormat, type SheetInfo } from './sheet/sheet-protocol';
import { SheetTabs, type SheetTab } from './sheet/SheetTabs';
import { decodeWith, detectEncoding } from './sheet/text-encoding';
import { useRowWindows } from './sheet/use-row-windows';

/** Rows the column widths are measured from. */
const SAMPLE_ROWS = 120;

interface LiveSheet {
  client: SheetClient;
  /** The file version the worker holds. */
  version: number;
}

interface SheetGridProps {
  label: string;
  sheet: SheetInfo;
  sheetIndex: number;
  /** 1 when the first row names the columns and is not a row of the table. */
  offset: number;
  columns: readonly DataGridColumn[];
  addressing: 'cell' | 'record';
  /** A spreadsheet lets long text run on over empty cells; a table of records does not. */
  spill: boolean;
  live: LiveSheet | null;
  /** The version the rows on screen belong to, when no worker is up yet. */
  version: number;
  session: GridSession;
  emptyLabel: string;
  busy: boolean;
}

/** One sheet in the grid: wires the sheet's facts and its rows (from the worker, in windows). */
function SheetGrid({ label, sheet, sheetIndex, offset, columns, addressing, spill, live, version, session, emptyLabel, busy }: SheetGridProps): JSX.Element {
  const head = useMemo(() => (offset > 0 ? sheet.head.slice(offset) : sheet.head), [sheet.head, offset]);
  const sample = useMemo(() => head.slice(0, SAMPLE_ROWS), [head]);
  const client = live?.client ?? null;
  const fetch = useMemo(
    () => (client ? (start: number, count: number) => client.rows(sheetIndex, start + offset, count) : null),
    [client, sheetIndex, offset],
  );
  const rowCount = Math.max(0, sheet.rowCount - offset);
  const rows = useRowWindows({ cache: session.cache, dataKey: String(live?.version ?? version), rowCount, fetch, head });
  return (
    <DataGrid
      label={label}
      columns={columns}
      rowCount={rowCount}
      rows={rows}
      sample={sample}
      merges={sheet.merges}
      session={session}
      addressing={addressing}
      rowLabels={sheet.rowLabels}
      overflow={spill ? 'spill' : 'clip'}
      emptyLabel={emptyLabel}
      busy={busy}
    />
  );
}

export default function SheetViewer({ projectId, file, family, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const format: SheetFormat = family.format === 'csv' || family.format === 'tsv' ? family.format : 'workbook';
  const delimited = format !== 'workbook';
  const [mode, setMode] = useArtifactViewState<'table' | 'source'>(projectId, file.name, 'mode', 'table');
  const [sheetName, setSheetName] = useArtifactViewState<string | null>(projectId, file.name, 'sheet', null);
  /** null: decide from the content. */
  const [headerChoice, setHeaderChoice] = useArtifactViewState<boolean | null>(projectId, file.name, 'header', null);
  const showingSource = delimited && mode === 'source';

  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: SHEET_MAX_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;

  // ── the parsed file ───────────────────────────────────────────────────────────────────────────
  const session = useMemo(() => fileGridSession<SheetBook>(projectId, file.name), [projectId, file.name]);
  const sessionKey = `${projectId}\n${file.name}`;
  // What is drawn: the last picture of the file until the worker has read the current version.
  const [shown, setShown] = useState<{ key: string; book: SheetBook; version: number } | null>(() =>
    session.snapshot ? { key: sessionKey, book: session.snapshot.model, version: session.snapshot.mtime } : null,
  );
  const [live, setLive] = useState<(LiveSheet & { key: string }) | null>(null);
  const [failure, setFailure] = useState<{ key: string; reason: SheetFailure } | null>(null);
  const [slow, setSlow] = useState(false);
  const mtimeRef = useRef(file.mtime);
  mtimeRef.current = file.mtime;

  useEffect(() => {
    if (!data) return;
    const version = mtimeRef.current;
    let current = true;
    setFailure(null);
    setSlow(false);
    const slowTimer = window.setTimeout(() => {
      if (current) setSlow(true);
    }, ARTIFACT_SLOW_LOAD_MS);
    const client = openSheet(format, data, {
      onReady: (book) => {
        if (!current) return;
        window.clearTimeout(slowTimer);
        session.snapshot = { mtime: version, model: book };
        setShown({ key: sessionKey, book, version });
        setLive({ client, version, key: sessionKey });
      },
      onProgress: (progress) => {
        if (!current) return;
        setShown((previous) => {
          const first = previous?.book.sheets[0];
          if (!previous || !first || previous.version !== version) return previous;
          const book: SheetBook = {
            ...previous.book,
            sheets: [{ ...first, rowCount: progress.rowCount, columnCount: progress.columnCount }],
            partial: !progress.done,
            truncated: progress.truncated,
          };
          session.snapshot = { mtime: version, model: book };
          return { ...previous, book };
        });
      },
      onFailed: (reason) => {
        if (!current) return;
        window.clearTimeout(slowTimer);
        setFailure({ key: sessionKey, reason });
      },
    });
    return () => {
      current = false;
      window.clearTimeout(slowTimer);
      client.close();
      setLive((previous) => (previous?.client === client ? null : previous));
    };
  }, [data, format, session, sessionKey]);

  const book = shown?.key === sessionKey ? shown.book : null;
  const shownVersion = shown?.key === sessionKey ? shown.version : file.mtime;
  const liveSheet = live?.key === sessionKey ? live : null;
  const failed = failure?.key === sessionKey ? failure.reason : null;

  // ── the sheet on show ─────────────────────────────────────────────────────────────────────────
  const sheets = book?.sheets ?? [];
  const sheetIndex = Math.max(
    0,
    sheets.findIndex((sheet) => sheet.name === sheetName),
  );
  const sheet = sheets[sheetIndex];

  const guessedHeader = useMemo(
    () => (delimited && sheet ? looksLikeHeader(sheet.head.slice(0, 41).map((row) => row.cells)) : false),
    [delimited, sheet],
  );
  const hasHeader = delimited && (headerChoice ?? guessedHeader);
  const offset = hasHeader && sheet && sheet.rowCount > 0 ? 1 : 0;

  const headerRow = offset === 1 ? sheet?.head[0] : undefined;
  const sheetColumns = sheet?.columns;
  const columnCount = sheet?.columnCount ?? 0;
  const columns = useMemo<DataGridColumn[]>(() => {
    if (sheetColumns && sheetColumns.length > 0) return sheetColumns.map((column) => ({ label: column.label, width: column.width }));
    const list: DataGridColumn[] = [];
    for (let index = 0; index < columnCount; index += 1) {
      // A header cell left blank still needs a name to point at: its letter.
      list.push({ label: headerRow?.cells[index]?.trim() || columnLabel(index) });
    }
    return list;
  }, [sheetColumns, columnCount, headerRow]);

  const gridId = `${sheet?.name ?? ''}\n${offset}`;
  const grid = useMemo(() => gridSession(session, gridId), [session, gridId]);
  useEffect(() => {
    trimIdleGrids(session, gridId);
  }, [session, gridId]);

  // ── source view ───────────────────────────────────────────────────────────────────────────────
  const encoding = book?.encoding;
  const sourceTooLarge = file.size > MAX_TEXT_BYTES;
  const sourceText = useMemo(() => {
    if (!showingSource || !data || sourceTooLarge) return null;
    const raw = new Uint8Array(data);
    return decodeWith(raw, encoding ?? detectEncoding(raw));
  }, [showingSource, data, sourceTooLarge, encoding]);

  // ── bar ───────────────────────────────────────────────────────────────────────────────────────
  const rowCount = sheet ? Math.max(0, sheet.rowCount - offset) : 0;
  let meta = '';
  if (book && sheet && !showingSource) {
    if (!delimited) {
      meta = t('artifact.sheet.metaWorkbook', { sheets: formatCount(sheets.length), rows: formatCount(sheet.rowCount) });
    } else if (book.partial) {
      meta = t('artifact.sheet.metaReading', { rows: formatCount(rowCount) });
    } else {
      const size = { rows: formatCount(rowCount), cols: formatCount(columnCount) };
      meta = book.truncated ? t('artifact.sheet.metaTruncated', size) : t('artifact.grid.size', size);
      // Worth saying only when it is not the encoding everyone expects.
      if (encoding && encoding !== 'utf-8') meta += ` · ${encoding.toUpperCase()}`;
    }
  } else if (showingSource) {
    meta = formatBytes(file.size);
  }

  const menu = useMemo<ArtifactMenuEntry[]>(() => {
    const entries: ArtifactMenuEntry[] = [];
    if (delimited && !showingSource && sheet && sheet.rowCount > 0) {
      entries.push({
        id: 'header',
        label: hasHeader ? t('artifact.sheet.headerOff') : t('artifact.sheet.headerOn'),
        icon: Rows3,
        onSelect: () => setHeaderChoice(!hasHeader),
      });
    }
    return [...entries, ...fileActions.menu, fileActions.reloadEntry(bytes.reload)];
  }, [bytes.reload, delimited, fileActions, hasHeader, setHeaderChoice, sheet, showingSource, t]);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ArtifactShellState | null = null;
  if (bytes.source.status === 'too-large' || bytes.source.status === 'failed') {
    state = fileActions.sourceState(bytes.source, bytes.reload);
  } else if (showingSource) {
    if (sourceTooLarge) {
      state = fileActions.unsupported(
        t('artifact.state.tooLarge'),
        t('artifact.state.tooLargeHint', { size: formatBytes(file.size), limit: formatBytes(MAX_TEXT_BYTES) }),
      );
    } else if (sourceText === null) {
      state = fileActions.sourceState(bytes.source, bytes.reload);
    }
  } else if (failed === 'protected') {
    state = fileActions.unsupported(t('artifact.sheet.protected'), t('artifact.sheet.protectedHint'), Lock);
  } else if (failed === 'timeout') {
    state = fileActions.unsupported(t('artifact.sheet.timeout'), t('artifact.sheet.timeoutHint'), TimerOff);
  } else if (failed === 'too-large') {
    state = fileActions.unsupported(t('artifact.sheet.unpackedTooLarge'), t('artifact.sheet.timeoutHint'));
  } else if (failed) {
    state = fileActions.unsupported(t('artifact.sheet.failed'), t('artifact.sheet.failedHint'));
  } else if (!book) {
    state =
      bytes.source.status === 'ready'
        ? slow
          ? { kind: 'loading', label: t('artifact.sheet.reading') }
          : { kind: 'loading', quiet: true }
        : fileActions.sourceState(bytes.source, bytes.reload);
  } else if (!sheet) {
    state = fileActions.unsupported(t('artifact.sheet.noSheets'), undefined, FileSpreadsheet);
  } else if (delimited && sheet.rowCount === 0 && !book.partial) {
    // Nothing to lay out as a table: say so instead of drawing an empty frame.
    state = { kind: 'notice', icon: FileSpreadsheet, title: t('artifact.sheet.emptyFile') };
  }

  const tabs = useMemo<SheetTab[]>(() => sheets.map((item) => ({ id: item.name, label: item.name })), [sheets]);
  const emptyLabel = delimited
    ? offset === 1
      ? t('artifact.sheet.noRows')
      : t('artifact.sheet.emptyFile')
    : t('artifact.sheet.emptySheet');

  return (
    <ArtifactShell
      viewer="sheet"
      path={file.name}
      stage="fill"
      modes={
        delimited
          ? [
              { id: 'table', label: t('artifact.sheet.viewTable') },
              { id: 'source', label: t('artifact.sheet.viewSource') },
            ]
          : undefined
      }
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'source' ? 'source' : 'table')}
      meta={meta}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      footer={
        !delimited && !state && sheet ? (
          <SheetTabs
            tabs={tabs}
            value={sheet.name}
            onChange={setSheetName}
            label={t('artifact.sheet.sheets')}
            listLabel={t('artifact.sheet.allSheets')}
          />
        ) : undefined
      }
      state={state}
    >
      {showingSource ? (
        sourceText !== null ? (
          <CodePane docKey={`${file.name}:source`} fileName={file.name} text={sourceText} />
        ) : null
      ) : sheet ? (
        <SheetGrid
          key={gridId}
          label={sheet.name || file.name}
          sheet={sheet}
          sheetIndex={sheetIndex}
          offset={offset}
          columns={columns}
          addressing={delimited && offset === 1 ? 'record' : 'cell'}
          spill={!delimited}
          live={liveSheet}
          version={shownVersion}
          session={grid}
          emptyLabel={emptyLabel}
          busy={book?.partial ?? false}
        />
      ) : null}
    </ArtifactShell>
  );
}
