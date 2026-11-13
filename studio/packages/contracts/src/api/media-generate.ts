// SPDX-License-Identifier: Apache-2.0
/**
 * Typed shapes and tolerant parsers for the daemon's existing media generation
 * endpoints (no daemon change):
 *
 * - `POST /api/projects/:id/media/generate` → 202 {@link MediaGenerateAccepted}
 * - `POST /api/media/tasks/:id/wait`         → {@link MediaTaskSnapshotResponse} (404 once the task is GC'd)
 * - error bodies of both                     → {@link DaemonApiErrorInfo}
 *
 * Shared by the web generation service and `od board generate` (spec 05 §3.1).
 * Pure TypeScript: no DOM, no Node APIs.
 */
import type { AudioKind, MediaAspect } from './projects.js';
import type {
  MediaFailureNextStep,
  MediaSurface,
  MediaTaskStatus,
  ProjectMediaTaskError,
  ProjectMediaTaskFile,
} from './media.js';
import { MEDIA_FAILURE_NEXT_STEPS, MEDIA_TASK_STATUSES } from './media.js';

export type HtmlRenderer = 'electron' | 'framevelo';
export function isHtmlRenderer(value: unknown): value is HtmlRenderer {
  return value === 'electron' || value === 'framevelo';
}

/** Body of POST /api/projects/:id/media/generate (routes/media.ts:314-472). */
export interface MediaGenerateRequest {
  surface: MediaSurface;
  model: string;
  prompt?: string;
  /** Flat file name. The daemon replaces '/' with '_', overwrites, and may swap the extension. */
  output?: string;
  aspect?: MediaAspect;
  quality?: string;
  resolution?: string;
  /** Video seconds; non-Vela values snap to 3/5/8/10/15/30. */
  length?: number;
  duration?: number;
  voice?: string;
  audioKind?: AudioKind;
  language?: string;
  loop?: boolean;
  promptInfluence?: number;
  compositionDir?: string;
  /** HTML animation export only; omitted keeps the existing renderer. */
  htmlRenderer?: HtmlRenderer;
  /** Project-relative primary reference (becomes ctx.imageRef). */
  image?: string;
  /** Project-relative extra references. */
  images?: string[];
}

/** 202 body. */
export interface MediaGenerateAccepted {
  taskId: string;
  status: MediaTaskStatus;
  startedAt: number;
}

/** Body of POST /api/media/tasks/:id/wait. */
export interface MediaTaskWaitRequest {
  since?: number;
  timeoutMs?: number;
}

/** The daemon clamps `timeoutMs` to 0..25000 (routes/media.ts:1304-1308). */
export const MEDIA_TASK_WAIT_MAX_TIMEOUT_MS = 25_000;

/** generateMedia() result stored as task.file (media/index.ts:892-906). */
export interface MediaTaskFileRecord extends ProjectMediaTaskFile {
  model?: string;
  surface?: string;
  providerNote?: string;
  providerId?: string;
  providerError?: string | null;
  usedStubFallback?: boolean;
  intentionalStub?: boolean;
  warnings?: string[];
}

export interface MediaTaskSnapshotResponse {
  taskId: string;
  status: MediaTaskStatus;
  startedAt: number;
  endedAt: number | null;
  progress: string[];
  nextSince: number;
  file?: MediaTaskFileRecord | null;
  error?: ProjectMediaTaskError | null;
}

export interface DaemonApiErrorInfo {
  status: number;
  code?: string;
  message: string;
}

/** `done | failed | interrupted`. */
export function isTerminalMediaTaskStatus(status: MediaTaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'interrupted';
}

/**
 * Returns null when the body is not an object with a non-empty string `taskId`.
 * Tolerant otherwise: an unknown `status` becomes `'queued'` and a missing or
 * non-numeric `startedAt` becomes `0` (callers treat `0` as "unknown").
 */
export function parseMediaGenerateAccepted(raw: unknown): MediaGenerateAccepted | null {
  if (!isRecord(raw)) return null;
  const taskId = nonEmptyString(raw.taskId);
  if (taskId === undefined) return null;
  return {
    taskId,
    status: isMediaTaskStatus(raw.status) ? raw.status : 'queued',
    startedAt: finiteNumber(raw.startedAt) ?? 0,
  };
}

/**
 * Tolerant snapshot parser. Returns null when the body is not an object with a
 * non-empty string `taskId`, or when `status` is not a known media task status.
 * Otherwise coerces:
 * - missing/invalid arrays (`progress`, `file.warnings`) → `[]`, non-string entries dropped;
 * - `startedAt` → `0` when missing, `endedAt` → `null` when missing;
 * - `nextSince` → `progress.length` when missing (keeps the next long-poll from returning at once);
 * - `file` / `error` → normalized object or `null` (always present in the result).
 */
export function parseMediaTaskSnapshot(raw: unknown): MediaTaskSnapshotResponse | null {
  if (!isRecord(raw)) return null;
  const taskId = nonEmptyString(raw.taskId);
  if (taskId === undefined) return null;
  if (!isMediaTaskStatus(raw.status)) return null;
  const progress = stringArray(raw.progress);
  const nextSince = finiteNumber(raw.nextSince);
  return {
    taskId,
    status: raw.status,
    startedAt: finiteNumber(raw.startedAt) ?? 0,
    endedAt: finiteNumber(raw.endedAt) ?? null,
    progress,
    nextSince: nextSince !== undefined && nextSince >= 0 ? Math.floor(nextSince) : progress.length,
    file: parseMediaTaskFileRecord(raw.file),
    error: parseProjectMediaTaskError(raw.error),
  };
}

const MAX_TEXT_ERROR_LENGTH = 500;

/**
 * Normalizes a daemon error response. Accepts:
 * - `{ error: { code, message } }` (createCompatApiErrorResponse),
 * - legacy `{ error: string, code? }`,
 * - `{ message, code? }`,
 * - a non-JSON body passed as text (a JSON text is parsed first; HTML pages are ignored),
 * - anything else (`null`, numbers…) → `HTTP <status>`.
 */
export function parseDaemonApiError(status: number, body: unknown): DaemonApiErrorInfo {
  const httpStatus = Number.isFinite(status) ? Math.trunc(status) : 0;
  const fallback = httpStatus > 0 ? `HTTP ${httpStatus}` : 'Request failed';
  let payload = body;
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (text.startsWith('{')) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    } else {
      payload = text;
    }
  }

  let code: string | undefined;
  let message: string | undefined;
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error)) {
      code = nonEmptyString(error.code);
      message = nonEmptyString(error.message);
    } else if (typeof error === 'string') {
      message = nonEmptyString(error);
    }
    code ??= nonEmptyString(payload.code);
    message ??= nonEmptyString(payload.message);
  } else if (typeof payload === 'string' && payload && !payload.startsWith('<')) {
    message = collapseWhitespace(payload).slice(0, MAX_TEXT_ERROR_LENGTH);
  }

  const info: DaemonApiErrorInfo = { status: httpStatus, message: message ?? fallback };
  if (code !== undefined) info.code = code;
  return info;
}

// ---------------------------------------------------------------------------
// internals

function parseMediaTaskFileRecord(raw: unknown): MediaTaskFileRecord | null {
  if (!isRecord(raw)) return null;
  const name = nonEmptyString(raw.name);
  if (name === undefined) return null;
  const file: MediaTaskFileRecord = { name, warnings: stringArray(raw.warnings) };
  const size = finiteNumber(raw.size);
  if (size !== undefined) file.size = size;
  const mtime = finiteNumber(raw.mtime);
  if (mtime !== undefined) file.mtime = mtime;
  if (typeof raw.kind === 'string') file.kind = raw.kind;
  if (typeof raw.mime === 'string') file.mime = raw.mime;
  if (typeof raw.model === 'string') file.model = raw.model;
  if (typeof raw.surface === 'string') file.surface = raw.surface;
  if (typeof raw.providerNote === 'string') file.providerNote = raw.providerNote;
  if (typeof raw.providerId === 'string') file.providerId = raw.providerId;
  if (typeof raw.providerError === 'string' || raw.providerError === null) file.providerError = raw.providerError;
  if (typeof raw.usedStubFallback === 'boolean') file.usedStubFallback = raw.usedStubFallback;
  if (typeof raw.intentionalStub === 'boolean') file.intentionalStub = raw.intentionalStub;
  return file;
}

const TASK_ERROR_SUBJECTS: ReadonlyArray<NonNullable<ProjectMediaTaskError['subject']>> = [
  'prompt',
  'input_image',
  'output_image',
];

function parseProjectMediaTaskError(raw: unknown): ProjectMediaTaskError | null {
  if (typeof raw === 'string') return raw.trim() ? { message: raw } : null;
  if (!isRecord(raw)) return null;
  const error: ProjectMediaTaskError = { message: typeof raw.message === 'string' ? raw.message : '' };
  const status = finiteNumber(raw.status);
  if (status !== undefined) error.status = status;
  const code = nonEmptyString(raw.code);
  if (code !== undefined) error.code = code;
  if (typeof raw.subject === 'string' && (TASK_ERROR_SUBJECTS as readonly string[]).includes(raw.subject)) {
    error.subject = raw.subject as NonNullable<ProjectMediaTaskError['subject']>;
  }
  if (typeof raw.retryable === 'boolean') error.retryable = raw.retryable;
  if (isMediaFailureNextStep(raw.nextStep)) error.nextStep = raw.nextStep;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMediaTaskStatus(value: unknown): value is MediaTaskStatus {
  return typeof value === 'string' && (MEDIA_TASK_STATUSES as readonly string[]).includes(value);
}

function isMediaFailureNextStep(value: unknown): value is MediaFailureNextStep {
  return typeof value === 'string' && (MEDIA_FAILURE_NEXT_STEPS as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
