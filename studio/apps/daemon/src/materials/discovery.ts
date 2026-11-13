// Deterministic keyword ranking for material library records.
//
// This is a port of the archive's own search rules so the daemon, the web UI
// and the archive CLI (`fantasy-design search`) rank the same index the same
// way. Source of truth: `素材库/导览支持/scripts/discovery.py` (`normalize`,
// `searchable`, `score`, `capabilities`, `ALIASES`) and the sort key in
// `素材库/导览支持/scripts/fantasy_design.py` (`execute`, command `search`).
// Keep both sides in sync when the archive changes its rules.

import path from 'node:path';

import type { MaterialUse } from '@open-design/contracts';

/**
 * Bilingual alias families. Mirrors `ALIASES` in `素材库/导览支持/scripts/discovery.py`
 * verbatim (the index also ships a copy as `search_aliases`, which the archive
 * CLI ignores in favour of the hard-coded table; so do we).
 */
export const MATERIAL_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '通知': ['toast', 'sonner', 'notification'],
  '抽屉': ['drawer', 'vaul'],
  '聊天': ['chat', 'thread', 'assistant'],
  '动效': ['motion', 'animation', '动画'],
  '玻璃': ['glass', 'terse'],
  '手绘': ['sketch', 'hand-drawn'],
  '图标': ['icon', 'svg'],
  '作品集': ['portfolio'],
  '拟物': ['skeuomorphic'],
};

const ALIAS_FAMILIES: readonly (readonly string[])[] = Object.entries(MATERIAL_SEARCH_ALIASES).map(
  ([key, aliases]) => [key, ...aliases],
);

const ALIAS_MAP: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, Set<string>>();
  for (const family of ALIAS_FAMILIES) {
    for (const term of family) {
      let set = map.get(term);
      if (!set) map.set(term, (set = new Set([term])));
      for (const word of family) set.add(word);
    }
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [term, words] of map) frozen.set(term, [...words]);
  return frozen;
})();

export const MATERIAL_SEARCH_META = Symbol.for('fantay.materialSearchMeta');

export interface MaterialSearchMeta {
  haystack: string;
  titleNorm: string;
  titleLower: string;
}

export type PreparedMaterialQuery = readonly (readonly string[])[];

/** Score weights from `discovery.score`: exact title / inside title / elsewhere. */
export const MATERIAL_SCORE_EXACT_TITLE = 12;
export const MATERIAL_SCORE_IN_TITLE = 6;
export const MATERIAL_SCORE_ELSEWHERE = 1;

/** Python `str(value or '')`: falsy values become the empty string. */
function pythonText(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return '';
  return String(value);
}

/**
 * `unicodedata.normalize('NFKC', str(value or '')).casefold()`.
 * `toLowerCase()` approximates `casefold()`; they differ only for a few
 * special cases (for example `ß`), none of which occur in the archive's
 * Chinese/English vocabulary.
 */
export function normalizeMaterialText(value: unknown): string {
  return pythonText(value).normalize('NFKC').toLowerCase();
}

/** Python `str.split()` without arguments: split on whitespace runs, drop empties. */
export function splitMaterialQuery(query: string): string[] {
  return normalizeMaterialText(query).split(/\s+/u).filter((term) => term.length > 0);
}

const SEARCHABLE_SCALAR_KEYS = [
  'id',
  'title',
  'subtitle',
  'category',
  'collection',
  'section',
  'description',
  'source',
  'notes',
] as const;

const VISUALSKILLS_SCALAR_KEYS = [
  'project_id',
  'project_url',
  'site_category',
  'site_category_label',
  'description_zh',
  'cover',
] as const;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function visualskillsTerms(item: Record<string, unknown>): string[] {
  const vs = item.visualskills;
  if (!vs || typeof vs !== 'object' || Array.isArray(vs)) return [];
  const vsRecord = vs as Record<string, unknown>;
  const terms: string[] = [];
  for (const key of VISUALSKILLS_SCALAR_KEYS) {
    const val = vsRecord[key];
    if (typeof val === 'string' && val) terms.push(val);
  }
  const snapshot = vsRecord.snapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const skillPath = (snapshot as Record<string, unknown>).skill_path;
    if (typeof skillPath === 'string' && skillPath) terms.push(skillPath);
  }
  const related = vsRecord.related_projects;
  if (Array.isArray(related)) {
    for (const rel of related) {
      if (rel && typeof rel === 'object' && !Array.isArray(rel)) {
        const relRecord = rel as Record<string, unknown>;
        for (const key of VISUALSKILLS_SCALAR_KEYS) {
          const val = relRecord[key];
          if (typeof val === 'string' && val) terms.push(val);
        }
      }
    }
  }
  return terms;
}

/** `discovery.searchable`: one normalized haystack per record. */
export function materialSearchableText(item: Record<string, unknown>): string {
  const values = SEARCHABLE_SCALAR_KEYS.map((key) => {
    const value = item[key];
    return value === null || value === undefined ? '' : String(value);
  });
  values.push(...stringList(item.tags));
  values.push(...stringList(item.subcategories));
  values.push(...visualskillsTerms(item));
  return normalizeMaterialText(values.join(' '));
}

export function prepareMaterialQuery(query: string): PreparedMaterialQuery {
  const terms = splitMaterialQuery(query);
  return terms.map((term) => ALIAS_MAP.get(term) ?? [term]);
}

export function scoreMaterialPrepared(item: Record<string, unknown>, prepared: PreparedMaterialQuery): number {
  if (prepared.length === 0) return 1;
  const cached = (item as Record<symbol, MaterialSearchMeta | undefined>)[MATERIAL_SEARCH_META];
  const haystack = cached ? cached.haystack : materialSearchableText(item);
  const title = cached ? cached.titleNorm : normalizeMaterialText(item.title);
  let total = 0;
  for (const alternatives of prepared) {
    let best = 0;
    for (const word of alternatives) {
      if (!haystack.includes(word)) continue;
      const weight =
        word === title
          ? MATERIAL_SCORE_EXACT_TITLE
          : title.includes(word)
            ? MATERIAL_SCORE_IN_TITLE
            : MATERIAL_SCORE_ELSEWHERE;
      if (weight > best) best = weight;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/**
 * `discovery.score`: every whitespace-separated term must match the haystack
 * (directly or through its alias family). Returns 0 for a miss and 1 for an
 * empty query, so callers keep every record when no query is given.
 */
export function scoreMaterial(item: Record<string, unknown>, query: string): number {
  return scoreMaterialPrepared(item, prepareMaterialQuery(query));
}

/** Python `str` ordering compares code points; JS `<` compares UTF-16 units. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

/** Sort key of `fantasy-design search`: `(-score, title.casefold(), id)`. */
export function compareRankedMaterials(
  a: { score: number; title: string; titleLower?: string; id: string },
  b: { score: number; title: string; titleLower?: string; id: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  const byTitle = compareCodePoints(a.titleLower ?? a.title.toLowerCase(), b.titleLower ?? b.title.toLowerCase());
  if (byTitle !== 0) return byTitle;
  return compareCodePoints(a.id, b.id);
}

/**
 * Browse order for an empty query: the library page's rail order (风格 → 组件 →
 * 设计 Skill → 图标 → pages and files → 网站), so records with previews lead
 * and the text-only website bookmarks come last. Unknown kinds sit with
 * `file`. Queries with terms keep the CLI ranking above; this is the one
 * deliberate difference from `fantasy-design search`, which lists an empty
 * query by title alone.
 */
const MATERIAL_BROWSE_KIND_ORDER = ['style', 'component', 'skill', 'svg', 'html', 'markdown', 'file', 'website'];

function browseKindRank(kind: string): number {
  const rank = MATERIAL_BROWSE_KIND_ORDER.indexOf(kind);
  return rank === -1 ? MATERIAL_BROWSE_KIND_ORDER.indexOf('file') : rank;
}

export function compareBrowseMaterials(
  a: { kind: string; title: string; titleLower?: string; id: string },
  b: { kind: string; title: string; titleLower?: string; id: string },
): number {
  const byKind = browseKindRank(a.kind) - browseKindRank(b.kind);
  if (byKind !== 0) return byKind;
  const byTitle = compareCodePoints(a.titleLower ?? a.title.toLowerCase(), b.titleLower ?? b.title.toLowerCase());
  if (byTitle !== 0) return byTitle;
  return compareCodePoints(a.id, b.id);
}

const SOURCE_FILE_SUFFIXES = new Set(['.svg', '.tsx', '.ts', '.jsx', '.js', '.css', '.py']);

/** `discovery.capabilities`, used when an index record lacks `capabilities`. */
export function deriveMaterialCapabilities(item: Record<string, unknown>): {
  material: MaterialUse;
  preview_entry: boolean;
  design_tokens: boolean;
  source_manifest: boolean;
  license_document: boolean;
} {
  const entry = typeof item.path === 'string' ? item.path : '';
  const suffix = path.posix.extname(entry).toLowerCase();
  const material: MaterialUse =
    item.kind === 'website'
      ? 'website_record'
      : SOURCE_FILE_SUFFIXES.has(suffix)
        ? 'source_file'
        : 'local_reference';
  return {
    material,
    preview_entry: Boolean(item.preview),
    design_tokens: Boolean(item.tokens),
    source_manifest: Boolean(item.source_manifest),
    license_document: Boolean(item.license_document),
  };
}
