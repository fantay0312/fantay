// SPDX-License-Identifier: Apache-2.0
/**
 * Media operations over project files (amendment C7, dual track): the daemon route
 * `POST /api/projects/:id/media/ops` (ffmpeg, implemented in W3-media-ops) and `od board media <op> --json`
 * use these shapes. The web keeps its client-side canvas operations (spec 05 §6.6); this route serves
 * agents and the CLI.
 *
 * - `crop`  `{ x, y, width, height }` in source pixels — image or video input.
 * - `split` `{ rows, cols }`, 1..8 each — image input; pieces are written as `<outputPrefix>-r<row>c<col>.png`
 *           by the daemon (naming owned by the route).
 * - `scale` `{ factor: 2|3|4 }` or `{ width?, height? }` (exactly one of the two forms) — image or video input.
 * - `frame` `{ timeSec }` — video input → one PNG.
 *
 * Paths are project-relative POSIX paths (`ProjectFile.name`). Pure TypeScript: no Node or DOM APIs.
 */
import type { ApiValidationIssue } from '../errors.js';

export type MediaOpKind = 'crop' | 'split' | 'scale' | 'frame';
export const MEDIA_OP_KINDS = ['crop', 'split', 'scale', 'frame'] as const satisfies readonly MediaOpKind[];

export const MEDIA_OP_LIMITS = {
  /** split: rows and cols are 1..8 each (max 8×8 pieces). */
  maxSplitRows: 8,
  maxSplitCols: 8,
  /** scale: largest `factor`. */
  maxScaleFactor: 4,
  /** Largest output edge in pixels (crop width/height, scale width/height; the daemon also checks factor results). */
  maxOutputEdge: 8192,
  /** Longest accepted project path (matches the board contract's path limit). */
  maxPathLength: 512,
} as const;

export const MEDIA_OP_SCALE_FACTORS = [2, 3, 4] as const;
export type MediaOpScaleFactor = (typeof MEDIA_OP_SCALE_FACTORS)[number];

/** Input extensions the route accepts per media class (lowercase, without the dot). */
export const MEDIA_OP_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const;
export const MEDIA_OP_VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v', 'mkv'] as const;
/** Output extensions accepted in `output` per media class (`frame` always writes PNG). */
export const MEDIA_OP_IMAGE_OUTPUT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const MEDIA_OP_VIDEO_OUTPUT_EXTENSIONS = ['mp4', 'mov', 'webm'] as const;

export type MediaOpInputClass = 'image' | 'video';

export interface MediaCropParams {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MediaSplitParams {
  rows: number;
  cols: number;
}
/** Exactly one form: `factor`, or `width` and/or `height` (one edge keeps the aspect ratio). */
export interface MediaScaleParams {
  factor?: MediaOpScaleFactor;
  width?: number;
  height?: number;
}
export interface MediaFrameParams {
  timeSec: number;
}

export interface MediaCropRequest {
  op: 'crop';
  /** Project-relative source path. */
  input: string;
  params: MediaCropParams;
  /** Project-relative output path; the daemon picks a name when absent. */
  output?: string;
}
export interface MediaSplitRequest {
  op: 'split';
  input: string;
  params: MediaSplitParams;
  /** Project-relative path stem for the pieces; the daemon picks one when absent. */
  outputPrefix?: string;
}
export interface MediaScaleRequest {
  op: 'scale';
  input: string;
  params: MediaScaleParams;
  output?: string;
}
export interface MediaFrameRequest {
  op: 'frame';
  input: string;
  params: MediaFrameParams;
  /** Must end in `.png` when given. */
  output?: string;
}
export type MediaOpRequest = MediaCropRequest | MediaSplitRequest | MediaScaleRequest | MediaFrameRequest;

export interface MediaOpOutputFile {
  /** Project-relative path of the written file. */
  path: string;
  mime: string;
  width?: number;
  height?: number;
  bytes: number;
}
export interface MediaOpResponse {
  op: MediaOpKind;
  input: string;
  files: MediaOpOutputFile[];
}

/** `code` values used in {@link ApiValidationIssue}s from {@link validateMediaOpRequest}. */
export type MediaOpIssueCode =
  | 'required'
  | 'invalid_type'
  | 'invalid_value'
  | 'out_of_range'
  | 'unknown_key'
  | 'unsupported_input'
  | 'conflict';

export type MediaOpValidationResult =
  | { ok: true; value: MediaOpRequest }
  | { ok: false; issues: ApiValidationIssue[] };

/** Media class of a path by extension, or null when the extension is not an accepted input. */
export function mediaOpInputClass(path: string): MediaOpInputClass | null {
  const ext = extensionOf(path);
  if ((MEDIA_OP_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  if ((MEDIA_OP_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
  return null;
}

/**
 * Validates and normalizes a media op request (paths trimmed, a leading `./` removed, unknown keys
 * rejected). Returns every issue found, with dot paths such as `params.width`.
 */
export function validateMediaOpRequest(value: unknown): MediaOpValidationResult {
  const issues: ApiValidationIssue[] = [];
  const issue = (path: string, code: MediaOpIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(value)) {
    issue('', 'invalid_type', 'request body must be a JSON object');
    return { ok: false, issues };
  }
  const op = value.op;
  if (op === undefined) {
    issue('op', 'required', `op is required (${MEDIA_OP_KINDS.join(', ')})`);
    return { ok: false, issues };
  }
  if (typeof op !== 'string' || !(MEDIA_OP_KINDS as readonly string[]).includes(op)) {
    issue('op', 'invalid_value', `op must be one of ${MEDIA_OP_KINDS.join(', ')}`);
    return { ok: false, issues };
  }
  const kind = op as MediaOpKind;
  const outputKey = kind === 'split' ? 'outputPrefix' : 'output';

  for (const key of Object.keys(value)) {
    if (key !== 'op' && key !== 'input' && key !== 'params' && key !== outputKey) {
      issue(key, 'unknown_key', `unknown field "${key}" for op "${kind}"`);
    }
  }

  const input = readPath(value.input, 'input', true, issue);
  let inputClass: MediaOpInputClass | null = null;
  if (input !== undefined) {
    inputClass = mediaOpInputClass(input);
    const allowed: readonly MediaOpInputClass[] =
      kind === 'split' ? ['image'] : kind === 'frame' ? ['video'] : ['image', 'video'];
    if (!inputClass || !allowed.includes(inputClass)) {
      const exts =
        allowed.length === 2
          ? [...MEDIA_OP_IMAGE_EXTENSIONS, ...MEDIA_OP_VIDEO_EXTENSIONS]
          : allowed[0] === 'image'
            ? MEDIA_OP_IMAGE_EXTENSIONS
            : MEDIA_OP_VIDEO_EXTENSIONS;
      issue('input', 'unsupported_input', `${kind} needs ${allowed.join(' or ')} input (.${exts.join(', .')})`);
      inputClass = null;
    }
  }

  const output = readPath(value[outputKey], outputKey, false, issue);
  if (output !== undefined) {
    if (kind === 'frame' && extensionOf(output) !== 'png') {
      issue('output', 'invalid_value', 'frame output must be a .png path');
    } else if ((kind === 'crop' || kind === 'scale') && inputClass) {
      const allowedExts: readonly string[] =
        inputClass === 'image' ? MEDIA_OP_IMAGE_OUTPUT_EXTENSIONS : MEDIA_OP_VIDEO_OUTPUT_EXTENSIONS;
      if (!allowedExts.includes(extensionOf(output))) {
        issue('output', 'invalid_value', `${inputClass} output must end in .${allowedExts.join(', .')}`);
      }
    }
  }

  const params = value.params;
  let normalizedParams: MediaOpRequest['params'] | undefined;
  if (params === undefined) {
    issue('params', 'required', 'params is required');
  } else if (!isRecord(params)) {
    issue('params', 'invalid_type', 'params must be an object');
  } else {
    normalizedParams = validateParams(kind, params, issue);
  }

  if (issues.length > 0 || input === undefined || normalizedParams === undefined) return { ok: false, issues };
  const request = { op: kind, input, params: normalizedParams } as MediaOpRequest;
  if (output !== undefined) {
    if (request.op === 'split') request.outputPrefix = output;
    else request.output = output;
  }
  return { ok: true, value: request };
}

// ---------------------------------------------------------------------------
// internals

type IssueSink = (path: string, code: MediaOpIssueCode, message: string) => void;

function validateParams(
  kind: MediaOpKind,
  params: Record<string, unknown>,
  issue: IssueSink,
): MediaOpRequest['params'] | undefined {
  const allowedKeys: Record<MediaOpKind, readonly string[]> = {
    crop: ['x', 'y', 'width', 'height'],
    split: ['rows', 'cols'],
    scale: ['factor', 'width', 'height'],
    frame: ['timeSec'],
  };
  let failed = false;
  const sink: IssueSink = (path, code, message) => {
    failed = true;
    issue(path, code, message);
  };
  for (const key of Object.keys(params)) {
    if (!allowedKeys[kind].includes(key)) sink(`params.${key}`, 'unknown_key', `unknown param "${key}" for op "${kind}"`);
  }
  let result: MediaOpRequest['params'] | undefined;
  switch (kind) {
    case 'crop': {
      const x = readInteger(params.x, 'params.x', 0, Number.MAX_SAFE_INTEGER, true, sink);
      const y = readInteger(params.y, 'params.y', 0, Number.MAX_SAFE_INTEGER, true, sink);
      const width = readInteger(params.width, 'params.width', 1, MEDIA_OP_LIMITS.maxOutputEdge, true, sink);
      const height = readInteger(params.height, 'params.height', 1, MEDIA_OP_LIMITS.maxOutputEdge, true, sink);
      if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
        result = { x, y, width, height };
      }
      break;
    }
    case 'split': {
      const rows = readInteger(params.rows, 'params.rows', 1, MEDIA_OP_LIMITS.maxSplitRows, true, sink);
      const cols = readInteger(params.cols, 'params.cols', 1, MEDIA_OP_LIMITS.maxSplitCols, true, sink);
      if (rows !== undefined && cols !== undefined) result = { rows, cols };
      break;
    }
    case 'scale': {
      const hasFactor = params.factor !== undefined;
      const hasSize = params.width !== undefined || params.height !== undefined;
      if (hasFactor && hasSize) {
        sink('params', 'conflict', 'scale takes either factor or width/height, not both');
        break;
      }
      if (!hasFactor && !hasSize) {
        sink('params', 'required', 'scale needs factor (2, 3 or 4) or width/height');
        break;
      }
      if (hasFactor) {
        const factor = params.factor;
        if (typeof factor !== 'number' || !(MEDIA_OP_SCALE_FACTORS as readonly number[]).includes(factor)) {
          sink('params.factor', 'invalid_value', `factor must be one of ${MEDIA_OP_SCALE_FACTORS.join(', ')}`);
          break;
        }
        result = { factor: factor as MediaOpScaleFactor };
        break;
      }
      const width = readInteger(params.width, 'params.width', 1, MEDIA_OP_LIMITS.maxOutputEdge, false, sink);
      const height = readInteger(params.height, 'params.height', 1, MEDIA_OP_LIMITS.maxOutputEdge, false, sink);
      if (!failed) {
        const scale: MediaScaleParams = {};
        if (width !== undefined) scale.width = width;
        if (height !== undefined) scale.height = height;
        result = scale;
      }
      break;
    }
    case 'frame': {
      const timeSec = params.timeSec;
      if (timeSec === undefined) sink('params.timeSec', 'required', 'timeSec is required');
      else if (typeof timeSec !== 'number' || !Number.isFinite(timeSec)) {
        sink('params.timeSec', 'invalid_type', 'timeSec must be a finite number of seconds');
      } else if (timeSec < 0) sink('params.timeSec', 'out_of_range', 'timeSec must be ≥ 0');
      else result = { timeSec };
      break;
    }
  }
  return failed ? undefined : result;
}

function readInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
  required: boolean,
  issue: IssueSink,
): number | undefined {
  if (value === undefined) {
    if (required) issue(path, 'required', `${path.replace(/^params\./, '')} is required`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issue(path, 'invalid_type', `${path.replace(/^params\./, '')} must be an integer`);
    return undefined;
  }
  if (value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `≥ ${min}` : `${min}..${max}`;
    issue(path, 'out_of_range', `${path.replace(/^params\./, '')} must be ${range}`);
    return undefined;
  }
  return value;
}

function readPath(value: unknown, path: string, required: boolean, issue: IssueSink): string | undefined {
  if (value === undefined) {
    if (required) issue(path, 'required', `${path} is required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    issue(path, 'invalid_type', `${path} must be a string`);
    return undefined;
  }
  let normalized = value.trim();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (!normalized) {
    issue(path, 'required', `${path} must not be empty`);
    return undefined;
  }
  if (normalized.length > MEDIA_OP_LIMITS.maxPathLength) {
    issue(path, 'out_of_range', `${path} must be at most ${MEDIA_OP_LIMITS.maxPathLength} characters`);
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    issue(path, 'invalid_value', `${path} must not contain control characters`);
    return undefined;
  }
  if (normalized.includes('\\')) {
    issue(path, 'invalid_value', `${path} must use forward slashes`);
    return undefined;
  }
  if (normalized.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    issue(path, 'invalid_value', `${path} must be a project-relative path`);
    return undefined;
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    issue(path, 'invalid_value', `${path} must not contain empty, "." or ".." segments`);
    return undefined;
  }
  return normalized;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
