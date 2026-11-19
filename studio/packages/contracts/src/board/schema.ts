// SPDX-License-Identifier: Apache-2.0
// Internal field schema for board nodes, edges and op payloads (spec 04 §3.1 + plan R3). Shared by validate.ts and
// ops.ts; not re-exported from the package index.
import type { ApiValidationIssue } from '../errors.js';
import { MEDIA_FAILURE_NEXT_STEPS } from '../api/media.js';
import {
  BOARD_EDGE_KINDS,
  BOARD_GENERATOR_SURFACES,
  BOARD_LIMITS,
  BOARD_NODE_KINDS,
  BOARD_PALETTE,
  type BoardActor,
  type BoardActorKind,
  type BoardColor,
  type BoardNodeKind,
} from '../api/board.js';
import { BOARD_ID_PATTERN } from './ids.js';

export type Issues = ApiValidationIssue[];

export function pushIssue(issues: Issues, path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

export function childPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy of JSON-like data (plain objects, arrays, primitives); `undefined` entries are dropped. */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry: unknown) => cloneJson(entry)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = cloneJson(entry);
    }
    return out as T;
  }
  return value;
}

/** Structural equality of JSON-like data (key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => jsonEqual(entry, b[index]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
    const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => jsonEqual(a[key], b[key]));
  }
  return false;
}

// ---- predicates (re-exported by validate.ts) ------------------------------------

/** POSIX relative path: no leading `/`, no `\`, no NUL, no empty/`.`/`..` segments, ≤ 512 chars. */
export function isSafeBoardPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > BOARD_LIMITS.maxPathLength) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** `http:` / `https:` URL with a host, ≤ 2048 chars, no whitespace or control characters. */
export function isSafeBoardUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > BOARD_LIMITS.maxUrlLength) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(u)) return false;
  try {
    const url = new URL(u);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Palette token or `#RRGGBB` / `#RRGGBBAA`. */
export function isBoardColor(v: unknown): v is BoardColor {
  return typeof v === 'string' && ((BOARD_PALETTE as readonly string[]).includes(v) || HEX_COLOR_PATTERN.test(v));
}

// ---- primitive checks -------------------------------------------------------------

type Check = (value: unknown, path: string, issues: Issues) => void;

function checkString(value: unknown, path: string, issues: Issues, min: number, max: number): boolean {
  if (typeof value !== 'string') {
    pushIssue(issues, path, 'invalid-type', 'Expected a string.');
    return false;
  }
  if (value.length < min) {
    pushIssue(issues, path, min === 1 ? 'required' : 'out-of-range', `Expected at least ${min} characters.`);
    return false;
  }
  if (value.length > max) {
    pushIssue(issues, path, 'too-long', `Expected at most ${max} characters.`);
    return false;
  }
  return true;
}

function checkNumber(value: unknown, path: string, issues: Issues, min: number, max: number, integer = false): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected a finite number.');
    return false;
  }
  if (integer && !Number.isInteger(value)) {
    pushIssue(issues, path, 'invalid-value', 'Expected an integer.');
    return false;
  }
  if (value < min || value > max) {
    pushIssue(issues, path, 'out-of-range', `Expected a value in ${min}..${max}.`);
    return false;
  }
  return true;
}

function checkEnum(value: unknown, path: string, issues: Issues, values: readonly unknown[]): boolean {
  if (!values.includes(value)) {
    pushIssue(issues, path, 'invalid-value', `Expected one of ${values.map((entry) => JSON.stringify(entry)).join(', ')}.`);
    return false;
  }
  return true;
}

const str = (max: number, min = 1): Check => (value, path, issues) => { checkString(value, path, issues, min, max); };
const num = (min: number, max: number, integer = false): Check =>
  (value, path, issues) => { checkNumber(value, path, issues, min, max, integer); };
const oneOf = (values: readonly unknown[]): Check => (value, path, issues) => { checkEnum(value, path, issues, values); };
const literal = (expected: unknown): Check => (value, path, issues) => {
  if (value !== expected) pushIssue(issues, path, 'invalid-value', `Expected ${JSON.stringify(expected)}.`);
};
const bool: Check = (value, path, issues) => {
  if (typeof value !== 'boolean') pushIssue(issues, path, 'invalid-type', 'Expected a boolean.');
};
const boardId: Check = (value, path, issues) => {
  if (typeof value !== 'string' || !BOARD_ID_PATTERN.test(value)) {
    pushIssue(issues, path, 'invalid-value', 'Expected a board id ([A-Za-z0-9_-]{3,64}).');
  }
};
const safePath: Check = (value, path, issues) => {
  if (!isSafeBoardPath(value)) {
    pushIssue(issues, path, 'unsafe-path', 'Expected a project-relative POSIX path (no "..", no leading "/", ≤ 512 chars).');
  }
};
const safeUrl: Check = (value, path, issues) => {
  if (!isSafeBoardUrl(value)) pushIssue(issues, path, 'unsafe-url', 'Expected an http(s) URL of at most 2048 characters.');
};
const color: Check = (value, path, issues) => {
  if (!isBoardColor(value)) pushIssue(issues, path, 'invalid-color', 'Expected a palette colour or #RRGGBB[AA].');
};
const colorOrNone: Check = (value, path, issues) => {
  if (value !== 'none' && !isBoardColor(value)) {
    pushIssue(issues, path, 'invalid-color', "Expected 'none', a palette colour or #RRGGBB[AA].");
  }
};
const timestamp = num(0, Number.MAX_SAFE_INTEGER);
const coordinate = num(-BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);

// ---- objects ------------------------------------------------------------------------

interface ObjectField { check: Check; required?: boolean }
type ObjectFields = Record<string, ObjectField>;

function checkObject(value: unknown, path: string, issues: Issues, fields: ObjectFields): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected an object.');
    return false;
  }
  for (const [key, field] of Object.entries(fields)) {
    const entry = value[key];
    if (entry === undefined) {
      if (field.required) pushIssue(issues, childPath(path, key), 'required', `${key} is required.`);
      continue;
    }
    field.check(entry, childPath(path, key), issues);
  }
  return true;
}

function pickFields(value: Record<string, unknown>, fields: ObjectFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (value[key] !== undefined) out[key] = cloneJson(value[key]);
  }
  return out;
}

interface Composite { check: Check; build: (value: unknown) => unknown }

function objectComposite(fields: ObjectFields): Composite {
  return {
    check: (value, path, issues) => { checkObject(value, path, issues, fields); },
    build: (value) => pickFields(value as Record<string, unknown>, fields),
  };
}

function arrayComposite(item: Composite, max: number): Composite {
  return {
    check: (value, path, issues) => {
      if (!Array.isArray(value)) {
        pushIssue(issues, path, 'invalid-type', 'Expected an array.');
        return;
      }
      if (value.length > max) pushIssue(issues, path, 'too-long', `Expected at most ${max} entries.`);
      value.forEach((entry, index) => item.check(entry, childPath(path, index), issues));
    },
    build: (value) => (value as unknown[]).map((entry) => item.build(entry)),
  };
}

const ACTOR_KINDS: readonly BoardActorKind[] = ['user', 'agent', 'cli', 'sync', 'daemon'];
const ACTOR_FIELDS: ObjectFields = {
  kind: { check: oneOf(ACTOR_KINDS), required: true },
  clientId: { check: str(64) },
  runId: { check: str(128) },
};
export const actorComposite = objectComposite(ACTOR_FIELDS);

export function isValidActor(value: unknown): value is BoardActor {
  const issues: Issues = [];
  actorComposite.check(value, '', issues);
  return issues.length === 0;
}

export function buildActor(value: unknown): BoardActor {
  return actorComposite.build(value) as unknown as BoardActor;
}

const FILE_REF_FIELDS: ObjectFields = {
  path: { check: safePath, required: true },
  workspaceArtifactId: { check: str(200) },
};
export const fileRefComposite = objectComposite(FILE_REF_FIELDS);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const sha256: Check = (value, path, issues) => {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    pushIssue(issues, path, 'invalid-value', 'Expected a lowercase sha256 hex digest.');
  }
};
const BOARD_COVER_FIELDS: ObjectFields = {
  source: { check: literal('board-cover'), required: true },
  digest: { check: sha256, required: true },
  mime: { check: oneOf(['image/webp', 'image/png', 'image/jpeg']), required: true },
  width: { check: num(1, BOARD_LIMITS.maxCoverDimension, true), required: true },
  height: { check: num(1, BOARD_LIMITS.maxCoverDimension, true), required: true },
  capturedAt: { check: timestamp, required: true },
  sourceMtime: { check: timestamp },
};
const SNAPSHOT_COVER_FIELDS: ObjectFields = {
  source: { check: literal('chat-artifact-snapshot'), required: true },
  snapshotId: { check: str(200), required: true },
  sourceMtime: { check: timestamp },
};
const coverComposite: Composite = {
  check: (value, path, issues) => {
    if (!isPlainObject(value)) {
      pushIssue(issues, path, 'invalid-type', 'Expected an object.');
      return;
    }
    if (value.source === 'board-cover') checkObject(value, path, issues, BOARD_COVER_FIELDS);
    else if (value.source === 'chat-artifact-snapshot') checkObject(value, path, issues, SNAPSHOT_COVER_FIELDS);
    else pushIssue(issues, childPath(path, 'source'), 'invalid-value', "Expected 'board-cover' or 'chat-artifact-snapshot'.");
  },
  build: (value) => {
    const record = value as Record<string, unknown>;
    return pickFields(record, record.source === 'board-cover' ? BOARD_COVER_FIELDS : SNAPSHOT_COVER_FIELDS);
  },
};

const PENDING_ERROR_FIELDS: ObjectFields = {
  message: { check: str(4000, 0), required: true },
  nextStep: { check: oneOf(MEDIA_FAILURE_NEXT_STEPS) },
};
const pendingErrorComposite = objectComposite(PENDING_ERROR_FIELDS);
const PENDING_FIELDS: ObjectFields = {
  mediaTaskId: { check: str(200), required: true },
  status: { check: oneOf(['queued', 'running', 'failed', 'interrupted']), required: true },
  progress: { check: str(200, 0) },
  error: { check: pendingErrorComposite.check },
};
const pendingComposite: Composite = {
  check: objectComposite(PENDING_FIELDS).check,
  build: (value) => {
    const out = pickFields(value as Record<string, unknown>, PENDING_FIELDS);
    if (out.error !== undefined) out.error = pendingErrorComposite.build(out.error);
    return out;
  },
};

const ORIGIN_FIELDS: ObjectFields = {
  source: { check: oneOf(['user', 'chat-turn', 'media-task', 'generator', 'seed', 'cli', 'migration']), required: true },
  conversationId: { check: str(200) },
  messageId: { check: str(200) },
  runId: { check: str(200) },
  mediaTaskId: { check: str(200) },
  batchId: { check: str(200) },
  batchIndex: { check: num(0, 1_000_000, true) },
  generatorNodeId: { check: boardId },
};
const originComposite = objectComposite(ORIGIN_FIELDS);

const PROVENANCE_FIELDS: ObjectFields = {
  source: { check: literal('material'), required: true },
  materialId: { check: str(200), required: true },
  license: { check: str(200), required: true },
  receiptPath: { check: safePath },
  sourceUrl: { check: safeUrl },
};
const provenanceComposite = objectComposite(PROVENANCE_FIELDS);

const missingComposite = objectComposite({ since: { check: timestamp, required: true } });

const TEXT_STYLE_FIELDS: ObjectFields = {
  fontSize: { check: num(8, 512), required: true },
  fontWeight: { check: oneOf([400, 500, 600, 700]), required: true },
  align: { check: oneOf(['left', 'center', 'right']), required: true },
  color: { check: color, required: true },
};
const textStyleComposite = objectComposite(TEXT_STYLE_FIELDS);

/** `MediaAspect` (packages/contracts/src/api/projects.ts) = 05 `MEDIA_ASPECT_VALUES`. */
const MEDIA_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const GENERATOR_PARAMS_FIELDS: ObjectFields = {
  aspect: { check: oneOf(MEDIA_ASPECTS), required: true },
  count: { check: num(1, BOARD_LIMITS.maxGeneratorCount, true), required: true },
  length: { check: num(0.1, 3600) },
  quality: { check: str(64) },
  resolution: { check: str(64) },
};
const generatorParamsComposite = objectComposite(GENERATOR_PARAMS_FIELDS);

const RUN_SUMMARY_FIELDS: ObjectFields = {
  runId: { check: str(200), required: true },
  outputNodeId: { check: boardId, required: true },
  surface: { check: oneOf(BOARD_GENERATOR_SURFACES), required: true },
  model: { check: str(200), required: true },
  count: { check: num(1, BOARD_LIMITS.maxGeneratorCount, true), required: true },
  startedAt: { check: timestamp, required: true },
};
const runSummariesComposite = arrayComposite(objectComposite(RUN_SUMMARY_FIELDS), BOARD_LIMITS.maxGeneratorRuns);

/** 05 `GENERATION_LIMITS.maxCandidatesPerNode` (plan R3b: `generation.candidates.length ≤ 16`). */
export const BOARD_MAX_GENERATION_CANDIDATES = 16;
/** 05's `MediaNodeGeneration` is opaque to the board beyond these bounds; it is stored as given. */
const generationComposite: Composite = {
  check: (value, path, issues) => {
    if (!isPlainObject(value)) {
      pushIssue(issues, path, 'invalid-type', 'Expected an object.');
      return;
    }
    const candidates = value.candidates;
    const candidatesPath = childPath(path, 'candidates');
    if (!Array.isArray(candidates)) {
      pushIssue(issues, candidatesPath, candidates === undefined ? 'required' : 'invalid-type', 'Expected an array of candidates.');
    } else {
      if (candidates.length > BOARD_MAX_GENERATION_CANDIDATES) {
        pushIssue(issues, candidatesPath, 'too-long', `Expected at most ${BOARD_MAX_GENERATION_CANDIDATES} candidates.`);
      }
      candidates.forEach((candidate, index) => {
        const candidatePath = childPath(candidatesPath, index);
        if (!isPlainObject(candidate)) pushIssue(issues, candidatePath, 'invalid-type', 'Expected an object.');
        else checkString(candidate.id, childPath(candidatePath, 'id'), issues, 1, 200);
      });
    }
    if (!isPlainObject(value.request)) {
      pushIssue(issues, childPath(path, 'request'), value.request === undefined ? 'required' : 'invalid-type', 'Expected the generation request record.');
    }
    if (value.primaryCandidateId !== undefined) checkString(value.primaryCandidateId, childPath(path, 'primaryCandidateId'), issues, 1, 200);
    if (value.sizedToMedia !== undefined) bool(value.sizedToMedia, childPath(path, 'sizedToMedia'), issues);
  },
  build: (value) => cloneJson(value),
};

const refProxyComposite = objectComposite({
  path: { check: safePath, required: true },
  sourceKey: { check: str(512), required: true },
});

const DESIGN_CANVAS_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const migratedFromComposite = objectComposite({
  store: { check: literal('design-canvas'), required: true },
  documentId: {
    check: (value, path, issues) => {
      if (typeof value !== 'string' || !DESIGN_CANVAS_DOCUMENT_ID.test(value)) {
        pushIssue(issues, path, 'invalid-value', 'Expected a design-canvas document id.');
      }
    },
    required: true,
  },
  sha256: { check: sha256, required: true },
});

const MOVIE_SOURCE_FIELDS: ObjectFields = {
  type: { check: literal('movie'), required: true },
  projectId: { check: str(200), required: true },
};
const COMPOSITION_SOURCE_FIELDS: ObjectFields = {
  type: { check: literal('composition'), required: true },
  ref: { check: fileRefComposite.check, required: true },
};
const motionSourceComposite: Composite = {
  check: (value, path, issues) => {
    if (!isPlainObject(value)) {
      pushIssue(issues, path, 'invalid-type', 'Expected an object.');
      return;
    }
    if (value.type === 'movie') checkObject(value, path, issues, MOVIE_SOURCE_FIELDS);
    else if (value.type === 'composition') checkObject(value, path, issues, COMPOSITION_SOURCE_FIELDS);
    else pushIssue(issues, childPath(path, 'type'), 'invalid-value', "Expected 'movie' or 'composition'.");
  },
  build: (value) => {
    const record = value as Record<string, unknown>;
    if (record.type === 'movie') return pickFields(record, MOVIE_SOURCE_FIELDS);
    return { type: 'composition', ref: fileRefComposite.build(record.ref) };
  },
};

// ---- node field specs -------------------------------------------------------------

export interface FieldSpec {
  check: Check;
  build?: (value: unknown) => unknown;
  /** Required in a stored node. */
  required?: boolean;
  /** 'clear': `null` in a patch deletes the key. 'value': `null` is a legal stored value (ref, generator model). */
  nullable?: 'clear' | 'value';
  /** false: never accepted in `update` patches. */
  patch?: boolean;
  /** Stamped by the op engine / daemon (rev, timestamps, actors, missing). */
  server?: boolean;
}

const sizeSpec = (kind: BoardNodeKind): FieldSpec => ({
  check: num(BOARD_LIMITS.minNodeSize, kind === 'group' ? BOARD_LIMITS.maxGroupSize : BOARD_LIMITS.maxNodeSize),
  required: true,
});

function commonFields(kind: BoardNodeKind): Record<string, FieldSpec> {
  return {
    id: { check: boardId, required: true, patch: false },
    kind: { check: oneOf(BOARD_NODE_KINDS), required: true, patch: false },
    x: { check: coordinate, required: true },
    y: { check: coordinate, required: true },
    w: sizeSpec(kind),
    h: sizeSpec(kind),
    title: { check: str(BOARD_LIMITS.maxTitleLength, 0), nullable: 'clear' },
    parentId: { check: boardId, nullable: 'clear' },
    page: { check: boardId, nullable: 'clear' },
    variantLabel: { check: str(BOARD_LIMITS.maxVariantLabelLength), nullable: 'clear' },
    locked: { check: bool },
    hidden: { check: bool },
    autoSize: { check: bool },
    origin: { check: originComposite.check, build: originComposite.build, patch: false },
    provenance: { check: provenanceComposite.check, build: provenanceComposite.build, nullable: 'clear' },
    missing: { check: missingComposite.check, build: missingComposite.build, nullable: 'clear', server: true },
    createdAt: { check: timestamp, required: true, patch: false, server: true },
    updatedAt: { check: timestamp, required: true, patch: false, server: true },
    createdBy: { check: actorComposite.check, build: actorComposite.build, required: true, patch: false, server: true },
    updatedBy: { check: actorComposite.check, build: actorComposite.build, required: true, patch: false, server: true },
    rev: { check: num(0, Number.MAX_SAFE_INTEGER, true), required: true, patch: false, server: true },
  };
}

const DEVICES = ['desktop', 'tablet', 'mobile', 'custom'] as const;
const fromComposite = (source: Composite, extra: Partial<FieldSpec> = {}): FieldSpec =>
  ({ check: source.check, build: source.build, ...extra });
const mediaDimension: FieldSpec = { check: num(0, 100_000), nullable: 'clear' };
const durationMs: FieldSpec = { check: num(0, 86_400_000), nullable: 'clear' };
const nullableRef: FieldSpec = fromComposite(fileRefComposite, { required: true, nullable: 'value' });

const KIND_FIELDS: Record<BoardNodeKind, Record<string, FieldSpec>> = {
  frame: {
    ref: nullableRef,
    liveArtifactId: { check: str(200), nullable: 'clear' },
    device: { check: oneOf(DEVICES) },
    scrollY: { check: num(0, BOARD_LIMITS.maxCoordinate), nullable: 'clear' },
    cover: fromComposite(coverComposite, { nullable: 'clear' }),
  },
  web: {
    url: { check: safeUrl, required: true },
    browserTabId: { check: str(200), nullable: 'clear' },
    device: { check: oneOf(DEVICES) },
    cover: fromComposite(coverComposite, { nullable: 'clear' }),
  },
  image: {
    ref: nullableRef,
    pending: fromComposite(pendingComposite, { nullable: 'clear' }),
    naturalWidth: mediaDimension,
    naturalHeight: mediaDimension,
    generation: fromComposite(generationComposite, { nullable: 'clear' }),
    refProxy: fromComposite(refProxyComposite, { nullable: 'clear' }),
  },
  video: {
    ref: nullableRef,
    pending: fromComposite(pendingComposite, { nullable: 'clear' }),
    naturalWidth: mediaDimension,
    naturalHeight: mediaDimension,
    durationMs,
    posterTimeMs: durationMs,
    loop: { check: bool },
    muted: { check: bool },
    cover: fromComposite(coverComposite, { nullable: 'clear' }),
    generation: fromComposite(generationComposite, { nullable: 'clear' }),
    refProxy: fromComposite(refProxyComposite, { nullable: 'clear' }),
  },
  audio: {
    ref: nullableRef,
    pending: fromComposite(pendingComposite, { nullable: 'clear' }),
    durationMs,
  },
  note: {
    text: { check: str(BOARD_LIMITS.maxNoteTextLength, 0), required: true },
    color: { check: oneOf(BOARD_PALETTE) },
    size: { check: oneOf(['sm', 'md', 'lg']), nullable: 'clear' },
  },
  shape: {
    shape: { check: oneOf(['rect', 'ellipse', 'text', 'freehand']), required: true },
    points: {
      check(value, path, issues) {
        if (checkString(value, path, issues, 3, 40960) && !/^(?:1000|\d{1,3}),(?:1000|\d{1,3})(?: (?:1000|\d{1,3}),(?:1000|\d{1,3}))*$/.test(value as string)) {
          pushIssue(issues, path, 'invalid-value', 'Expected a list of polyline points.');
        }
      },
      nullable: 'clear',
    },
    fill: { check: colorOrNone, nullable: 'clear' },
    stroke: { check: colorOrNone, nullable: 'clear' },
    strokeWidth: { check: num(0, 32), nullable: 'clear' },
    radius: { check: num(0, 1000), nullable: 'clear' },
    text: { check: str(BOARD_LIMITS.maxShapeTextLength, 0) },
    textStyle: fromComposite(textStyleComposite, { nullable: 'clear' }),
  },
  group: {
    role: { check: oneOf(['section', 'turn', 'variants']), required: true },
    layout: { check: oneOf(['free', 'row', 'grid']) },
    sectionKind: { check: oneOf(['frame', 'design', 'motion', 'image', 'video', 'audio']), nullable: 'clear' },
    variantKey: { check: str(BOARD_LIMITS.maxPathLength + 64), nullable: 'clear' },
    baseNodeId: { check: boardId, nullable: 'clear' },
    promotedNodeId: { check: boardId, nullable: 'clear' },
    color: { check: oneOf(BOARD_PALETTE) },
    collapsed: { check: bool },
  },
  generator: {
    version: { check: literal(1), required: true, patch: false },
    surface: { check: oneOf(BOARD_GENERATOR_SURFACES), required: true },
    prompt: { check: str(BOARD_LIMITS.maxPromptLength, 0), required: true },
    model: { check: str(200), required: true, nullable: 'value' },
    params: fromComposite(generatorParamsComposite, { required: true }),
    templateId: { check: str(200), nullable: 'clear' },
    runs: fromComposite(runSummariesComposite, { required: true }),
  },
  design: {
    ref: fromComposite(fileRefComposite, { required: true }),
    format: { check: oneOf(['fig', 'op']), required: true },
    pageId: { check: str(200), nullable: 'clear' },
    cover: fromComposite(coverComposite, { nullable: 'clear' }),
    migratedFrom: fromComposite(migratedFromComposite, { patch: false }),
  },
  motion: {
    source: fromComposite(motionSourceComposite, { required: true }),
    render: fromComposite(fileRefComposite, { nullable: 'clear' }),
    aspect: { check: oneOf(['16:9', '9:16', '1:1']), nullable: 'clear' },
    cover: fromComposite(coverComposite, { nullable: 'clear' }),
  },
};

const SPEC_CACHE = new Map<BoardNodeKind, Record<string, FieldSpec>>();

export function nodeFieldSpecs(kind: BoardNodeKind): Record<string, FieldSpec> {
  let specs = SPEC_CACHE.get(kind);
  if (!specs) {
    specs = { ...commonFields(kind), ...KIND_FIELDS[kind] };
    SPEC_CACHE.set(kind, specs);
  }
  return specs;
}

/** Orders a node record's keys like the schema (id, kind, x, y, w, h, …, stamps) so stored JSON stays uniform. */
export function orderNodeKeys(kind: BoardNodeKind, record: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(nodeFieldSpecs(kind))) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  return ordered;
}

export function isBoardNodeKind(value: unknown): value is BoardNodeKind {
  return (BOARD_NODE_KINDS as readonly unknown[]).includes(value);
}

/** Patchable keys per kind (server-managed keys and `migratedFrom` excluded). */
export function patchKeysForKind(kind: BoardNodeKind): string[] {
  return Object.entries(nodeFieldSpecs(kind))
    .filter(([, spec]) => spec.patch !== false && !spec.server)
    .map(([key]) => key);
}

/** Every key of `BoardNodePatch` (any kind), including the actor-gated `missing`. */
export const BOARD_PATCH_KEY_SET: ReadonlySet<string> = new Set([
  ...BOARD_NODE_KINDS.flatMap((kind) => patchKeysForKind(kind)),
  'missing',
]);

/** Optional in drafts: the op engine assigns id, position and size. */
const DRAFT_OPTIONAL_KEYS: ReadonlySet<string> = new Set(['id', 'x', 'y', 'w', 'h']);

function inferDesignFormat(raw: Record<string, unknown>): 'fig' | 'op' | null {
  const ref = raw.ref;
  if (!isPlainObject(ref) || typeof ref.path !== 'string') return null;
  const lower = ref.path.toLowerCase();
  if (lower.endsWith('.fig')) return 'fig';
  if (lower.endsWith('.op')) return 'op';
  return null;
}

/** Values filled into drafts / normalized nodes when the key is absent. */
function draftDefault(kind: BoardNodeKind, key: string, raw: Record<string, unknown>): { value: unknown } | null {
  if (key === 'ref' && (kind === 'frame' || kind === 'image' || kind === 'video' || kind === 'audio')) return { value: null };
  if (kind === 'note' && key === 'text') return { value: '' };
  if (kind === 'generator') {
    if (key === 'version') return { value: 1 };
    if (key === 'prompt') return { value: '' };
    if (key === 'model') return { value: null };
    if (key === 'runs') return { value: [] };
  }
  if (kind === 'design' && key === 'format') {
    const format = inferDesignFormat(raw);
    return format ? { value: format } : null;
  }
  return null;
}

/**
 * 'full': a stored node (restore snapshots); unknown keys are rejected. 'draft': an `add` draft; server-managed keys
 * are ignored, id/x/y/w/h and keys with defaults may be absent, unknown keys are rejected. 'normalize': a PUT node;
 * unknown keys and invalid server stamps are dropped, defaults are filled.
 */
export type NodeRecordMode = 'full' | 'draft' | 'normalize';

export function validateNodeRecord(raw: unknown, path: string, mode: NodeRecordMode, issues: Issues): raw is Record<string, unknown> & { kind: BoardNodeKind } {
  if (!isPlainObject(raw)) {
    pushIssue(issues, path, 'invalid-type', 'Expected a node object.');
    return false;
  }
  if (!isBoardNodeKind(raw.kind)) {
    pushIssue(issues, childPath(path, 'kind'), raw.kind === undefined ? 'required' : 'invalid-value', `Expected one of ${BOARD_NODE_KINDS.join(', ')}.`);
    return false;
  }
  const kind = raw.kind;
  const specs = nodeFieldSpecs(kind);
  const before = issues.length;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const spec = specs[key];
    const keyPath = childPath(path, key);
    if (!spec) {
      if (mode !== 'normalize') pushIssue(issues, keyPath, 'field-not-allowed', `${key} is not a field of ${kind} nodes.`);
      continue;
    }
    if (spec.server && mode !== 'full') continue;
    if (value === null) {
      if (spec.nullable === 'value') continue;
      if (mode === 'full') pushIssue(issues, keyPath, 'invalid-type', `${key} cannot be null.`);
      continue;
    }
    spec.check(value, keyPath, issues);
  }
  for (const [key, spec] of Object.entries(specs)) {
    if (!spec.required) continue;
    const value = raw[key];
    // In 'full' mode a disallowed null was already reported above; elsewhere null counts as absent.
    if (value !== undefined && (value !== null || spec.nullable === 'value' || mode === 'full')) continue;
    if (mode !== 'full') {
      if (spec.server) continue;
      if (mode === 'draft' && DRAFT_OPTIONAL_KEYS.has(key)) continue;
      if (draftDefault(kind, key, raw)) continue;
    }
    pushIssue(issues, childPath(path, key), 'required', `${key} is required for ${kind} nodes.`);
  }
  if (kind === 'shape' && raw.shape === 'freehand' && raw.points == null) {
    pushIssue(issues, childPath(path, 'points'), 'required', 'A freehand stroke needs polyline points.');
  }
  return issues.length === before;
}

/**
 * Fresh node record with only schema keys (nested objects rebuilt or deep-copied). Server-managed keys are copied
 * only with `keepServer`; non-'full' modes fill draft defaults. Call after `validateNodeRecord` succeeded.
 */
export function buildNodeRecord(raw: Record<string, unknown> & { kind: BoardNodeKind }, mode: NodeRecordMode, keepServer: boolean): Record<string, unknown> {
  const kind = raw.kind;
  const specs = nodeFieldSpecs(kind);
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = raw[key];
    if (spec.server && !keepServer) continue;
    if (value === undefined || (value === null && spec.nullable !== 'value')) {
      if (mode !== 'full') {
        const fallback = draftDefault(kind, key, raw);
        if (fallback) out[key] = cloneJson(fallback.value);
      }
      continue;
    }
    out[key] = value === null ? null : spec.build ? spec.build(value) : cloneJson(value);
  }
  return out;
}

/** Fills the add/normalize defaults of spec 04 §4.4.3: frame device, note colour, group layout. */
export function applyNodeDefaults(node: Record<string, unknown>): void {
  if (node.kind === 'frame' && node.device === undefined) node.device = 'desktop';
  if (node.kind === 'note' && node.color === undefined) node.color = 'yellow';
  if (node.kind === 'group' && node.layout === undefined) node.layout = 'free';
}

/** Value checks of an `update` patch against the node's kind. `missing` is accepted only from sync/daemon actors. */
export function validatePatchForKind(
  patch: Record<string, unknown>,
  kind: BoardNodeKind,
  actorKind: BoardActorKind,
  path: string,
  issues: Issues,
): void {
  const specs = nodeFieldSpecs(kind);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const keyPath = childPath(path, key);
    const spec = specs[key];
    if (key === 'missing' && spec) {
      if (actorKind !== 'sync' && actorKind !== 'daemon') {
        pushIssue(issues, keyPath, 'forbidden-field', 'missing is server-managed (sync/daemon actors only).');
        continue;
      }
    } else if (!spec || spec.patch === false || spec.server) {
      pushIssue(issues, keyPath, 'field-not-allowed', `${key} cannot be patched on ${kind} nodes.`);
      continue;
    }
    if (value === null) {
      if (!spec.nullable) pushIssue(issues, keyPath, 'invalid-type', `${key} cannot be null.`);
      continue;
    }
    spec.check(value, keyPath, issues);
  }
}

/** Builds a patch value for storage (nested objects rebuilt / deep-copied). */
export function buildPatchValue(kind: BoardNodeKind, key: string, value: unknown): unknown {
  const spec = nodeFieldSpecs(kind)[key];
  if (value === null || !spec) return value;
  return spec.build ? spec.build(value) : cloneJson(value);
}

export function nullableModeOf(kind: BoardNodeKind, key: string): 'clear' | 'value' | undefined {
  return nodeFieldSpecs(kind)[key]?.nullable;
}

// ---- edges ---------------------------------------------------------------------------

const EDGE_FIELDS: Record<string, FieldSpec> = {
  id: { check: boardId, required: true },
  kind: { check: oneOf(BOARD_EDGE_KINDS), required: true },
  from: { check: boardId, required: true },
  to: { check: boardId, required: true },
  label: { check: str(BOARD_LIMITS.maxTitleLength, 0) },
  createdAt: { check: timestamp, required: true, server: true },
  createdBy: { check: actorComposite.check, build: actorComposite.build, required: true, server: true },
  updatedBy: { check: actorComposite.check, build: actorComposite.build, required: true, server: true },
  rev: { check: num(0, Number.MAX_SAFE_INTEGER, true), required: true, server: true },
};

export function validateEdgeRecord(raw: unknown, path: string, mode: NodeRecordMode, issues: Issues): raw is Record<string, unknown> {
  if (!isPlainObject(raw)) {
    pushIssue(issues, path, 'invalid-type', 'Expected an edge object.');
    return false;
  }
  const before = issues.length;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const spec = EDGE_FIELDS[key];
    const keyPath = childPath(path, key);
    if (!spec) {
      if (mode !== 'normalize') pushIssue(issues, keyPath, 'field-not-allowed', `${key} is not an edge field.`);
      continue;
    }
    if (spec.server && mode !== 'full') continue;
    spec.check(value, keyPath, issues);
  }
  for (const [key, spec] of Object.entries(EDGE_FIELDS)) {
    if (!spec.required || raw[key] !== undefined) continue;
    if (mode !== 'full' && spec.server) continue;
    if (mode === 'draft' && key === 'id') continue;
    pushIssue(issues, childPath(path, key), 'required', `${key} is required for edges.`);
  }
  return issues.length === before;
}

export function buildEdgeRecord(raw: Record<string, unknown>, keepServer: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(EDGE_FIELDS)) {
    const value = raw[key];
    if (value === undefined || (spec.server && !keepServer)) continue;
    out[key] = spec.build ? spec.build(value) : cloneJson(value);
  }
  return out;
}

// ---- placements and small shapes -----------------------------------------------------

export function checkPlacement(value: unknown, path: string, issues: Issues): void {
  if (!isPlainObject(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected a placement object.');
    return;
  }
  switch (value.mode) {
    case 'auto':
      return;
    case 'near':
      checkObject(value, path, issues, {
        nodeId: { check: boardId, required: true },
        side: { check: oneOf(['right', 'below']) },
      });
      return;
    case 'at':
      checkObject(value, path, issues, { x: { check: coordinate, required: true }, y: { check: coordinate, required: true } });
      return;
    case 'viewport':
      checkObject(value, path, issues, {
        centerX: { check: coordinate, required: true },
        centerY: { check: coordinate, required: true },
      });
      return;
    default:
      pushIssue(issues, childPath(path, 'mode'), 'invalid-value', "Expected 'auto', 'near', 'at' or 'viewport'.");
  }
}

export function checkBoardIdField(value: unknown, path: string, issues: Issues): boolean {
  const before = issues.length;
  boardId(value, path, issues);
  return issues.length === before;
}

export function checkIdArray(value: unknown, path: string, issues: Issues, min: number, max: number): value is string[] {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected an array of ids.');
    return false;
  }
  if (value.length < min || value.length > max) {
    pushIssue(issues, path, 'out-of-range', `Expected ${min}..${max} ids.`);
  }
  const before = issues.length;
  value.forEach((entry, index) => boardId(entry, childPath(path, index), issues));
  return issues.length === before && value.length >= min && value.length <= max;
}

export function checkRevRecord(value: unknown, path: string, issues: Issues): void {
  if (!isPlainObject(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected an object of id → rev.');
    return;
  }
  for (const [key, rev] of Object.entries(value)) {
    checkNumber(rev, childPath(path, key), issues, 0, Number.MAX_SAFE_INTEGER, true);
  }
}

export function checkRev(value: unknown, path: string, issues: Issues): void {
  checkNumber(value, path, issues, 0, Number.MAX_SAFE_INTEGER, true);
}

export function checkNumberField(value: unknown, path: string, issues: Issues, min: number, max: number, integer = false): boolean {
  return checkNumber(value, path, issues, min, max, integer);
}

export function checkStringField(value: unknown, path: string, issues: Issues, min: number, max: number): boolean {
  return checkString(value, path, issues, min, max);
}

export function checkEnumField(value: unknown, path: string, issues: Issues, values: readonly unknown[]): boolean {
  return checkEnum(value, path, issues, values);
}

export function checkActorField(value: unknown, path: string, issues: Issues): void {
  actorComposite.check(value, path, issues);
}

export const BOARD_BACKGROUNDS = ['dots', 'lines', 'blank'] as const;

export function checkSettingsPatch(value: unknown, path: string, issues: Issues): void {
  if (!isPlainObject(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected a settings object.');
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const keyPath = childPath(path, key);
    if (key === 'background') checkEnum(entry, keyPath, issues, BOARD_BACKGROUNDS);
    else if (key === 'autoPlace') bool(entry, keyPath, issues);
    else pushIssue(issues, keyPath, 'field-not-allowed', `${key} is not a board setting.`);
  }
}
