// SPDX-License-Identifier: AGPL-3.0-only
// Default Share target for the board header (spec 02 §5.6). Pure.
import type { ProjectFile } from '../../types';

const HTML_FILE = /\.html$/i;

/** 'index.html' if present, else the most recently modified `.html` file (first one on ties), else null. */
export function defaultBoardShareTarget(files: readonly ProjectFile[]): string | null {
  let newest: ProjectFile | null = null;
  for (const file of files) {
    if (file.type === 'dir') continue;
    if (file.name === 'index.html') return file.name;
    if (!HTML_FILE.test(file.name)) continue;
    if (newest === null || file.mtime > newest.mtime) newest = file;
  }
  return newest?.name ?? null;
}
