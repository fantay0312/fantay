// One-time migration for data dirs that predate the retirement of the chat
// auto-extraction pipelines.
//
// Context: the chat regex pack wrote junk facts from ordinary chat text
// (the progressive-aspect "我在…" became "user location: 开做："), and the
// chat-form profile capture accumulated per-project discovery answers into
// the global `user_profile`. Both pipelines are retired (chat extraction now
// defaults OFF in `readMemoryConfig`).
//
// This migration never touches memory text. Memory only grows: nothing is
// deleted, moved or rewritten on the system's own initiative, so entries the
// retired pipelines wrote stay where they are for a person to review. All it
// does is switch off chat extraction on a config that an earlier settings
// PATCH persisted as `true` (a side effect of writing the whole config
// object), and record a marker so later boots do nothing. That switch only
// stops new writes; it neither hides nor changes any existing entry.
//
// One-time semantics: a marker file inside the memory dir records the run.
// Later boots are no-ops, so a user who consciously re-enables extraction
// afterwards is not flipped back.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { memoryDir, readMemoryConfig, writeMemoryConfig } from './memory.js';

const MARKER_FILE = '.cleanup_auto_extracted_v1.json';

export interface AutoExtractionCleanupResult {
  /** False when the marker already existed and nothing was touched. */
  ran: boolean;
  /** Always empty: this migration no longer removes entries. Kept for existing callers. */
  deletedIds: string[];
  /** Always false: this migration no longer rewrites user_profile. Kept for existing callers. */
  profilePruned: boolean;
  /** True when chat extraction was switched from on to off. */
  extractionSwitchedOff: boolean;
}

function markerPath(dataDir: string): string {
  return path.join(memoryDir(dataDir), MARKER_FILE);
}

/**
 * Run the one-time migration for a data dir. Idempotent via a marker file;
 * safe to call on every daemon boot. Never throws for a config problem: a
 * migration must not take the daemon down.
 */
export async function runAutoExtractionCleanup(
  dataDir: string,
): Promise<AutoExtractionCleanupResult> {
  try {
    await fsp.access(markerPath(dataDir));
    return { ran: false, deletedIds: [], profilePruned: false, extractionSwitchedOff: false };
  } catch {
    // No marker — first run.
  }

  let extractionSwitchedOff = false;
  try {
    // Only write when the switch is on, so an untouched config stays untouched.
    if ((await readMemoryConfig(dataDir)).chatExtractionEnabled) {
      await writeMemoryConfig(dataDir, { chatExtractionEnabled: false });
      extractionSwitchedOff = true;
    }
  } catch (err) {
    console.warn(
      '[memory] cleanup could not update config:',
      err instanceof Error ? err.message : err,
    );
  }

  const marker = { ranAt: Date.now(), extractionSwitchedOff };
  await fsp.mkdir(memoryDir(dataDir), { recursive: true });
  await fsp.writeFile(markerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`);

  return { ran: true, deletedIds: [], profilePruned: false, extractionSwitchedOff };
}
