// SPDX-License-Identifier: AGPL-3.0-only
// New-design state (plan R10, R18): the NewDesignDialog request (board "+" ▸ 设计文档, the Files tab,
// the desktop menu's `fantay.design.import`), the queue of design creation jobs, and the creation-runner
// slot. A job turns "blank / convert this page / import this file / new from this image" into a saved
// project design: `DesignCreationRunner` (mounted by NewDesignDialogHost and DesignEditorEventBridge)
// processes one job at a time; exactly one mounted runner owns the queue.
import { useCallback, useSyncExternalStore } from 'react';
import type { BoardMediaFile, WorkspaceCollabContext } from '@open-design/contracts';

type Ctx = WorkspaceCollabContext | null;

/* ── dialog request ───────────────────────────────────────────────────────────────────────── */

export type NewDesignSource = 'blank' | 'html' | 'file';

export interface NewDesignRequest {
  nonce: number;
  projectId: string;
  workspaceContext: Ctx;
  initialSource: NewDesignSource;
  initialName?: string;
  /** Preselected project page for 由项目网页转换. */
  sourcePath?: string;
  /** Board node the design derives from (lineage edge on the new design node). */
  sourceNodeId?: string;
  origin: 'board' | 'files' | 'menu' | 'frame' | 'other';
}

export interface OpenNewDesignDialogInput {
  projectId: string;
  workspaceContext?: Ctx;
  initialSource?: NewDesignSource;
  initialName?: string;
  sourcePath?: string;
  sourceNodeId?: string;
  origin?: NewDesignRequest['origin'];
}

let dialogRequest: NewDesignRequest | null = null;
let dialogNonce = 0;
const dialogListeners = new Set<() => void>();

function emitDialog(): void {
  for (const listener of [...dialogListeners]) listener();
}

function subscribeDialog(listener: () => void): () => void {
  dialogListeners.add(listener);
  return () => {
    dialogListeners.delete(listener);
  };
}

/** Opens (or retargets) the NewDesignDialog. The workspace context defaults to the last one seen for the project. */
export function openNewDesignDialog(input: OpenNewDesignDialogInput): NewDesignRequest {
  dialogNonce += 1;
  const request: NewDesignRequest = {
    nonce: dialogNonce,
    projectId: input.projectId,
    workspaceContext: input.workspaceContext !== undefined ? input.workspaceContext : designWorkspaceContextFor(input.projectId),
    initialSource: input.initialSource ?? (input.sourcePath ? 'html' : 'blank'),
    ...(input.initialName ? { initialName: input.initialName } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}),
    origin: input.origin ?? 'other',
  };
  dialogRequest = request;
  emitDialog();
  return request;
}

export function closeNewDesignDialog(): void {
  if (dialogRequest === null) return;
  dialogRequest = null;
  emitDialog();
}

export function getNewDesignRequest(): NewDesignRequest | null {
  return dialogRequest;
}

function getServerDialogRequest(): NewDesignRequest | null {
  return null;
}

export function useNewDesignRequest(): NewDesignRequest | null {
  return useSyncExternalStore(subscribeDialog, getNewDesignRequest, getServerDialogRequest);
}

/* ── workspace context memory ─────────────────────────────────────────────────────────────── */

const knownContexts = new Map<string, Ctx>();

/** Design surfaces (the Files-tab viewer, the board bridge) record the project's workspace authority, so
 *  global entry points (the desktop menu) can address team projects too. */
export function rememberDesignWorkspaceContext(projectId: string, ctx: Ctx | undefined): void {
  if (!projectId) return;
  knownContexts.set(projectId, ctx ?? null);
}

export function designWorkspaceContextFor(projectId: string): Ctx {
  return knownContexts.get(projectId) ?? null;
}

/* ── creation jobs ────────────────────────────────────────────────────────────────────────── */

export type DesignCreationSource =
  | { kind: 'blank' }
  | { kind: 'convert-html'; sourcePath: string }
  | { kind: 'import-file'; file: File }
  | { kind: 'new-from-image'; image: BoardMediaFile };

export interface DesignCreationInput {
  projectId: string;
  workspaceContext?: Ctx;
  /** The name the user typed (board node title); the path is derived from it unless `path` is given. */
  title: string;
  path?: string;
  source: DesignCreationSource;
  sourceNodeId?: string;
  /** Open the saved design in the 文件 root afterwards (default true). */
  openAfter?: boolean;
  origin?: 'dialog' | 'event' | 'other';
}

export type DesignCreationStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DesignCreationJob {
  id: string;
  input: DesignCreationInput;
  status: DesignCreationStatus;
  /** The saved path once done. */
  path: string | null;
  /** Localized failure reason. */
  error: string | null;
  createdAt: number;
}

const MAX_FINISHED_JOBS = 20;
const EMPTY_JOBS: readonly DesignCreationJob[] = Object.freeze([]);

let jobs: readonly DesignCreationJob[] = EMPTY_JOBS;
let jobSequence = 0;
const jobListeners = new Set<() => void>();

function emitJobs(): void {
  for (const listener of [...jobListeners]) listener();
}

function subscribeJobs(listener: () => void): () => void {
  jobListeners.add(listener);
  return () => {
    jobListeners.delete(listener);
  };
}

function getJobs(): readonly DesignCreationJob[] {
  return jobs;
}

function getServerJobs(): readonly DesignCreationJob[] {
  return EMPTY_JOBS;
}

function pruneFinished(list: readonly DesignCreationJob[]): readonly DesignCreationJob[] {
  const finished = list.filter((job) => job.status === 'done' || job.status === 'failed');
  if (finished.length <= MAX_FINISHED_JOBS) return list;
  const drop = new Set(finished.slice(0, finished.length - MAX_FINISHED_JOBS).map((job) => job.id));
  return list.filter((job) => !drop.has(job.id));
}

/** Queues a creation job; returns its id. */
export function startDesignCreation(input: DesignCreationInput): string {
  jobSequence += 1;
  const id = `design-job-${jobSequence}`;
  const job: DesignCreationJob = { id, input, status: 'queued', path: null, error: null, createdAt: Date.now() };
  jobs = pruneFinished([...jobs, job]);
  emitJobs();
  return id;
}

export function updateDesignCreationJob(id: string, patch: Partial<Pick<DesignCreationJob, 'status' | 'path' | 'error'>>): void {
  let changed = false;
  jobs = jobs.map((job) => {
    if (job.id !== id) return job;
    const next = { ...job, ...patch };
    changed = next.status !== job.status || next.path !== job.path || next.error !== job.error;
    return changed ? next : job;
  });
  if (!changed) return;
  jobs = pruneFinished(jobs);
  emitJobs();
}

export function getDesignCreationJob(id: string | null | undefined): DesignCreationJob | null {
  if (!id) return null;
  return jobs.find((job) => job.id === id) ?? null;
}

/** The next job a runner should work on: a running one first (resume), else the oldest queued. */
export function nextDesignCreationJob(list: readonly DesignCreationJob[] = jobs): DesignCreationJob | null {
  return list.find((job) => job.status === 'running') ?? list.find((job) => job.status === 'queued') ?? null;
}

export function useDesignCreationJobs(): readonly DesignCreationJob[] {
  return useSyncExternalStore(subscribeJobs, getJobs, getServerJobs);
}

export function useDesignCreationJob(id: string | null | undefined): DesignCreationJob | null {
  const getSnapshot = useCallback(() => getDesignCreationJob(id), [id]);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribeJobs, getSnapshot, getServerSnapshot);
}

/**
 * Calls `listener` whenever job `id` changes; stops by itself once the job is done or failed, or with
 * `null` when the job disappeared from the queue.
 */
export function watchDesignCreationJob(id: string, listener: (job: DesignCreationJob | null) => void): () => void {
  let last: DesignCreationJob | null = getDesignCreationJob(id);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    jobListeners.delete(onChange);
  };
  function onChange(): void {
    const job = getDesignCreationJob(id);
    if (job === last) return;
    last = job;
    listener(job);
    if (!job || job.status === 'done' || job.status === 'failed') stop();
  }
  jobListeners.add(onChange);
  return stop;
}

/* ── runner slot ──────────────────────────────────────────────────────────────────────────── */

let runnerTokens: readonly object[] = [];
const runnerListeners = new Set<() => void>();

function emitRunners(): void {
  for (const listener of [...runnerListeners]) listener();
}

/** Registers a mounted runner; the earliest registered one owns the queue. Returns the unregister. */
export function registerDesignCreationRunner(token: object): () => void {
  if (!runnerTokens.includes(token)) {
    runnerTokens = [...runnerTokens, token];
    emitRunners();
  }
  return () => {
    if (!runnerTokens.includes(token)) return;
    runnerTokens = runnerTokens.filter((entry) => entry !== token);
    emitRunners();
  };
}

export function hasDesignCreationRunner(): boolean {
  return runnerTokens.length > 0;
}

export function isActiveDesignCreationRunner(token: object): boolean {
  return runnerTokens[0] === token;
}

function subscribeRunners(listener: () => void): () => void {
  runnerListeners.add(listener);
  return () => {
    runnerListeners.delete(listener);
  };
}

export function useIsActiveDesignCreationRunner(token: object): boolean {
  const getSnapshot = useCallback(() => isActiveDesignCreationRunner(token), [token]);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribeRunners, getSnapshot, getServerSnapshot);
}

export function resetNewDesignStoreForTests(): void {
  dialogRequest = null;
  dialogNonce = 0;
  jobs = EMPTY_JOBS;
  jobSequence = 0;
  runnerTokens = [];
  knownContexts.clear();
  emitDialog();
  emitJobs();
  emitRunners();
}
