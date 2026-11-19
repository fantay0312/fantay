// SPDX-License-Identifier: AGPL-3.0-only
// SQLite databases (.sqlite .sqlite3 .db .db3): every table and view as a tab under the grid, its
// rows in the same grid spreadsheets use. Column headers carry the declared type; NULL and binary
// values are said, not shown as content. The file is opened read-only in a worker
// (`database/database.worker.ts`) and rows are read a page at a time, so a large table opens at once.
// A file that is not a SQLite database gets the file card, with the reason.
'use client';

import { Database, Eye, TimerOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, useArtifactBytes } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { openDatabase, type DatabaseClient } from './database/database-client';
import {
  DATABASE_HEAD_ROWS,
  DATABASE_MAX_BYTES,
  type DatabaseFailure,
  type DatabaseModel,
  type DatabaseTable,
} from './database/database-protocol';
import { isSqliteFile } from './database/read-database';
import { DataGrid, type DataGridColumn } from './parts/DataGrid';
import { formatCount, type DataGridRow } from './sheet/grid-model';
import { fileGridSession, gridSession, trimIdleGrids, type GridSession } from './sheet/grid-session';
import { SheetTabs, type SheetTab } from './sheet/SheetTabs';
import { useRowWindows } from './sheet/use-row-windows';
import { FileCard } from './UnknownViewer';

/** Rows the column widths are measured from. */
const SAMPLE_ROWS = 120;

interface LiveDatabase {
  client: DatabaseClient;
  /** The file version the worker holds. */
  version: number;
}

interface TableGridProps {
  table: DatabaseTable;
  tableIndex: number;
  columns: readonly DataGridColumn[];
  live: LiveDatabase | null;
  /** The version the rows on screen belong to, when no worker is up yet. */
  version: number;
  session: GridSession;
  emptyLabel: string;
}

/** One table in the grid. Its first rows come with the database when it is among the first tables, and are read here otherwise. */
function TableGrid({ table, tableIndex, columns, live, version, session, emptyLabel }: TableGridProps): JSX.Element | null {
  const client = live?.client ?? null;
  const [head, setHead] = useState<readonly DataGridRow[] | null>(table.head);
  useEffect(() => {
    if (table.head !== null) {
      setHead(table.head);
      return;
    }
    if (!client) return;
    let current = true;
    void client.rows(tableIndex, 0, DATABASE_HEAD_ROWS).then((rows) => {
      if (!current) return;
      // Kept on the table itself, so the next visit paints without asking.
      table.head = [...rows];
      setHead(table.head);
    });
    return () => {
      current = false;
    };
  }, [client, table, tableIndex]);

  const sample = useMemo(() => (head ?? []).slice(0, SAMPLE_ROWS), [head]);
  const fetch = useMemo(() => (client ? (start: number, count: number) => client.rows(tableIndex, start, count) : null), [client, tableIndex]);
  const rows = useRowWindows({
    cache: session.cache,
    dataKey: String(live?.version ?? version),
    rowCount: table.rowCount,
    fetch,
    head: head ?? undefined,
  });
  // Until the first rows are here there is nothing to size the columns from.
  if (head === null) return null;
  return (
    <DataGrid
      label={table.name}
      columns={columns}
      rowCount={table.rowCount}
      rows={rows}
      sample={sample}
      session={session}
      addressing="record"
      emptyLabel={emptyLabel}
    />
  );
}

export default function DatabaseViewer(props: ArtifactViewerProps): JSX.Element {
  const { projectId, file, active } = props;
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const [tableName, setTableName] = useArtifactViewState<string | null>(projectId, file.name, 'table', null);

  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: DATABASE_MAX_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;

  // ── the open database ─────────────────────────────────────────────────────────────────────────
  const session = useMemo(() => fileGridSession<DatabaseModel>(projectId, file.name), [projectId, file.name]);
  const sessionKey = `${projectId}\n${file.name}`;
  // What is drawn: the last picture of the file until the worker has opened the current version.
  const [shown, setShown] = useState<{ key: string; model: DatabaseModel; version: number } | null>(() =>
    session.snapshot ? { key: sessionKey, model: session.snapshot.model, version: session.snapshot.mtime } : null,
  );
  const [live, setLive] = useState<(LiveDatabase & { key: string }) | null>(null);
  const [failure, setFailure] = useState<{ key: string; reason: DatabaseFailure } | null>(null);
  const [slow, setSlow] = useState(false);
  const mtimeRef = useRef(file.mtime);
  mtimeRef.current = file.mtime;

  useEffect(() => {
    if (!data) return;
    setFailure(null);
    setSlow(false);
    // The header says whether this is a database at all; no worker is needed to find out.
    if (!isSqliteFile(new Uint8Array(data, 0, Math.min(16, data.byteLength)))) {
      setFailure({ key: sessionKey, reason: 'not-database' });
      return;
    }
    const version = mtimeRef.current;
    let current = true;
    const slowTimer = window.setTimeout(() => {
      if (current) setSlow(true);
    }, ARTIFACT_SLOW_LOAD_MS);
    const client = openDatabase(data, {
      onReady: (model) => {
        if (!current) return;
        window.clearTimeout(slowTimer);
        session.snapshot = { mtime: version, model };
        setShown({ key: sessionKey, model, version });
        setLive({ client, version, key: sessionKey });
      },
      onFailed: (reason) => {
        if (!current) return;
        window.clearTimeout(slowTimer);
        setLive((previous) => (previous?.client === client ? null : previous));
        setFailure({ key: sessionKey, reason });
      },
    });
    return () => {
      current = false;
      window.clearTimeout(slowTimer);
      client.close();
      setLive((previous) => (previous?.client === client ? null : previous));
    };
  }, [data, session, sessionKey]);

  const model = shown?.key === sessionKey ? shown.model : null;
  const shownVersion = shown?.key === sessionKey ? shown.version : file.mtime;
  const liveDatabase = live?.key === sessionKey ? live : null;
  const failed = failure?.key === sessionKey ? failure.reason : null;

  // ── the table on show ─────────────────────────────────────────────────────────────────────────
  const tables = model?.tables ?? [];
  const tableIndex = Math.max(
    0,
    tables.findIndex((table) => table.name === tableName),
  );
  const table = tables[tableIndex];
  const grid = useMemo(() => gridSession(session, table?.name ?? ''), [session, table?.name]);
  useEffect(() => {
    trimIdleGrids(session, table?.name ?? '');
  }, [session, table?.name]);

  const columns = useMemo<DataGridColumn[]>(
    () =>
      (table?.columns ?? []).map((column) => ({
        label: column.name,
        hint: column.type ? column.type.toLowerCase() : undefined,
        title: [
          column.name,
          column.type || null,
          column.primaryKey ? t('artifact.database.primaryKey') : null,
          column.notNull ? t('artifact.database.notNull') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [table, t],
  );

  const tabs = useMemo<SheetTab[]>(
    () =>
      tables.map((item) => ({
        id: item.name,
        label: item.name,
        detail: item.readable ? formatCount(item.rowCount) : undefined,
        icon: item.kind === 'view' ? Eye : undefined,
        iconLabel: item.kind === 'view' ? t('artifact.database.view') : undefined,
      })),
    [tables, t],
  );

  const menu = useMemo<ArtifactMenuEntry[]>(() => [...fileActions.menu, fileActions.reloadEntry(bytes.reload)], [bytes.reload, fileActions]);

  // Not a database at all, or one that cannot be read: the file card says why.
  if (failed === 'not-database') return <FileCard {...props} reason={t('artifact.database.notDatabase')} />;
  if (failed === 'unreadable') return <FileCard {...props} reason={t('artifact.database.unreadable')} />;

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ArtifactShellState | null = null;
  if (bytes.source.status === 'too-large' || bytes.source.status === 'failed') {
    state = fileActions.sourceState(bytes.source, bytes.reload);
  } else if (failed === 'timeout') {
    state = fileActions.unsupported(t('artifact.database.timeout'), t('artifact.database.timeoutHint'), TimerOff);
  } else if (!model) {
    state =
      bytes.source.status === 'ready'
        ? slow
          ? { kind: 'loading', label: t('artifact.database.opening') }
          : { kind: 'loading', quiet: true }
        : fileActions.sourceState(bytes.source, bytes.reload);
  } else if (!table) {
    state = { kind: 'notice', icon: Database, title: t('artifact.database.empty') };
  }

  const meta =
    model && table
      ? t('artifact.database.meta', { tables: formatCount(tables.length), rows: formatCount(table.rowCount) })
      : '';

  return (
    <ArtifactShell
      viewer="database"
      path={file.name}
      stage="fill"
      meta={meta}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      footer={
        !state && table ? (
          <SheetTabs
            tabs={tabs}
            value={table.name}
            onChange={setTableName}
            label={t('artifact.database.tables')}
            listLabel={t('artifact.database.allTables')}
          />
        ) : undefined
      }
      state={state}
    >
      {table ? (
        <TableGrid
          key={table.name}
          table={table}
          tableIndex={tableIndex}
          columns={columns}
          live={liveDatabase}
          version={shownVersion}
          session={grid}
          emptyLabel={table.readable ? t('artifact.database.emptyTable') : t('artifact.database.tableFailed')}
        />
      ) : null}
    </ArtifactShell>
  );
}
