// SPDX-License-Identifier: Apache-2.0
// Variant file names (spec 04 §4.5.2): `<name>.variant-<label>.<ext>` (explicit) and the tolerated
// `<name>-v<label>` / `-variant-<label>` / `-option-<label>` forms.
import { boardKindForPath } from './kinds.js';

export interface BoardVariantPath {
  /** `dir + base + '#' + boardKindForPath(path)`; files sharing it form one variants row. */
  groupKey: string;
  /** Folder prefix including the trailing `/`, or `''` at the project root. */
  dir: string;
  base: string;
  label: string;
  /** Extension without the dot, as written. */
  ext: string;
  /** true for `.variant-<label>.`; false for the tolerated forms (used only when ≥ 2 files of a turn share the key). */
  explicit: boolean;
}

const EXPLICIT_VARIANT_PATTERN =
  /^(?<dir>(?:[^/]+\/)*)(?<base>[^/]+?)\.variant-(?<label>[a-z0-9][a-z0-9-]{0,31})\.(?<ext>[A-Za-z0-9]+)$/;
const TOLERATED_VARIANT_PATTERN =
  /^(?<dir>(?:[^/]+\/)*)(?<base>[^/]+?)-(?:v|variant-|option-)(?<label>[a-z0-9]{1,8})\.(?<ext>[A-Za-z0-9]+)$/;

/** Parses a variant path; null when the name is not a variant or the file is not placeable on the board. */
export function parseBoardVariantPath(path: string): BoardVariantPath | null {
  const normalized = path.replace(/\\/g, '/');
  const kind = boardKindForPath(normalized);
  if (!kind) return null;
  let explicit = true;
  let match = EXPLICIT_VARIANT_PATTERN.exec(normalized);
  if (!match) {
    explicit = false;
    match = TOLERATED_VARIANT_PATTERN.exec(normalized);
  }
  const groups = match?.groups;
  if (!groups) return null;
  const dir = groups.dir ?? '';
  const base = groups.base ?? '';
  const label = groups.label ?? '';
  const ext = groups.ext ?? '';
  if (!base || !label || !ext) return null;
  return { groupKey: `${dir}${base}#${kind}`, dir, base, label, ext, explicit };
}

/** The base file a variant belongs to: `dir + base + '.' + ext`. */
export function boardVariantBasePath(variant: Pick<BoardVariantPath, 'dir' | 'base' | 'ext'>): string {
  return `${variant.dir}${variant.base}.${variant.ext}`;
}

type LabelChunk = string | number;

function labelChunks(label: string): LabelChunk[] {
  const chunks: LabelChunk[] = [];
  for (const match of label.toLowerCase().matchAll(/(\d+)|(\D+)/g)) {
    chunks.push(match[1] !== undefined ? Number(match[1]) : (match[2] ?? ''));
  }
  return chunks;
}

/** Natural, case-insensitive order: `a < b`, `2 < 10`, `v2 < v10`; numbers sort before words. Deterministic. */
export function compareBoardVariantLabels(a: string, b: string): number {
  const left = labelChunks(a);
  const right = labelChunks(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left[index]!;
    const y = right[index]!;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Display form of a raw label: `'a'` → `'A'`, `'bold'` → `'Bold'`, `'1080x1920'` → `'1080×1920'`. */
export function formatBoardVariantLabel(label: string): string {
  const withTimes = label.replace(/(\d)x(?=\d)/g, '$1×');
  return withTimes.charAt(0).toUpperCase() + withTimes.slice(1);
}
