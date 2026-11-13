// SPDX-License-Identifier: Apache-2.0
// Ledger of legacy design-canvas documents imported into projects (spec 06 §7.3):
// `<RUNTIME_DATA_DIR>/design-canvas/.migrations.json` = `{ "version": 1, "migrations": DesignMigrationRecord[] }`,
// replaced atomically. The legacy store itself is never modified.
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { DesignMigrationRecord } from '@open-design/contracts';

import { isSha256Hex, readFileIfExists, writeFileAtomic } from './files.js';
import { designMigrationLedgerPath } from './paths.js';

const LEDGER_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMigrationRecord(value: unknown): value is DesignMigrationRecord {
  return isRecord(value)
    && typeof value.legacyId === 'string'
    && isSha256Hex(value.legacySha256)
    && typeof value.projectId === 'string'
    && typeof value.path === 'string'
    && isSha256Hex(value.sha256)
    && typeof value.migratedAt === 'string';
}

interface LedgerRead {
  migrations: DesignMigrationRecord[];
  /** The file exists but is not a readable ledger. */
  corrupt: boolean;
}

async function readLedgerFile(runtimeDataDir: string): Promise<LedgerRead> {
  const raw = await readFileIfExists(designMigrationLedgerPath(runtimeDataDir));
  if (raw === null) return { migrations: [], corrupt: false };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    const list = isRecord(parsed) && Array.isArray(parsed.migrations) ? parsed.migrations : null;
    if (!list) return { migrations: [], corrupt: true };
    return { migrations: list.filter(isMigrationRecord), corrupt: false };
  } catch {
    return { migrations: [], corrupt: true };
  }
}

/** Every recorded import, oldest first. A missing or unreadable ledger reads as empty. */
export async function readDesignMigrations(runtimeDataDir: string): Promise<DesignMigrationRecord[]> {
  return (await readLedgerFile(runtimeDataDir)).migrations;
}

/**
 * Appends one record. Callers serialize appends (one writer per daemon). An unreadable ledger is kept aside as
 * `.migrations.json.corrupt-<time>` before a fresh one is written.
 */
export async function appendDesignMigration(runtimeDataDir: string, record: DesignMigrationRecord, now = Date.now()): Promise<void> {
  const file = designMigrationLedgerPath(runtimeDataDir);
  const current = await readLedgerFile(runtimeDataDir);
  await mkdir(path.dirname(file), { recursive: true });
  if (current.corrupt) await rename(file, `${file}.corrupt-${now}`).catch(() => undefined);
  const body = { version: LEDGER_VERSION, migrations: [...current.migrations, record] };
  await writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
}
