import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { closeDatabase, openDatabase } from '../src/db.js';

// The retired AMR runtime kept a durable outbox of terminal billing reports
// that it delivered through `vela run terminal`. Nothing creates, reads or
// delivers it any more; an upgraded database keeps whatever rows it holds.
describe('retired AMR terminal report outbox', () => {
  let tempDir: string;

  const hasOutboxTable = (db: Database.Database): boolean =>
    Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'amr_terminal_report_outbox'",
    ).get());

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-retired-amr-outbox-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('is not created for a fresh database', () => {
    const db = openDatabase(tempDir, { dataDir: path.join(tempDir, 'data') });
    expect(hasOutboxTable(db)).toBe(false);
  });

  it('leaves an existing outbox table and its rows untouched', () => {
    const dataDir = path.join(tempDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const legacy = new Database(path.join(dataDir, 'app.sqlite'));
    legacy.exec(`
      CREATE TABLE amr_terminal_report_outbox (
        run_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        terminal_at INTEGER NOT NULL
      );
      INSERT INTO amr_terminal_report_outbox (run_id, outcome, terminal_at)
        VALUES ('historical-amr-run', 'failed', 1700000000000);
    `);
    legacy.close();

    const db = openDatabase(tempDir, { dataDir });
    expect(hasOutboxTable(db)).toBe(true);
    expect(db.prepare('SELECT run_id AS runId, outcome FROM amr_terminal_report_outbox').all())
      .toEqual([{ runId: 'historical-amr-run', outcome: 'failed' }]);
  });
});
