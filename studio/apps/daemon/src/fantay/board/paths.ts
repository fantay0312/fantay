// SPDX-License-Identifier: Apache-2.0
// Board cover blob locations (spec 04 §4.2). Every path derives from the daemon data root passed in by the caller
// (`ctx.paths.RUNTIME_DATA_DIR`); there is no env or cwd fallback (AGENTS.md "Daemon data directory contract").
import path from 'node:path';

import { isSafeId } from '../../projects.js';

export const BOARD_COVER_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const BOARD_COVER_FILE_EXTENSIONS = ['webp', 'png', 'jpg'] as const;
export type BoardCoverFileExtension = (typeof BOARD_COVER_FILE_EXTENSIONS)[number];

export function isBoardCoverDigest(value: unknown): value is string {
  return typeof value === 'string' && BOARD_COVER_DIGEST_PATTERN.test(value);
}

/** `<runtimeDataDir>/fantay/board-covers`. */
export function boardCoversRoot(runtimeDataDir: string): string {
  if (typeof runtimeDataDir !== 'string' || runtimeDataDir.length === 0) {
    throw new Error('board covers need an explicit daemon data root');
  }
  return path.join(runtimeDataDir, 'fantay', 'board-covers');
}

/** `<root>/<projectId>`; the id must pass the daemon's project id rule (same as `resolveProjectDir`). */
export function boardCoverDir(runtimeDataDir: string, projectId: string): string {
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return path.join(boardCoversRoot(runtimeDataDir), projectId);
}

/** `<root>/<projectId>/<sha256>.<webp|png|jpg>`. */
export function boardCoverFile(
  runtimeDataDir: string,
  projectId: string,
  digest: string,
  ext: BoardCoverFileExtension,
): string {
  if (!isBoardCoverDigest(digest)) throw new Error('invalid cover digest');
  if (!(BOARD_COVER_FILE_EXTENSIONS as readonly string[]).includes(ext)) throw new Error('invalid cover extension');
  return path.join(boardCoverDir(runtimeDataDir, projectId), `${digest}.${ext}`);
}
