// SPDX-License-Identifier: AGPL-3.0-only
// Board generation service (spec 05 §4.6): compiles a generator, writes the run into the board, sends one
// `POST /media/generate` per candidate, watches the daemon tasks through the wait scheduler, writes results
// back, and rehydrates after a reload. "Stop" stops waiting: the daemon has no cancel, the task may still finish.
// Behaviour modelled after infinite-canvas web/src/pages/canvas/project.tsx (request registry per target node,
// stop by run, title from the prompt); no code copied — the transport is the daemon task API.
import {
  GENERATION_LIMITS,
  GENERATION_TOKEN_PATTERN,
  applyCandidatePatch,
  candidatePatchFromAccepted,
  candidatePatchFromHttpError,
  candidatePatchFromSnapshot,
  candidatePatchNetworkError,
  clampParams,
  collectGeneratorInputs,
  compileGeneration,
  generatorRunState,
  isActiveSlot,
  isTerminalMediaTaskStatus,
  planCandidateRetry,
  planGenerationRun,
  planMoreLikeThis,
  promoteCandidateOps,
  referenceLabelSetFor,
  removeCandidate,
  setPrimaryCandidate,
  type BoardMediaFile,
  type CandidatePatch,
  type CompiledGeneration,
  type GenerationBoardOp,
  type GenerationCandidate,
  type GenerationGraph,
  type GenerationGraphNode,
  type GenerationSlotStatus,
  type GeneratorParams,
  type MediaGenerateRequest,
  type MediaNodeData,
  type MediaTaskSnapshotResponse,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { randomUUID } from '../../utils/uuid';
import type { GenerationBoardPort } from './board-adapter';
import {
  listProjectFilesFresh,
  listProjectTasks,
  postGenerate,
  waitTask,
  type DispatchDeps,
} from './dispatch';
import { probeImage, probeVideo } from './media-probe';
import { modelAvailability, type GenerationModelOption } from './model-catalog';
import { saveGenerationPrefs } from './preferences';
import { mediaUrl, prepareReferenceImages } from './references';
import { recoverCandidateByStem, resumeCandidates } from './rehydrate';
import { createWaitScheduler, type WaitOutcome, type WaitScheduler } from './wait-scheduler';

export interface GenerationServiceDeps {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  board: GenerationBoardPort;
  /** useI18n().locale (reference labels sent to the model). */
  locale: string;
  /** Boolean(project.metadata?.baseDir): outputs of imported-folder projects would be invisible (05 F15). */
  isImportedFolderProject: boolean;
  /** B23: blocks Run and board writes when the board is read-only. */
  readOnly?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** Default: random UUIDs (valid board ids). */
  ids?: { next(): string };
  scheduler?: WaitScheduler;
  /** Injected in tests: intrinsic size of a finished file. */
  probeImage?: (url: string) => Promise<{ width: number; height: number } | null>;
  probeVideo?: (url: string) => Promise<{ width: number; height: number; durationMs: number } | null>;
  /** Injected in tests: reference proxy preparation. */
  prepareReferences?: typeof prepareReferenceImages;
  /** Timers of the terminal-write check (fake in tests). */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type RunBlockedReason =
  | 'read-only'
  | 'imported-folder'
  | 'no-model'
  | 'model-unavailable'
  | 'empty-prompt'
  | 'needs-reference'
  | 'already-running';
export type RunOutcome = { started: true; runId: string; outputNodeId: string } | { started: false; reason: RunBlockedReason };
export type GenerationEvent =
  | { type: 'run-finished'; generatorId: string; runId: string; done: number; failed: number; total: number }
  | { type: 'reference-prepare-failed'; nodeId: string }
  | { type: 'network-trouble'; candidateId: string; attempt: number };

export interface CandidateProgress {
  lines: string[];
  updatedAt: number;
  /** The scheduler reports network trouble for this candidate's task (cleared by the next snapshot). */
  reconnecting?: boolean;
}

/** Delays after a terminal write at which the service checks that the board kept it (store rebases may drop it). */
const TERMINAL_CHECK_DELAYS_MS = [2_000, 6_000, 15_000] as const;
const PROGRESS_TAIL = 3;
const TITLE_MAX_CHARS = 32;
const FAILED_STATUSES: ReadonlySet<GenerationSlotStatus> = new Set(['failed', 'interrupted', 'lost']);
const RETRYABLE_STATUSES: ReadonlySet<GenerationSlotStatus> = new Set(['failed', 'interrupted', 'lost', 'stopped']);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Run title: the first 32 characters of the prompt with reference tokens replaced by their labels. */
export function generationRunTitle(
  prompt: string,
  compiled: Pick<CompiledGeneration, 'inputs'>,
  fallback: { label: string; aspect: string },
): string {
  const labels = new Map(compiled.inputs.map((input) => [input.nodeId, input.label]));
  const text = prompt
    .replace(new RegExp(GENERATION_TOKEN_PATTERN.source, 'g'), (_token, id: string) => labels.get(id) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > 0 ? chars.slice(0, TITLE_MAX_CHARS).join('') : `${fallback.label} · ${fallback.aspect}`;
}

/** New frame of a media node fitted to the media's aspect: same centre, same long edge. */
export function fitFrameToMedia(
  frame: { x: number; y: number; w: number; h: number },
  media: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const long = Math.max(frame.w, frame.h);
  const ratio = media.width / media.height;
  if (!Number.isFinite(ratio) || ratio <= 0) return { ...frame };
  const w = ratio >= 1 ? long : Math.max(8, Math.round(long * ratio));
  const h = ratio >= 1 ? Math.max(8, Math.round(long / ratio)) : long;
  return { x: Math.round(frame.x + (frame.w - w) / 2), y: Math.round(frame.y + (frame.h - h) / 2), w, h };
}

function imageInputCount(graph: GenerationGraph, generatorId: string): number {
  return collectGeneratorInputs(graph, generatorId).inputs.filter((input) => input.kind === 'image').length;
}

/** Latest graph with the pictures that reference preparation made daemon-ready (cover proxies live only there). */
function overlayPreparedImages(latest: GenerationGraph, prepared: GenerationGraph): GenerationGraph {
  if (latest === prepared) return latest;
  const ready = new Map<string, GenerationGraphNode['image']>();
  for (const node of prepared.nodes) if (node.image?.daemonReady) ready.set(node.id, node.image);
  if (ready.size === 0) return latest;
  return {
    ...latest,
    nodes: latest.nodes.map((node) => {
      const image = ready.get(node.id);
      return image && !node.image?.daemonReady ? { ...node, image } : node;
    }),
  };
}

interface Watch {
  controller: AbortController;
  nodeId: string;
  runId: string;
}

export class GenerationService {
  private readonly board: GenerationBoardPort;
  private readonly dispatchDeps: DispatchDeps;
  private readonly now: () => number;
  private readonly ids: { next(): string };
  private readonly scheduler: WaitScheduler;
  private readonly probeImageFn: NonNullable<GenerationServiceDeps['probeImage']>;
  private readonly probeVideoFn: NonNullable<GenerationServiceDeps['probeVideo']>;
  private readonly prepare: typeof prepareReferenceImages;
  private readonly setTimer: NonNullable<GenerationServiceDeps['setTimeout']>;
  private readonly clearTimer: NonNullable<GenerationServiceDeps['clearTimeout']>;

  private readonly watches = new Map<string, Watch>();
  private readonly runControllers = new Map<string, AbortController>();
  private readonly trackedRuns = new Map<string, { generatorId: string; outputNodeId: string }>();
  private readonly finishedRuns = new Set<string>();
  private readonly progress = new Map<string, CandidateProgress>();
  private readonly preparing = new Set<string>();
  private readonly coverProxies = new Map<string, BoardMediaFile>();
  private readonly listeners = new Set<(event: GenerationEvent) => void>();
  private readonly progressListeners = new Set<() => void>();
  private readonly timers = new Set<unknown>();
  private removalUnsubscribe: (() => void) | null = null;
  private boardUnsubscribe: (() => void) | null = null;
  private disposed = false;
  private resuming = false;
  /** Incremented by dispose(); async work started in an older epoch does not start watches. */
  private epoch = 0;
  private locale: string;
  private readOnly: boolean;

  constructor(private readonly deps: GenerationServiceDeps) {
    this.board = deps.board;
    this.locale = deps.locale;
    this.readOnly = Boolean(deps.readOnly);
    const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.dispatchDeps = { projectId: deps.projectId, workspaceContext: deps.workspaceContext, fetch: fetchImpl };
    this.now = deps.now ?? (() => Date.now());
    this.ids = deps.ids ?? { next: () => randomUUID() };
    this.scheduler =
      deps.scheduler ?? createWaitScheduler({ waitTask: (taskId, body, signal) => waitTask(this.dispatchDeps, taskId, body, signal) });
    this.probeImageFn = deps.probeImage ?? ((url) => probeImage(url));
    this.probeVideoFn = deps.probeVideo ?? ((url) => probeVideo(url));
    this.prepare = deps.prepareReferences ?? prepareReferenceImages;
    this.setTimer = deps.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------

  /** Subscribes to node removals and mid-run task arrivals; called by every entry point, so a disposed service can be used again. */
  private ensureStarted(): void {
    this.disposed = false;
    if (!this.removalUnsubscribe) {
      this.removalUnsubscribe = this.board.onNodesRemoved((ids) => {
        const removed = new Set(ids);
        for (const [candidateId, watch] of [...this.watches]) {
          if (!removed.has(watch.nodeId)) continue;
          // The file still lands in the project; only the board node is gone.
          watch.controller.abort();
          this.watches.delete(candidateId);
        }
      });
    }
    if (!this.boardUnsubscribe) {
      this.boardUnsubscribe = this.board.subscribe(() => {
        if (this.disposed || this.resuming) return;
        for (const node of this.board.getGraph().nodes) {
          if (node.kind !== 'image' && node.kind !== 'video') continue;
          const candidates = node.media?.generation?.candidates;
          if (!candidates) continue;
          for (const candidate of candidates) {
            if ((candidate.status !== 'queued' && candidate.status !== 'running') || !candidate.taskId) continue;
            if (this.watches.has(candidate.id)) continue;
            if (this.runControllers.get(candidate.runId)?.signal.aborted) continue;
            this.trackRun(candidate.runId);
            this.watchCandidate(node.id, candidate.id, candidate.taskId, candidate.runId);
          }
        }
      });
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** The UI locale picks the reference label set sent to models (图片1 / Image 1). */
  setLocale(locale: string): void {
    this.locale = locale;
  }

  /** B23: updates the read-only flag when the host prop changes. */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  /** Aborts every watch and timer. Entry points called afterwards start the service again. */
  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    for (const watch of this.watches.values()) watch.controller.abort();
    this.watches.clear();
    for (const controller of this.runControllers.values()) controller.abort();
    this.runControllers.clear();
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
    this.removalUnsubscribe?.();
    this.removalUnsubscribe = null;
    this.boardUnsubscribe?.();
    this.boardUnsubscribe = null;
  }

  // ---- events ------------------------------------------------------------------------------------------

  subscribe(listener: (event: GenerationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  progressOf(candidateId: string): CandidateProgress | undefined {
    return this.progress.get(candidateId);
  }

  isPreparing(generatorId: string): boolean {
    return this.preparing.has(generatorId);
  }

  /** Watches in progress (diagnostics and tests). */
  activeWatchCount(): number {
    return this.watches.size;
  }

  private emit(event: GenerationEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener must not break the service.
      }
    }
  }

  private notifyProgress(): void {
    for (const listener of [...this.progressListeners]) {
      try {
        listener();
      } catch {
        // Same as above.
      }
    }
  }

  private setPreparing(generatorId: string, value: boolean): void {
    if (value === this.preparing.has(generatorId)) return;
    if (value) this.preparing.add(generatorId);
    else this.preparing.delete(generatorId);
    this.notifyProgress();
  }

  // ---- run ---------------------------------------------------------------------------------------------

  async run(generatorId: string, model: GenerationModelOption | null): Promise<RunOutcome> {
    this.ensureStarted();
    if (this.readOnly) return { started: false, reason: 'read-only' };
    if (this.deps.isImportedFolderProject) return { started: false, reason: 'imported-folder' };
    if (!model) return { started: false, reason: 'no-model' };
    const initial = this.board.getGraph();
    if (this.preparing.has(generatorId) || generatorRunState(initial, generatorId).active) {
      return { started: false, reason: 'already-running' };
    }
    const availability = modelAvailability(model, imageInputCount(initial, generatorId));
    if (!availability.selectable) {
      // No reference for a model that needs one: the compiler's block reason (spec 05 §4.6 step 2).
      return { started: false, reason: availability.reason === 'needs-reference' ? 'needs-reference' : 'model-unavailable' };
    }

    this.setPreparing(generatorId, true);
    let prepared: GenerationGraph = initial;
    try {
      prepared = await this.prepare({
        graph: initial,
        generatorId,
        deps: this.dispatchDeps,
        board: this.board,
        locale: this.locale,
        coverProxies: this.coverProxies,
        onPrepareFailed: (nodeId) => this.emit({ type: 'reference-prepare-failed', nodeId }),
      });
    } catch {
      prepared = initial;
    } finally {
      this.setPreparing(generatorId, false);
    }

    // The board may have changed while references were prepared (prompt typing, other runs).
    const graph = overlayPreparedImages(this.board.getGraph(), prepared);
    if (generatorRunState(graph, generatorId).active) return { started: false, reason: 'already-running' };
    const generator = graph.nodes.find((node) => node.id === generatorId && node.kind === 'generator')?.generator;
    const support = model.support;
    const compiled = compileGeneration(graph, generatorId, {
      maxReferences: support.maxReferences,
      requiresReference: support.requiresReference,
      labels: referenceLabelSetFor(this.locale),
    });
    if (!generator || !compiled.ok) return { started: false, reason: compiled.blockReason ?? 'empty-prompt' };

    const params: GeneratorParams = clampParams(generator.params, support, generator.surface);
    const plan = planGenerationRun({
      graph,
      generatorId,
      compiled,
      model: { id: model.id, provider: model.provider, caps: model.caps },
      params,
      support,
      now: this.now(),
      ids: this.ids,
      title: generationRunTitle(generator.prompt, compiled, { label: model.label, aspect: params.aspect }),
      templateId: generator.templateId,
    });
    this.board.apply(plan.ops, { label: 'generation.run', undoable: false, flush: true });
    saveGenerationPrefs(generator.surface, { model: model.id, params });
    this.trackRun(plan.runId, generatorId, plan.outputNodeId);
    await Promise.all(
      plan.slots.map((slot) => this.dispatchSlot(plan.outputNodeId, slot.candidateId, slot.request, plan.runId)),
    );
    return { started: true, runId: plan.runId, outputNodeId: plan.outputNodeId };
  }

  /** runs[0]: stop waiting. Active candidates become `stopped` and keep their task ids. */
  stop(generatorId: string): void {
    const graph = this.board.getGraph();
    const state = generatorRunState(graph, generatorId);
    if (!state.runId || !state.outputNodeId) return;
    this.runController(state.runId).abort();
    for (const [candidateId, watch] of [...this.watches]) {
      if (watch.runId !== state.runId) continue;
      watch.controller.abort();
      this.watches.delete(candidateId);
    }
    const node = graph.nodes.find((entry) => entry.id === state.outputNodeId);
    const media = node?.media;
    if (!node || !media?.generation) return;
    let data: MediaNodeData = media;
    for (const candidate of media.generation.candidates) {
      if (candidate.runId === state.runId && isActiveSlot(candidate.status)) {
        data = applyCandidatePatch(data, { id: candidate.id, status: 'stopped' }).data;
      }
    }
    if (data === media) return;
    this.board.apply([{ type: 'node.patchData', id: node.id, patch: { generation: data.generation, file: data.file } }], {
      label: 'generation.stop',
      undoable: false,
      flush: true,
    });
    this.checkRunFinished(state.runId);
  }

  async retryCandidate(nodeId: string, candidateId: string): Promise<void> {
    await this.retryMany(nodeId, [candidateId]);
  }

  /** Every failed / interrupted / lost candidate of runs[0]. */
  async retryFailed(generatorId: string): Promise<void> {
    const state = generatorRunState(this.board.getGraph(), generatorId);
    if (!state.runId || !state.outputNodeId) return;
    const node = this.board.getNode(state.outputNodeId);
    const ids = (node?.media?.generation?.candidates ?? [])
      .filter((candidate) => candidate.runId === state.runId && FAILED_STATUSES.has(candidate.status))
      .map((candidate) => candidate.id);
    if (ids.length > 0) await this.retryMany(state.outputNodeId, ids);
  }

  async moreLikeThis(nodeId: string): Promise<void> {
    this.ensureStarted();
    if (this.readOnly) return;
    const node = this.board.getNode(nodeId);
    const generation = node?.media?.generation;
    if (!node || !generation) return;
    const plan = planMoreLikeThis(node, this.ids);
    if (!plan) return;
    const added = plan.ops.flatMap((op) =>
      op.type === 'node.patchData' && 'generation' in op.patch ? (op.patch.generation?.candidates ?? []) : [],
    );
    const runId = added.find((candidate) => candidate.id === plan.candidateId)?.runId ?? plan.candidateId;
    this.board.apply(plan.ops, { label: 'generation.more', undoable: false, flush: true });
    const missing = await this.missingReference(generation.request.references.map((ref) => ref.path));
    if (missing) {
      this.patchCandidate(nodeId, this.missingReferencePatch(plan.candidateId, missing), true);
      return;
    }
    await this.dispatchSlot(nodeId, plan.candidateId, plan.request, runId);
  }

  /** Re-attaches a stopped or lost candidate: one immediate wait, then the normal watch or a file lookup. */
  async checkCandidate(nodeId: string, candidateId: string): Promise<void> {
    this.ensureStarted();
    const epoch = this.epoch;
    const candidate = this.candidateOf(nodeId, candidateId);
    if (!candidate) return;
    if (!candidate.taskId) {
      await this.recoverByStem(nodeId, candidateId);
      return;
    }
    const result = await waitTask(this.dispatchDeps, candidate.taskId, { since: 0, timeoutMs: 0 }, new AbortController().signal);
    if (epoch !== this.epoch) return;
    if (result.kind === 'gone') {
      await this.recoverByStem(nodeId, candidateId);
      return;
    }
    if (result.kind !== 'snapshot') return;
    this.handleSnapshot(nodeId, candidateId, result.snapshot);
    if (!isTerminalMediaTaskStatus(result.snapshot.status)) {
      // `stop()` aborted this run's controller; watching again needs a live one (as a retry does).
      this.liveRunController(candidate.runId);
      this.trackRun(candidate.runId);
      this.watchCandidate(nodeId, candidateId, candidate.taskId, candidate.runId);
    }
  }

  async resume(): Promise<{ watched: number; recovered: number; lost: number }> {
    this.resuming = true;
    this.ensureStarted();
    const epoch = this.epoch;
    try {
      const plan = await resumeCandidates({
        graph: this.board.getGraph(),
        listTasks: () => listProjectTasks(this.dispatchDeps),
        listFiles: () => listProjectFilesFresh(this.dispatchDeps),
      });
      if (epoch !== this.epoch) return { watched: 0, recovered: 0, lost: 0 };
      let lost = plan.lost;
      let watched = 0;
      for (const { nodeId, patch } of plan.patches) {
        if (this.watches.has(patch.id)) continue;
        const fresh = this.candidateOf(nodeId, patch.id);
        if (patch.status === 'lost' && fresh?.taskId && (fresh.status === 'queued' || fresh.status === 'running')) {
          // An in-flight POST wrote its taskId while resume() was listing tasks/files: watch it instead of marking lost.
          lost = Math.max(0, lost - 1);
          this.liveRunController(fresh.runId);
          this.trackRun(fresh.runId);
          if (this.watchCandidate(nodeId, fresh.id, fresh.taskId, fresh.runId)) watched += 1;
          continue;
        }
        this.applyResultPatch(nodeId, patch);
      }
      for (const entry of plan.watch) {
        this.liveRunController(entry.runId);
        this.trackRun(entry.runId);
        if (this.watchCandidate(entry.nodeId, entry.candidateId, entry.taskId, entry.runId)) watched += 1;
      }
      return { watched, recovered: plan.recovered, lost };
    } finally {
      this.resuming = false;
    }
  }

  // ---- user edits (undoable) ---------------------------------------------------------------------------

  setPrimary(nodeId: string, candidateId: string): void {
    const media = this.board.getNode(nodeId)?.media;
    if (!media?.generation) return;
    const data = setPrimaryCandidate(media, candidateId);
    if (data === media) return;
    this.board.apply([{ type: 'node.patchData', id: nodeId, patch: { generation: data.generation, file: data.file } }], {
      label: 'generation.setPrimary',
      undoable: true,
      flush: true,
    });
  }

  /** Copies a done candidate into its own node (the candidate stays); selects it and returns its id. */
  promote(nodeId: string, candidateId: string): string | null {
    const graph = this.board.getGraph();
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    const result = promoteCandidateOps(graph, nodeId, candidateId, this.ids, node?.title ?? '');
    if (!result) return null;
    this.board.apply(result.ops, { label: 'generation.promote', undoable: true, flush: true });
    this.board.select([result.newNodeId]);
    return result.newNodeId;
  }

  /** Removes a candidate (not the last one). Its task, if any, is no longer watched. */
  deleteCandidate(nodeId: string, candidateId: string): void {
    const media = this.board.getNode(nodeId)?.media;
    if (!media?.generation) return;
    const data = removeCandidate(media, candidateId);
    if (!data || data === media) return;
    const watch = this.watches.get(candidateId);
    if (watch) {
      watch.controller.abort();
      this.watches.delete(candidateId);
    }
    this.board.apply([{ type: 'node.patchData', id: nodeId, patch: { generation: data.generation, file: data.file } }], {
      label: 'generation.deleteCandidate',
      undoable: true,
      flush: true,
    });
  }

  // ---- internals ---------------------------------------------------------------------------------------

  private candidateOf(nodeId: string, candidateId: string): GenerationCandidate | null {
    return this.board.getNode(nodeId)?.media?.generation?.candidates.find((entry) => entry.id === candidateId) ?? null;
  }

  private modelOf(nodeId: string): string {
    return this.board.getNode(nodeId)?.media?.generation?.request.model ?? '';
  }

  private runController(runId: string): AbortController {
    let controller = this.runControllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.runControllers.set(runId, controller);
    }
    return controller;
  }

  /** A fresh (not aborted) controller for a run that is restarted (retry after stop). */
  private liveRunController(runId: string): AbortController {
    const current = this.runControllers.get(runId);
    if (current && !current.signal.aborted) return current;
    const controller = new AbortController();
    this.runControllers.set(runId, controller);
    return controller;
  }

  private trackRun(runId: string, generatorId?: string, outputNodeId?: string): void {
    if (!runId) return;
    this.finishedRuns.delete(runId);
    if (generatorId && outputNodeId) this.trackedRuns.set(runId, { generatorId, outputNodeId });
    else if (!this.trackedRuns.has(runId)) {
      const owner = this.ownerOfRun(runId);
      if (owner) this.trackedRuns.set(runId, owner);
    }
  }

  private ownerOfRun(runId: string): { generatorId: string; outputNodeId: string } | null {
    for (const node of this.board.getGraph().nodes) {
      const run = node.generator?.runs.find((entry) => entry.runId === runId);
      if (run) return { generatorId: node.id, outputNodeId: run.outputNodeId };
    }
    return null;
  }

  /** Read-modify-write of one candidate in the same tick; persists only status/file/error changes. */
  private patchCandidate(
    nodeId: string,
    patch: CandidatePatch,
    flush: boolean,
  ): { applied: boolean; firstDone: boolean; candidate: GenerationCandidate | null } {
    const media = this.board.getNode(nodeId)?.media;
    const current = media?.generation?.candidates.find((entry) => entry.id === patch.id);
    if (!media?.generation || !current) return { applied: false, firstDone: false, candidate: null };
    const { data, firstDone } = applyCandidatePatch(media, patch);
    const next = data.generation?.candidates.find((entry) => entry.id === patch.id) ?? null;
    if (!firstDone && sameJson(current, next) && sameJson(media.file, data.file)) {
      return { applied: false, firstDone: false, candidate: next };
    }
    this.board.apply([{ type: 'node.patchData', id: nodeId, patch: { generation: data.generation, file: data.file } }], {
      label: 'generation.result',
      undoable: false,
      flush,
    });
    return { applied: true, firstDone, candidate: next };
  }

  /** Applies a result (snapshot, task row, recovered file), fits the node on the first result, tracks the run. */
  private applyResultPatch(nodeId: string, patch: CandidatePatch): void {
    const terminal = patch.status !== undefined && !isActiveSlot(patch.status) && patch.status !== 'stopped';
    const result = this.patchCandidate(nodeId, patch, terminal);
    if (result.firstDone) void this.fitToFirstResult(nodeId, patch.id);
    if (terminal && result.candidate) {
      this.scheduleTerminalCheck(nodeId, patch, result.candidate.attempt);
      this.checkRunFinished(result.candidate.runId);
    }
  }

  private async dispatchSlot(nodeId: string, candidateId: string, request: MediaGenerateRequest, runId: string): Promise<void> {
    const epoch = this.epoch;
    const result = await postGenerate(this.dispatchDeps, request);
    const stopped = this.runController(runId).signal.aborted;
    if (result.ok) {
      const patch = candidatePatchFromAccepted(candidateId, result.accepted);
      // Stopped while the POST was in flight: keep the task id so "check result" can find the output.
      if (stopped) patch.status = 'stopped';
      this.patchCandidate(nodeId, patch, true);
      if (!stopped && epoch === this.epoch) this.watchCandidate(nodeId, candidateId, result.accepted.taskId, runId);
      else this.checkRunFinished(runId);
      return;
    }
    const patch =
      'error' in result
        ? candidatePatchFromHttpError(candidateId, result.error, request.model)
        : candidatePatchNetworkError(candidateId, result.network);
    this.applyResultPatch(nodeId, patch);
  }

  /** Starts watching a task unless the candidate is already watched; false when nothing was started. */
  private watchCandidate(nodeId: string, candidateId: string, taskId: string, runId: string): boolean {
    if (this.disposed || this.watches.has(candidateId)) return false;
    const runController = this.runController(runId);
    const controller = new AbortController();
    if (runController.signal.aborted) return false;
    const onRunAbort = () => controller.abort();
    runController.signal.addEventListener('abort', onRunAbort, { once: true });
    const watch: Watch = { controller, nodeId, runId };
    this.watches.set(candidateId, watch);
    void this.scheduler
      .watch(
        taskId,
        {
          onSnapshot: (snapshot) => this.handleSnapshot(nodeId, candidateId, snapshot),
          onNetworkTrouble: (attempt) => {
            this.setReconnecting(candidateId, true);
            this.emit({ type: 'network-trouble', candidateId, attempt });
          },
        },
        controller.signal,
      )
      .then((outcome) => this.afterWatch(nodeId, candidateId, outcome))
      .catch(() => undefined)
      .finally(() => {
        runController.signal.removeEventListener('abort', onRunAbort);
        if (this.watches.get(candidateId) === watch) this.watches.delete(candidateId);
        this.setReconnecting(candidateId, false);
      });
    return true;
  }

  private async afterWatch(nodeId: string, candidateId: string, outcome: WaitOutcome): Promise<void> {
    if (outcome === 'gone') await this.recoverByStem(nodeId, candidateId);
    else if (outcome === 'gave-up') this.applyResultPatch(nodeId, { id: candidateId, status: 'lost' });
  }

  private handleSnapshot(nodeId: string, candidateId: string, snapshot: MediaTaskSnapshotResponse): void {
    const previous = this.progress.get(candidateId);
    if (snapshot.progress.length > 0 || previous?.reconnecting) {
      const lines = [...(previous?.lines ?? []), ...snapshot.progress].slice(-PROGRESS_TAIL);
      this.progress.set(candidateId, { lines, updatedAt: this.now() });
      this.notifyProgress();
    }
    // Progress lines stay in memory; only status/file/error changes reach the board.
    this.applyResultPatch(nodeId, candidatePatchFromSnapshot(candidateId, snapshot, this.modelOf(nodeId)));
  }

  private setReconnecting(candidateId: string, value: boolean): void {
    const previous = this.progress.get(candidateId);
    if (Boolean(previous?.reconnecting) === value) return;
    const next: CandidateProgress = { lines: previous?.lines ?? [], updatedAt: this.now() };
    if (value) next.reconnecting = true;
    this.progress.set(candidateId, next);
    this.notifyProgress();
  }

  private async recoverByStem(nodeId: string, candidateId: string): Promise<void> {
    const candidate = this.candidateOf(nodeId, candidateId);
    if (!candidate) return;
    const patch = await recoverCandidateByStem({
      candidateId,
      outputStem: candidate.outputStem,
      listFiles: () => listProjectFilesFresh(this.dispatchDeps),
    });
    if (patch) this.applyResultPatch(nodeId, patch);
  }

  /** First result of a node: record its intrinsic size and fit the node frame to it once (`sizedToMedia`). */
  private async fitToFirstResult(nodeId: string, candidateId: string): Promise<void> {
    const node = this.board.getNode(nodeId);
    const file = this.candidateOf(nodeId, candidateId)?.file;
    if (!node || !file || (node.kind !== 'image' && node.kind !== 'video')) return;
    const url = mediaUrl(this.deps.projectId, file.path, this.deps.workspaceContext);
    let size: { width: number; height: number } | null;
    let durationMs = 0;
    if (node.kind === 'video') {
      const video = await this.probeVideoFn(url);
      size = video;
      durationMs = video?.durationMs ?? 0;
    } else {
      size = await this.probeImageFn(url);
    }
    if (!size) return;
    const fresh = this.board.getNode(nodeId);
    const freshFile = this.candidateOf(nodeId, candidateId)?.file;
    if (!fresh?.media?.generation || !freshFile) return;
    const sizedFile: BoardMediaFile = { ...freshFile, width: size.width, height: size.height };
    if (durationMs > 0) sizedFile.durationMs = durationMs;
    let data = applyCandidatePatch(fresh.media, { id: candidateId, file: sizedFile }).data;
    const ops: GenerationBoardOp[] = [];
    if (data.generation && !data.generation.sizedToMedia) {
      const frame = fitFrameToMedia(fresh, size);
      ops.push({ type: 'node.setFrame', id: nodeId, ...frame });
      data = { ...data, generation: { ...data.generation, sizedToMedia: true } };
    }
    ops.unshift({ type: 'node.patchData', id: nodeId, patch: { generation: data.generation, file: data.file } });
    this.board.apply(ops, { label: 'generation.fit', undoable: false, flush: true });
  }

  /**
   * A terminal write can be dropped by the store's conflict rebase (another write to the same node raced it).
   * Re-apply it while the board still shows the same attempt as active.
   */
  private scheduleTerminalCheck(nodeId: string, patch: CandidatePatch, attempt: number, step = 0): void {
    const delay = TERMINAL_CHECK_DELAYS_MS[step];
    if (delay === undefined || this.disposed) return;
    const timer = this.setTimer(() => {
      this.timers.delete(timer);
      const candidate = this.candidateOf(nodeId, patch.id);
      if (!candidate || candidate.attempt !== attempt || !isActiveSlot(candidate.status)) return;
      this.patchCandidate(nodeId, patch, true);
      this.scheduleTerminalCheck(nodeId, patch, attempt, step + 1);
    }, delay);
    this.timers.add(timer);
  }

  /** Emits `run-finished` once when no candidate of a tracked run is active any more. */
  private checkRunFinished(runId: string): void {
    if (!runId || this.finishedRuns.has(runId)) return;
    const owner = this.trackedRuns.get(runId);
    if (!owner) return;
    const candidates = (this.board.getNode(owner.outputNodeId)?.media?.generation?.candidates ?? []).filter(
      (candidate) => candidate.runId === runId,
    );
    if (candidates.length === 0 || candidates.some((candidate) => isActiveSlot(candidate.status))) return;
    this.finishedRuns.add(runId);
    this.trackedRuns.delete(runId);
    const done = candidates.filter((candidate) => candidate.status === 'done').length;
    const failed = candidates.filter((candidate) => FAILED_STATUSES.has(candidate.status)).length;
    this.emit({ type: 'run-finished', generatorId: owner.generatorId, runId, done, failed, total: candidates.length });
  }

  private async missingReference(paths: readonly string[]): Promise<string | null> {
    if (paths.length === 0) return null;
    let files: Set<string>;
    try {
      files = new Set((await listProjectFilesFresh(this.dispatchDeps)).map((file) => file.name));
    } catch {
      return null; // cannot verify: let the daemon decide
    }
    const missing = paths.find((path) => !files.has(path));
    return missing ?? null;
  }

  private missingReferencePatch(candidateId: string, path: string): CandidatePatch {
    const name = path.slice(path.lastIndexOf('/') + 1) || path;
    return {
      id: candidateId,
      status: 'failed',
      error: {
        message: `Reference no longer exists: ${path}`,
        nextStep: 'revise-request',
        messageKey: 'fantay.gen.refs.missing',
        messageVars: { name },
      },
    };
  }

  private async retryMany(nodeId: string, candidateIds: readonly string[]): Promise<void> {
    this.ensureStarted();
    if (this.readOnly) return;
    const node = this.board.getNode(nodeId);
    const generation = node?.media?.generation;
    if (!node || !generation) return;
    const retryable = candidateIds.filter((id) => {
      const candidate = generation.candidates.find((entry) => entry.id === id);
      return candidate !== undefined && RETRYABLE_STATUSES.has(candidate.status);
    });
    if (retryable.length === 0) return;
    const missing = await this.missingReference(generation.request.references.map((ref) => ref.path));
    const dispatches: Array<Promise<void>> = [];
    for (const candidateId of retryable) {
      if (missing) {
        this.applyResultPatch(nodeId, this.missingReferencePatch(candidateId, missing));
        continue;
      }
      const fresh = this.board.getNode(nodeId);
      const retry = fresh ? planCandidateRetry(fresh, candidateId) : null;
      const candidate = this.candidateOf(nodeId, candidateId);
      if (!retry || !candidate) continue;
      const watch = this.watches.get(candidateId);
      if (watch) {
        watch.controller.abort();
        this.watches.delete(candidateId);
      }
      this.liveRunController(candidate.runId);
      this.trackRun(candidate.runId);
      this.patchCandidate(nodeId, retry.patch, true);
      dispatches.push(this.dispatchSlot(nodeId, candidateId, retry.request, candidate.runId));
    }
    await Promise.all(dispatches);
  }
}

/** Candidates of runs[0] that `retryFailed` would retry (for disabled states in the UI). */
export function retryableCandidatesOfLatestRun(graph: GenerationGraph, generatorId: string): GenerationCandidate[] {
  const state = generatorRunState(graph, generatorId);
  if (!state.runId || !state.outputNodeId) return [];
  const node = graph.nodes.find((entry) => entry.id === state.outputNodeId);
  return (node?.media?.generation?.candidates ?? []).filter(
    (candidate) => candidate.runId === state.runId && FAILED_STATUSES.has(candidate.status),
  );
}

/** At most `GENERATION_LIMITS.maxCandidatesPerNode` candidates per node (more-like-this disabled reason). */
export function canAddCandidate(node: GenerationGraphNode | null): boolean {
  return Boolean(node?.media?.generation && node.media.generation.candidates.length < GENERATION_LIMITS.maxCandidatesPerNode);
}
