import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBoardOps,
  emptyBoardContent,
  emptyBoardSyncLedger,
  type BoardContent,
  type BoardOp,
} from '@open-design/contracts';

import {
  BoardRevisionMismatchError,
  BoardStorageError,
  boardCreatedAtWatermark,
  commitBoard,
  createdIdsInOpOrder,
  migrateBoardTables,
  readBoardDocument,
  readBoardLedger,
  readBoardRow,
  stampMonotonicCreatedAt,
  writeBoardLedger,
  writeBoardViewport,
} from '../../../src/fantay/board/store.js';

const NOW = 1_800_000_000_000;

describe('board store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO projects (id) VALUES (?), (?)').run('p1', 'p2');
    migrateBoardTables(db);
    migrateBoardTables(db); // idempotent
  });

  afterEach(() => db.close());

  function contentWithNote(text: string): BoardContent {
    const outcome = applyBoardOps(emptyBoardContent(), [{ op: 'add', node: { id: 'n_note1', kind: 'note', text } }], {
      baseRevision: 0,
      nextRevision: 1,
      actor: { kind: 'user' },
      now: NOW,
      newId: () => 'n_unused',
      checkConflicts: true,
    });
    if (!outcome.ok) throw new Error('note did not apply');
    return outcome.content;
  }

  it('reads a project without a row as the empty document (revision 0)', () => {
    expect(readBoardRow(db, 'p1')).toBeNull();
    expect(readBoardDocument(db, 'p1')).toEqual({
      schemaVersion: 1,
      projectId: 'p1',
      revision: 0,
      updatedAt: 0,
      updatedBy: null,
      viewport: null,
      settings: { background: 'dots', autoPlace: true },
      nodes: [],
      edges: [],
    });
    expect(readBoardDocument(db, 'p1', { includeSync: true }).sync).toEqual(emptyBoardSyncLedger());
    expect(readBoardLedger(db, 'p1')).toEqual(emptyBoardSyncLedger());
  });

  it('commits revisions with compare-and-set and keeps updatedAt/updatedBy', () => {
    const content = contentWithNote('hello');
    const ledger = { ...emptyBoardSyncLedger(), seededAt: NOW };
    expect(commitBoard(db, { projectId: 'p1', expectedRevision: 0, content, ledger, now: NOW, actor: { kind: 'cli' } })).toBe(1);
    const doc = readBoardDocument(db, 'p1', { includeSync: true });
    expect(doc).toMatchObject({ revision: 1, updatedAt: NOW, updatedBy: { kind: 'cli' }, sync: { seededAt: NOW } });
    expect(doc.nodes).toEqual(content.nodes);

    expect(() => commitBoard(db, { projectId: 'p1', expectedRevision: 0, content, ledger, now: NOW + 1, actor: { kind: 'user' } }))
      .toThrow(BoardRevisionMismatchError);
    try {
      commitBoard(db, { projectId: 'p1', expectedRevision: 5, content, ledger, now: NOW + 1, actor: { kind: 'user' } });
    } catch (error) {
      expect(error).toMatchObject({ expected: 5, actual: 1 });
    }
    expect(commitBoard(db, { projectId: 'p1', expectedRevision: 1, content: contentWithNote('again'), ledger, now: NOW + 2, actor: { kind: 'user' } })).toBe(2);
    expect(readBoardRow(db, 'p1')!.content.nodes[0]).toMatchObject({ text: 'again' });
  });

  it('writes the viewport and the ledger without bumping the revision', () => {
    writeBoardViewport(db, 'p1', { centerX: 10, centerY: 20, zoom: 0.5 }, NOW);
    expect(readBoardDocument(db, 'p1')).toMatchObject({ revision: 0, viewport: { centerX: 10, centerY: 20, zoom: 0.5 }, nodes: [] });
    commitBoard(db, { projectId: 'p1', expectedRevision: 0, content: contentWithNote('x'), ledger: emptyBoardSyncLedger(), now: NOW, actor: { kind: 'user' } });
    writeBoardViewport(db, 'p1', { centerX: 1, centerY: 2, zoom: 2 }, NOW + 5);
    writeBoardLedger(db, 'p1', { ...emptyBoardSyncLedger(), seededAt: 7, cursor: 3 });
    const doc = readBoardDocument(db, 'p1', { includeSync: true });
    expect(doc.revision).toBe(1);
    expect(doc.viewport).toEqual({ centerX: 1, centerY: 2, zoom: 2 });
    expect(doc.sync).toMatchObject({ seededAt: 7, cursor: 3 });
    expect(doc.nodes).toHaveLength(1);
    // A ledger write on a project without a row creates an empty revision-0 row.
    writeBoardLedger(db, 'p2', { ...emptyBoardSyncLedger(), seededAt: 9 });
    expect(readBoardDocument(db, 'p2', { includeSync: true })).toMatchObject({ revision: 0, nodes: [], sync: { seededAt: 9 } });
    // Viewport writes keep the ledger and vice versa.
    writeBoardViewport(db, 'p2', { centerX: 0, centerY: 0, zoom: 1 }, NOW);
    expect(readBoardLedger(db, 'p2').seededAt).toBe(9);
  });

  it('deletes the board with its project (foreign key cascade)', () => {
    commitBoard(db, { projectId: 'p1', expectedRevision: 0, content: contentWithNote('x'), ledger: emptyBoardSyncLedger(), now: NOW, actor: { kind: 'user' } });
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    expect(readBoardRow(db, 'p1')).toBeNull();
    expect(() => writeBoardViewport(db, 'missing-project', { centerX: 0, centerY: 0, zoom: 1 }, NOW)).toThrow();
  });

  it('fails loudly on a damaged row instead of reading it as empty', () => {
    db.prepare(
      `INSERT INTO fantay_boards (project_id, revision, schema_version, content_json, sync_json, viewport_json, updated_at)
       VALUES ('p1', 3, 1, '{not json', '{}', NULL, 0)`,
    ).run();
    expect(() => readBoardRow(db, 'p1')).toThrow(BoardStorageError);
  });
});

describe('B13 monotonic createdAt', () => {
  const ctx = (now: number) => ({
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'user' as const },
    now,
    newId: (() => {
      let counter = 0;
      return (prefix: 'n' | 'e') => `${prefix}_rand${(counter += 1)}`;
    })(),
    checkConflicts: true,
  });

  it('gives every entity a batch creates a distinct, increasing createdAt and re-sorts edges by it', () => {
    const before = emptyBoardContent();
    const ops: BoardOp[] = [
      { op: 'add', node: { id: 'n_zzz', kind: 'note', text: 'z' } },
      { op: 'add', node: { id: 'n_aaa', kind: 'note', text: 'a' } },
      { op: 'add', node: { id: 'n_gen', kind: 'generator', version: 1, surface: 'image', prompt: '', model: null, params: { aspect: '1:1', count: 1 }, runs: [] } },
      { op: 'connect', edge: { id: 'e_zzz', kind: 'reference', from: 'n_zzz', to: 'n_gen' } },
      { op: 'connect', edge: { id: 'e_aaa', kind: 'reference', from: 'n_aaa', to: 'n_gen' } },
    ];
    const outcome = applyBoardOps(before, ops, ctx(NOW));
    if (!outcome.ok) throw new Error('ops did not apply');
    // Without stamping both edges tie on createdAt and the random-looking id decides the order.
    expect(outcome.content.edges.map((edge) => edge.id)).toEqual(['e_aaa', 'e_zzz']);
    const createdIds = createdIdsInOpOrder(ops, outcome.results, before, outcome.content);
    expect(createdIds).toEqual(['n_zzz', 'n_aaa', 'n_gen', 'e_zzz', 'e_aaa']);
    const stamped = stampMonotonicCreatedAt({ content: outcome.content, changes: outcome.changes, createdIds, watermark: NOW + 50, clock: NOW });
    expect(stamped.content.nodes.map((node) => node.createdAt)).toEqual([NOW + 51, NOW + 52, NOW + 53]);
    expect(stamped.content.edges.map((edge) => [edge.id, edge.createdAt])).toEqual([['e_zzz', NOW + 54], ['e_aaa', NOW + 55]]);
    expect(stamped.changes!.upsertEdges.map((edge) => edge.id)).toEqual(['e_zzz', 'e_aaa']);
    expect(stamped.content.nodes.every((node) => node.updatedAt >= node.createdAt)).toBe(true);
    expect(stamped.lastCreatedAt).toBe(NOW + 55);
  });

  it('keeps the watermark across deletions and uses the clock when it is ahead', () => {
    const content = { ...emptyBoardContent(), nodes: [] };
    expect(boardCreatedAtWatermark({ content, lastCreatedAt: NOW + 900 })).toBe(NOW + 900);
    const stamped = stampMonotonicCreatedAt({
      content: { ...content, nodes: [] },
      createdIds: [],
      watermark: NOW + 900,
      clock: NOW,
    });
    expect(stamped.lastCreatedAt).toBeNull();
    const outcome = applyBoardOps(content, [{ op: 'add', node: { id: 'n_one', kind: 'note', text: '' } }], ctx(NOW + 5_000));
    if (!outcome.ok) throw new Error('add failed');
    const later = stampMonotonicCreatedAt({ content: outcome.content, createdIds: ['n_one'], watermark: NOW + 900, clock: NOW + 5_000 });
    expect(later.content.nodes[0]!.createdAt).toBe(NOW + 5_000);
  });

  it('does not restamp entities brought back by a restore op', () => {
    const added = applyBoardOps(emptyBoardContent(), [{ op: 'add', node: { id: 'n_keep', kind: 'note', text: 'k' } }], ctx(NOW));
    if (!added.ok) throw new Error('add failed');
    const removed = applyBoardOps(added.content, [{ op: 'remove', ids: ['n_keep'] }], { ...ctx(NOW + 10), baseRevision: 1, nextRevision: 2 });
    if (!removed.ok) throw new Error('remove failed');
    const restored = applyBoardOps(removed.content, removed.inverse, { ...ctx(NOW + 20), baseRevision: 2, nextRevision: 3 });
    if (!restored.ok) throw new Error('restore failed');
    expect(createdIdsInOpOrder(removed.inverse, restored.results, removed.content, restored.content)).toEqual([]);
    expect(restored.content.nodes[0]!.createdAt).toBe(NOW);
  });
});
