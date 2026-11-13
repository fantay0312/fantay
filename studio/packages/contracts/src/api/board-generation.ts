// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-generation.ts,
// web/src/lib/canvas/canvas-resource-references.ts, web/src/lib/image-reference-prompt.ts,
// web/src/lib/canvas/canvas-generation-helpers.ts, web/src/i18n/locales/{zh-CN,en-US}.ts (label strings).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: reference compiler, labels and input flattening rewritten as pure
// TypeScript over a board graph view; data model, param tables, run planning and reducers are new.
/**
 * Board generation model (spec 05 §3.2): data model of generator / image / video board nodes, the
 * adapter-facing graph view and ops, the prompt/reference compiler, renderer and parameter support
 * tables, output naming, run planning, candidate reducers and prompt-template arguments.
 *
 * Shared by the web generation service and `od board generate`. Pure TypeScript: no DOM, no crypto,
 * no Node APIs; ids and clocks are injected.
 *
 * Binding amendments: plan R3e (group sources are not connectable in phase 1 — compile-time group
 * expansion stays for imported data; the board stores the `derived` role as `lineage`), amendment C8
 * (phase-1 surfaces are image | video).
 */
import type { MediaAspect } from './projects.js';
import { HYPERFRAMES_VIDEO_MODEL } from './projects.js';
import type {
  MediaFailureNextStep,
  MediaTaskStatus,
  ProjectMediaTask,
  ProjectMediaTaskError,
  ProjectMediaTaskFile,
} from './media.js';
import { MEDIA_FAILURE_NEXT_STEPS, mediaFailureNextStep } from './media.js';
import type {
  DaemonApiErrorInfo,
  MediaGenerateAccepted,
  MediaGenerateRequest,
  MediaTaskFileRecord,
  MediaTaskSnapshotResponse,
} from './media-generate.js';
import { isTerminalMediaTaskStatus } from './media-generate.js';

// ===========================================================================
// 3.2.1 Data model
// ===========================================================================

export type GenerationSurface = 'image' | 'video';
/** Phase-1 generator surfaces (amendment C8: audio is hidden). */
export const GENERATION_SURFACES = ['image', 'video'] as const satisfies readonly GenerationSurface[];

/** Graph-view edge role. The board contract stores `derived` as `lineage` (R3e); see {@link GENERATION_EDGE_ROLE_TO_BOARD_KIND}. */
export type GenerationEdgeRole = 'reference' | 'output' | 'derived';

export type GenerationSlotStatus =
  | 'pending' // created locally, POST not acknowledged
  | 'queued'
  | 'running' // daemon task states
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'stopped' // user stopped waiting; taskId kept, task may still finish
  | 'lost'; // task record gone and no output file found

export const GENERATION_SLOT_STATUSES = [
  'pending',
  'queued',
  'running',
  'done',
  'failed',
  'interrupted',
  'stopped',
  'lost',
] as const satisfies readonly GenerationSlotStatus[];

export interface BoardMediaFile {
  /** Project-relative, served by /api/projects/:id/raw/<path>. */
  path: string;
  mime?: string;
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface GenerationCandidateError {
  /** Diagnostic text, only shown under "error details". */
  message: string;
  nextStep: MediaFailureNextStep;
  code?: string;
  status?: number;
  retryable?: boolean;
  subject?: 'prompt' | 'input_image' | 'output_image';
  /** Optional UI copy override (web Dict key), e.g. 'fantay.gen.sandbox', 'fantay.gen.refs.missing'. */
  messageKey?: string;
  messageVars?: Record<string, string>;
}

export interface GenerationCandidate {
  id: string;
  runId: string;
  /** 0-based slot index in its run. */
  index: number;
  /** 0 first try, +1 per retry. */
  attempt: number;
  status: GenerationSlotStatus;
  /** Output file name without extension, e.g. 'gen-k3f9a2-p0x7qe-1'. */
  outputStem: string;
  taskId?: string;
  startedAt?: number;
  endedAt?: number;
  file?: BoardMediaFile;
  error?: GenerationCandidateError;
  warnings?: string[];
  providerNote?: string;
  /** usedStubFallback || intentionalStub */
  stub?: boolean;
}

export interface GenerationRequestRecord {
  surface: GenerationSurface;
  /** Id actually sent (variant resolved). */
  model: string;
  /** Picker id (variant group base). */
  modelBase: string;
  provider: string;
  /** Compiled prompt sent to the daemon. */
  prompt: string;
  /** Raw generator prompt with @[node:id] tokens. */
  promptSource: string;
  aspect?: MediaAspect;
  quality?: string;
  resolution?: string;
  length?: number;
  references: Array<{ nodeId: string; path: string; label: string }>;
  generatorId: string;
  runId: string;
  templateId?: string;
  createdAt: number;
}

export interface MediaNodeGeneration {
  candidates: GenerationCandidate[];
  primaryCandidateId?: string;
  request: GenerationRequestRecord;
  /** Node frame already fitted to the first result. */
  sizedToMedia?: boolean;
}

/** `data` of board nodes of kind 'image' and 'video'. */
export interface MediaNodeData {
  /** Displayed media; mirrors the primary candidate when generated. */
  file?: BoardMediaFile;
  /** Daemon-ready copy used as a reference. */
  refProxy?: { path: string; sourceKey: string };
  generation?: MediaNodeGeneration;
}

export interface GeneratorParams {
  aspect: MediaAspect;
  count: 1 | 2 | 3 | 4;
  /** Video seconds. */
  length?: number;
  quality?: string;
  resolution?: string;
}

export interface GeneratorRunSummary {
  runId: string;
  outputNodeId: string;
  surface: GenerationSurface;
  model: string;
  count: number;
  startedAt: number;
}

/** `data` of board nodes of kind 'generator'. */
export interface GeneratorNodeData {
  version: 1;
  surface: GenerationSurface;
  /** Raw text with @[node:<id>] tokens. */
  prompt: string;
  /** null = auto-pick; the resolved id is written back on Run. */
  model: string | null;
  params: GeneratorParams;
  templateId?: string;
  /** Newest first, ≤ GENERATION_LIMITS.runHistory. */
  runs: GeneratorRunSummary[];
}

export const GENERATION_LIMITS = {
  maxCount: 4,
  runHistory: 20,
  maxCandidatesPerNode: 16,
  outputGapX: 96,
  placementStepY: 24,
  placementMargin: 16,
  referenceMaxBytes: 16 * 1024 * 1024,
  referenceTargetBytes: 15 * 1024 * 1024,
  toolOutputTargetBytes: 15 * 1024 * 1024,
} as const;
/** Frame of a new generator with the default 1:1 output; other aspects follow {@link mediaNodeSizeFor}. */
export const GENERATOR_DEFAULT_SIZE = { w: 320, h: 320 } as const;
export const GENERATOR_MIN_SIZE = { w: 120, h: 120 } as const;
export const DAEMON_REFERENCE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
export const MEDIA_ASPECT_VALUES: readonly MediaAspect[] = ['1:1', '16:9', '9:16', '4:3', '3:4'];

/**
 * Shallow patch of a data object. A key present with the value `undefined` clears that optional
 * field (written for `exactOptionalPropertyTypes`; adapters map it to the board contract's `null`).
 * Required fields are never cleared.
 */
export type GenerationDataPatch<T> = { [K in keyof T]?: T[K] | undefined };

// ===========================================================================
// 3.2.2 Graph view and ops (adapter-facing)
// ===========================================================================

export type GenerationGraphNodeKind = 'generator' | 'image' | 'video' | 'note' | 'group' | 'other';

export interface GenerationGraphNode {
  id: string;
  kind: GenerationGraphNodeKind;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Usable picture: image nodes → refProxy ?? file; frame/design/web nodes → their cover when it is a
   * project file. Adapters set it on `other` nodes only for board kinds that may be `reference`
   * sources (frame, web, design — R3e).
   */
  image?: BoardMediaFile & { daemonReady: boolean };
  /** Note text. */
  text?: string;
  /** Group members in display order. */
  memberIds?: string[];
  generator?: GeneratorNodeData;
  media?: MediaNodeData;
}
export interface GenerationGraphEdge {
  id: string;
  from: string;
  to: string;
  role: GenerationEdgeRole;
  /** Reference order: board edge `createdAt`, then `id` (R3e). */
  order: number;
}
export interface GenerationGraph {
  nodes: GenerationGraphNode[];
  edges: GenerationGraphEdge[];
}

export interface GenerationNodeInput {
  id: string;
  kind: 'generator' | 'image' | 'video';
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  data: GeneratorNodeData | MediaNodeData;
}
export interface GenerationEdgeInput {
  id: string;
  from: string;
  to: string;
  role: GenerationEdgeRole;
}

export type GenerationBoardOp =
  | { type: 'node.add'; node: GenerationNodeInput }
  /** Shallow merge; a key set to `undefined` clears that optional field. */
  | {
      type: 'node.patchData';
      id: string;
      patch: GenerationDataPatch<GeneratorNodeData> | GenerationDataPatch<MediaNodeData>;
    }
  | { type: 'node.setFrame'; id: string; x: number; y: number; w: number; h: number }
  | { type: 'node.setTitle'; id: string; title: string }
  | { type: 'edge.add'; edge: GenerationEdgeInput }
  | { type: 'edge.remove'; id: string };

export interface GenerationOpMeta {
  /** Undo label / debug. */
  label: string;
  /** Service writes: false; user actions: true. */
  undoable: boolean;
  /** Persist immediately (run creation, taskId assignment, results). */
  flush: boolean;
  /** E.g. `prompt:${nodeId}` for typing. */
  coalesceKey?: string;
}

/** R3e: the board contract's edge kind for each graph-view role (`derived` is stored as `lineage`). */
export const GENERATION_EDGE_ROLE_TO_BOARD_KIND: Readonly<
  Record<GenerationEdgeRole, 'reference' | 'output' | 'lineage'>
> = Object.freeze({ reference: 'reference', output: 'output', derived: 'lineage' });

/** Inverse of {@link GENERATION_EDGE_ROLE_TO_BOARD_KIND}; unknown kinds → null. */
export function generationEdgeRoleFromBoardKind(kind: string): GenerationEdgeRole | null {
  switch (kind) {
    case 'reference':
      return 'reference';
    case 'output':
      return 'output';
    case 'lineage':
    case 'derived':
      return 'derived';
    default:
      return null;
  }
}

/**
 * `ext ∈ DAEMON_REFERENCE_EXTENSIONS && (size ?? 0) ≤ referenceMaxBytes`, and the path is a plain
 * project-relative path (no URL/scheme, no absolute path, no `..` segment), because the daemon only
 * reads references from inside the project.
 */
export function isDaemonReadyImage(file: BoardMediaFile): boolean {
  if (!isPlainProjectPath(file.path)) return false;
  const ext = extensionOf(file.path);
  if (!(DAEMON_REFERENCE_EXTENSIONS as readonly string[]).includes(ext)) return false;
  return (file.size ?? 0) <= GENERATION_LIMITS.referenceMaxBytes;
}

/**
 * Whether `from` may become a `reference` source of a generator: image/other with `image`, and notes.
 * Generators, videos and — in phase 1 (R3e) — groups are not connectable. Groups that already are
 * reference sources (imported data) still expand at compile time.
 */
export function canConnectToGenerator(from: GenerationGraphNode, _graph: GenerationGraph): boolean {
  switch (from.kind) {
    case 'image':
    case 'other':
      return Boolean(from.image);
    case 'note':
      return true;
    default:
      return false;
  }
}

export function createGeneratorNodeInput(opts: {
  id: string;
  x: number;
  y: number;
  surface?: GenerationSurface | undefined;
  prompt?: string | undefined;
  model?: string | null | undefined;
  params?: Partial<GeneratorParams> | undefined;
}): GenerationNodeInput {
  const surface = opts.surface ?? 'image';
  const data: GeneratorNodeData = {
    version: 1,
    surface,
    prompt: opts.prompt ?? '',
    model: opts.model ?? null,
    params: normalizeGeneratorParams(surface, opts.params),
    runs: [],
  };
  // The frame previews the output: same shape and long edge as the media node a run will create.
  const size = mediaNodeSizeFor(surface, data.params.aspect);
  return {
    id: opts.id,
    kind: 'generator',
    x: opts.x,
    y: opts.y,
    w: size.w,
    h: size.h,
    title: '',
    data,
  };
}

/**
 * Spec 04 "Generate (G)" with a selection: a generator right of the selection bbox
 * (`outputGapX`, top-aligned, moved down until free) plus `reference` edges from the eligible selected
 * nodes ({@link canConnectToGenerator}), in `selectedIds` order. Id order: generator, then one per edge.
 */
export function createGeneratorForSelection(
  graph: GenerationGraph,
  selectedIds: string[],
  ids: { next(): string },
  surface: GenerationSurface = 'image',
): { ops: GenerationBoardOp[]; generatorId: string } {
  const byId = indexNodes(graph);
  const selected: GenerationGraphNode[] = [];
  for (const id of selectedIds) {
    const node = byId.get(id);
    if (node && !selected.includes(node)) selected.push(node);
  }
  let x = 0;
  let y = 0;
  if (selected.length) {
    x = Math.max(...selected.map((node) => node.x + node.w)) + GENERATION_LIMITS.outputGapX;
    y = Math.min(...selected.map((node) => node.y));
  }
  const generatorId = ids.next();
  const input = createGeneratorNodeInput({ id: generatorId, x, y, surface });
  const at = findFreePlacement(graph, { x, y, w: input.w, h: input.h });
  const ops: GenerationBoardOp[] = [{ type: 'node.add', node: { ...input, x: at.x, y: at.y } }];
  for (const node of selected) {
    if (!canConnectToGenerator(node, graph)) continue;
    ops.push({ type: 'edge.add', edge: { id: ids.next(), from: node.id, to: generatorId, role: 'reference' } });
  }
  return { ops, generatorId };
}

/** For spec 04 copy/paste: generator copies drop run history. */
export function cloneGeneratorData(data: GeneratorNodeData): GeneratorNodeData {
  return { ...cloneJson(data), runs: [] };
}

/**
 * For spec 04 copy/paste: media copies drop non-terminal candidates (pending/queued/running, and
 * `stopped`, whose task may still finish). The primary falls back to the first done candidate and
 * `file` keeps mirroring it; without remaining candidates the copy has no `generation`.
 */
export function cloneMediaNodeData(data: MediaNodeData): MediaNodeData {
  const copy = cloneJson(data);
  const generation = copy.generation;
  if (!generation) return copy;
  const candidates = generation.candidates.filter((candidate) => COPYABLE_SLOT_STATUSES.has(candidate.status));
  if (!candidates.length) {
    delete copy.generation;
    return copy;
  }
  const next: MediaNodeGeneration = { ...generation, candidates };
  if (!candidates.some((candidate) => candidate.id === generation.primaryCandidateId)) {
    const fallback = firstDoneCandidate(candidates);
    if (fallback) next.primaryCandidateId = fallback.id;
    else delete next.primaryCandidateId;
  }
  return withMirroredFile({ ...copy, generation: next });
}

// ===========================================================================
// 3.2.3 Compiler (port of IC canvas-node-generation.ts:40-157 + canvas-resource-references.ts:53-128)
// ===========================================================================

/** Same token as IC canvas-config-composer.tsx:34. Global: callers must not share its `lastIndex`. */
export const GENERATION_TOKEN_PATTERN = /@\[node:([^\]\s]+)\]/g;

export interface ReferenceLabelSet {
  /** 1-based. */
  image(n: number): string;
  text(n: number): string;
  textMention(label: string): string;
  textBlock(label: string, text: string): string;
  quote(title: string): string;
  separator: string;
  prefix(labels: string[]): string;
}

const ZH_CN_REFERENCE_LABELS: ReferenceLabelSet = Object.freeze({
  image: (n: number) => `图片${n}`,
  text: (n: number) => `文本${n}`,
  textMention: (label: string) => `【${label}】`,
  textBlock: (label: string, text: string) => `【${label}】\n${text}`,
  quote: (title: string) => `「${title}」`,
  separator: '、',
  prefix: (labels: string[]) => `参考图片编号：${labels.join('、')}。请按这些编号理解提示词中的图片引用。`,
});

const EN_REFERENCE_LABELS: ReferenceLabelSet = Object.freeze({
  image: (n: number) => `Image ${n}`,
  text: (n: number) => `Text ${n}`,
  textMention: (label: string) => `[${label}]`,
  textBlock: (label: string, text: string) => `[${label}]\n${text}`,
  quote: (title: string) => `"${title}"`,
  separator: ', ',
  prefix: (labels: string[]) =>
    `Reference image labels: ${labels.join(', ')}. Use these labels to interpret image references in the prompt.`,
});

/** Prompt text sent to models, not UI chrome (zh wording from IC zh-CN.ts:40). */
export const REFERENCE_LABELS: { 'zh-CN': ReferenceLabelSet; en: ReferenceLabelSet } = Object.freeze({
  'zh-CN': ZH_CN_REFERENCE_LABELS,
  en: EN_REFERENCE_LABELS,
});

/** 'zh*' → zh-CN, else en. */
export function referenceLabelSetFor(locale: string): ReferenceLabelSet {
  return locale.trim().toLowerCase().startsWith('zh') ? REFERENCE_LABELS['zh-CN'] : REFERENCE_LABELS.en;
}

export type CompileWarning =
  | { kind: 'refs-truncated'; kept: number; total: number }
  | { kind: 'refs-ignored-by-model'; count: number }
  | { kind: 'reference-not-ready'; nodeId: string }
  | { kind: 'unresolved-token'; nodeId: string }
  | { kind: 'ineligible-input'; nodeId: string };
export type CompileBlockReason = 'empty-prompt' | 'needs-reference';

export interface CompiledInput {
  nodeId: string;
  kind: 'image' | 'text';
  label: string;
  title?: string;
  mentioned: boolean;
  /** Images: sent as a reference. Texts: always true (appended as a text block). */
  sent: boolean;
  image?: BoardMediaFile;
  text?: string;
}
export interface CompiledGeneration {
  ok: boolean;
  blockReason?: CompileBlockReason;
  prompt: string;
  references: Array<{ nodeId: string; path: string; label: string }>;
  texts: Array<{ nodeId: string; label: string; text: string }>;
  /** Label order; drives chips, reference bar, mention menu. */
  inputs: CompiledInput[];
  warnings: CompileWarning[];
}
export interface CompileOptions {
  maxReferences: number;
  requiresReference: boolean;
  labels: ReferenceLabelSet;
}

type CollectedGeneratorInput = {
  nodeId: string;
  kind: 'image' | 'text';
  title?: string;
  image?: GenerationGraphNode['image'];
  text?: string;
  viaGroupId?: string;
};

/**
 * Step 1 of the compiler: incoming `reference` edges sorted by `order` (then id); a group source
 * expands to its eligible members in `memberIds` order. Image inputs = image/other nodes with `image`;
 * text inputs = notes with non-empty trimmed text (text is trimmed). Videos, generators, empty notes,
 * other nodes without a picture and groups without eligible members add `ineligible-input` (members
 * of a group that are not eligible are skipped silently). Dedupe by node id, first occurrence wins.
 */
export function collectGeneratorInputs(
  graph: GenerationGraph,
  generatorId: string,
): {
  inputs: Array<{
    nodeId: string;
    kind: 'image' | 'text';
    title?: string;
    image?: GenerationGraphNode['image'];
    text?: string;
    viaGroupId?: string;
  }>;
  warnings: CompileWarning[];
} {
  const { inputs, warnings } = collectInputsDetailed(graph, generatorId);
  return { inputs, warnings };
}

/**
 * Compiles a generator and its incoming edges into the prompt and references sent to the daemon
 * (spec 05 §3.2.3, steps 1–7). Deterministic.
 */
export function compileGeneration(
  graph: GenerationGraph,
  generatorId: string,
  options: CompileOptions,
): CompiledGeneration {
  const labels = options.labels;
  const generatorNode = graph.nodes.find((node) => node.id === generatorId);
  const promptSource = generatorNode?.generator?.prompt ?? '';
  const { inputs, warnings, groupMembers } = collectInputsDetailed(graph, generatorId);
  const inputById = new Map(inputs.map((input) => [input.nodeId, input]));

  // Steps 2–3: labels — mentions in token order first, then the rest in input order.
  const labelById = new Map<string, string>();
  const mentioned = new Set<string>();
  const labelOrder: CollectedGeneratorInput[] = [];
  let imageCount = 0;
  let textCount = 0;
  const assignLabel = (nodeId: string, mention: boolean): void => {
    const input = inputById.get(nodeId);
    if (!input) return;
    if (!labelById.has(nodeId)) {
      labelById.set(nodeId, input.kind === 'image' ? labels.image(++imageCount) : labels.text(++textCount));
      labelOrder.push(input);
    }
    if (mention) mentioned.add(nodeId);
  };
  const unresolved = new Set<string>();
  for (const match of promptSource.matchAll(generationTokenRegExp())) {
    const id = match[1] ?? '';
    const members = groupMembers.get(id);
    if (inputById.has(id)) {
      assignLabel(id, true);
    } else if (members) {
      for (const memberId of members) assignLabel(memberId, true);
    } else if (!unresolved.has(id)) {
      unresolved.add(id);
      warnings.push({ kind: 'unresolved-token', nodeId: id });
    }
  }
  for (const input of inputs) assignLabel(input.nodeId, false);

  // Step 4: sendable references.
  const imageInputs = labelOrder.filter((input) => input.kind === 'image');
  const maxReferences = Number.isFinite(options.maxReferences) ? Math.max(0, Math.floor(options.maxReferences)) : 0;
  const sent = new Set<string>();
  if (imageInputs.length > 0) {
    if (maxReferences === 0) {
      // Nothing is sent anyway, so per-image readiness is not reported.
      warnings.push({ kind: 'refs-ignored-by-model', count: imageInputs.length });
    } else {
      const ready: CollectedGeneratorInput[] = [];
      for (const input of imageInputs) {
        if (input.image?.daemonReady) ready.push(input);
        else warnings.push({ kind: 'reference-not-ready', nodeId: input.nodeId });
      }
      if (ready.length > maxReferences) {
        warnings.push({ kind: 'refs-truncated', kept: maxReferences, total: ready.length });
      }
      for (const input of ready.slice(0, maxReferences)) sent.add(input.nodeId);
    }
  }

  // Step 5: rewrite tokens.
  const replaceInput = (nodeId: string): string => {
    const input = inputById.get(nodeId);
    const label = labelById.get(nodeId);
    if (!input || label === undefined) return '';
    if (input.kind === 'text') return labels.textMention(label);
    return sent.has(nodeId) ? label : labels.quote(input.title || label);
  };
  const replaceToken = (id: string): string => {
    if (inputById.has(id)) return replaceInput(id);
    const members = groupMembers.get(id);
    if (members) return members.map(replaceInput).filter(Boolean).join(labels.separator);
    return '';
  };
  const body = rewriteGenerationTokens(promptSource, replaceToken).trim();

  // Step 6: assemble.
  const references = imageInputs
    .filter((input) => sent.has(input.nodeId))
    .map((input) => ({ nodeId: input.nodeId, path: input.image?.path ?? '', label: labelById.get(input.nodeId) ?? '' }));
  const texts = labelOrder
    .filter((input) => input.kind === 'text')
    .map((input) => ({ nodeId: input.nodeId, label: labelById.get(input.nodeId) ?? '', text: input.text ?? '' }));
  const prefix = references.length >= 2 ? `${labels.prefix(references.map((ref) => ref.label))}\n\n` : '';
  const textBlocks = texts.length
    ? `\n\n${texts.map((entry) => labels.textBlock(entry.label, entry.text)).join('\n\n')}`
    : '';
  const prompt = `${prefix}${body}${textBlocks}`.trim();

  // Step 7: block.
  let blockReason: CompileBlockReason | undefined;
  if (options.requiresReference && references.length === 0) blockReason = 'needs-reference';
  else if (prompt === '' && references.length === 0) blockReason = 'empty-prompt';

  const compiledInputs = labelOrder.map((input): CompiledInput => {
    const compiled: CompiledInput = {
      nodeId: input.nodeId,
      kind: input.kind,
      label: labelById.get(input.nodeId) ?? '',
      mentioned: mentioned.has(input.nodeId),
      sent: input.kind === 'text' ? true : sent.has(input.nodeId),
    };
    if (input.title) compiled.title = input.title;
    if (input.image) compiled.image = mediaFileOf(input.image);
    if (input.text !== undefined) compiled.text = input.text;
    return compiled;
  });

  const result: CompiledGeneration = {
    ok: blockReason === undefined,
    prompt,
    references,
    texts,
    inputs: compiledInputs,
    warnings,
  };
  if (blockReason !== undefined) result.blockReason = blockReason;
  return result;
}

// ===========================================================================
// 3.2.4 Renderer and parameter support (single source for web + CLI)
// ===========================================================================

/** Mirrors media/index.ts:611-816; 'hyperframes' and 'stub' deliberately excluded. */
export const GENERATION_RENDERED_PROVIDERS: Readonly<Record<GenerationSurface, readonly string[]>> = Object.freeze({
  image: Object.freeze([
    'openai',
    'custom-image',
    'aihubmix',
    'volcengine',
    'grok',
    'nanobanana',
    'imagerouter',
    'openrouter',
    'leonardo',
    'minimax',
    'senseaudio',
    'fal',
    'tokentosea',
    'bfl', 'replicate', 'google', 'midjourney', 'comfyui',
  ]),
  video: Object.freeze(['volcengine', 'grok', 'openrouter', 'imagerouter', 'aihubmix', 'fal', 'tokentosea', 'google', 'kling', 'comfyui']),
});

/** Renderers that actually read reference images (F10). Absent provider = 0. */
export const GENERATION_REFERENCE_LIMITS: Readonly<Record<GenerationSurface, Readonly<Record<string, number>>>> =
  Object.freeze({
    image: Object.freeze({ tokentosea: 5, 'custom-image': 1, minimax: 1, senseaudio: 1, bfl: 1, google: 1, replicate: 1, midjourney: 1, comfyui: 1 }),
    video: Object.freeze({ tokentosea: 5, volcengine: 1, grok: 1, openrouter: 9, aihubmix: 1, fal: 1, google: 1, kling: 1, comfyui: 1 }),
  });

export interface ModelVariantGroup {
  baseId: string;
  label: string;
  provider: string;
  byResolution: Readonly<Record<string, string>>;
  defaultResolution: string;
}
export const MODEL_VARIANT_GROUPS: readonly ModelVariantGroup[] = Object.freeze([
  Object.freeze({
    baseId: 'openrouter/bytedance/seedance-2.0',
    label: 'seedance-2.0 (OR)',
    provider: 'openrouter',
    byResolution: Object.freeze({
      '480p': 'openrouter/bytedance/seedance-2.0:480p',
      '720p': 'openrouter/bytedance/seedance-2.0',
      '1080p': 'openrouter/bytedance/seedance-2.0:1080p',
    }),
    defaultResolution: '720p',
  }),
]);

/** true only together with daemon edit D-1 / D-1b (§9); false hides the control. */
export const DAEMON_SUPPORTS_GPT_IMAGE_QUALITY: boolean = true;
export const DAEMON_SUPPORTS_NANOBANANA_SIZE: boolean = true;

export interface GenerationParamSupport {
  usable: boolean;
  aspects: readonly MediaAspect[];
  lengths?: readonly number[];
  qualities?: readonly string[];
  defaultQuality?: string;
  resolutions?: readonly string[];
  defaultResolution?: string;
  maxReferences: number;
  requiresReference: boolean;
}

const VELA_VIDEO_ASPECTS: readonly MediaAspect[] = Object.freeze(['16:9', '9:16', '1:1']);
const VELA_VIDEO_LENGTHS: readonly number[] = Object.freeze([5, 10]);
/** apps/web/src/media/models.ts:667 */
const VIDEO_LENGTHS: readonly number[] = Object.freeze([3, 5, 8, 10, 15, 30]);
const GPT_IMAGE_QUALITIES: readonly string[] = Object.freeze(['high', 'medium', 'low', 'auto']);
const NANOBANANA_RESOLUTIONS: readonly string[] = Object.freeze(['1K', '2K', '4K']);

/**
 * Parameter support of one model on one surface (spec 05 §3.2.4 rules). `usable` additionally
 * requires the model to list a capability of the surface (`t2*` or `i2*`). For a variant id of a
 * {@link ModelVariantGroup}, the default resolution is that variant's own resolution.
 */
export function paramSupportFor(
  model: { id: string; provider: string; caps: readonly string[] },
  surface: GenerationSurface,
): GenerationParamSupport {
  if (model.provider === 'vela') model = { ...model, provider: 'tokentosea', id: model.id.replace(/^vela\//, 'tokentosea/') };
  const t2 = surface === 'image' ? 't2i' : 't2v';
  const i2 = surface === 'image' ? 'i2i' : 'i2v';
  const hasT2 = model.caps.includes(t2);
  const hasI2 = model.caps.includes(i2);
  const maxReferences = hasI2 ? (GENERATION_REFERENCE_LIMITS[surface][model.provider] ?? 0) : 0;
  const requiresReference = hasI2 && !hasT2;
  const usable =
    GENERATION_RENDERED_PROVIDERS[surface].includes(model.provider) &&
    model.id !== HYPERFRAMES_VIDEO_MODEL &&
    (hasT2 || hasI2) &&
    !(requiresReference && maxReferences === 0);
  const support: GenerationParamSupport = {
    usable,
    aspects: surface === 'video' && model.provider === 'tokentosea' ? VELA_VIDEO_ASPECTS : MEDIA_ASPECT_VALUES,
    maxReferences,
    requiresReference,
  };
  if (surface === 'video') {
    support.lengths = model.provider === 'tokentosea' ? VELA_VIDEO_LENGTHS : VIDEO_LENGTHS;
    if (model.provider === 'google') {
      if (model.id.startsWith('veo-')) support.lengths = [8];
      else delete support.lengths;
    }
    if (model.provider === 'kling') support.lengths = model.id.startsWith('kling-3') ? [3, 5, 8, 10, 15] : [5, 10];
  }
  if (
    surface === 'image' &&
    DAEMON_SUPPORTS_GPT_IMAGE_QUALITY &&
    ((model.provider === 'openai' && model.id.startsWith('gpt-image-')) ||
      (model.provider === 'aihubmix' && model.id.includes('gpt-image')))
  ) {
    support.qualities = GPT_IMAGE_QUALITIES;
    support.defaultQuality = 'high';
  }
  if (surface === 'image' && model.provider === 'nanobanana' && DAEMON_SUPPORTS_NANOBANANA_SIZE) {
    support.resolutions = NANOBANANA_RESOLUTIONS;
    support.defaultResolution = '1K';
  }
  const group = surface === 'video' ? variantGroupFor(model.id) : null;
  if (group) {
    support.resolutions = Object.keys(group.byResolution);
    support.defaultResolution = variantResolutionOf(group, model.id) ?? group.defaultResolution;
  }
  return support;
}

/** The variant group of a base id or of any of its variant ids. */
export function variantGroupFor(modelId: string): ModelVariantGroup | null {
  for (const group of MODEL_VARIANT_GROUPS) {
    if (group.baseId === modelId || Object.values(group.byResolution).includes(modelId)) return group;
  }
  return null;
}

/**
 * The model id to send for a picker id and a resolution: the group's variant for `resolution`
 * (case-insensitive). With an absent/unknown resolution a variant id is kept as is and a base id
 * resolves to the group default. Ids outside any group are returned unchanged.
 */
export function resolveModelVariant(baseId: string, resolution: string | undefined): string {
  const group = variantGroupFor(baseId);
  if (!group) return baseId;
  const key = resolution === undefined ? undefined : matchOption(resolution, Object.keys(group.byResolution));
  if (key !== undefined) return group.byResolution[key] ?? baseId;
  if (Object.values(group.byResolution).includes(baseId)) return baseId;
  return group.byResolution[group.defaultResolution] ?? group.baseId;
}

/**
 * Surface defaults (image `{aspect:'1:1', count:2}`, video `{aspect:'16:9', count:1, length:5}`),
 * overridden by `prefs`, then {@link clampParams}.
 */
export function defaultParamsFor(
  surface: GenerationSurface,
  support: GenerationParamSupport,
  prefs?: Partial<GeneratorParams>,
): GeneratorParams {
  const merged: GeneratorParams = surfaceDefaultParams(surface);
  if (prefs) {
    if (prefs.aspect !== undefined) merged.aspect = prefs.aspect;
    if (prefs.count !== undefined) merged.count = prefs.count;
    if (prefs.length !== undefined) merged.length = prefs.length;
    if (prefs.quality !== undefined) merged.quality = prefs.quality;
    if (prefs.resolution !== undefined) merged.resolution = prefs.resolution;
  }
  return clampParams(merged, support, surface);
}

/**
 * Makes params valid for `support`: the aspect snaps to the nearest supported ratio (ties keep the
 * orientation), count → 1..4, video length snaps to the nearest supported value (missing → 5),
 * quality/resolution keep a supported value (case-insensitive) or take the default, and unsupported
 * `length` (image) / `quality` / `resolution` are dropped. Idempotent.
 */
export function clampParams(
  params: GeneratorParams,
  support: GenerationParamSupport,
  surface: GenerationSurface,
): GeneratorParams {
  const out: GeneratorParams = {
    aspect: snapAspect(params.aspect, support.aspects, surface),
    count: clampCount(params.count, surface),
  };
  if (surface === 'video' && support.lengths && support.lengths.length > 0) {
    const requested = typeof params.length === 'number' && Number.isFinite(params.length) ? params.length : DEFAULT_VIDEO_LENGTH;
    out.length = snapNumber(requested, support.lengths);
  }
  if (support.qualities && support.qualities.length > 0) {
    const quality =
      (params.quality === undefined ? undefined : matchOption(params.quality, support.qualities)) ??
      support.defaultQuality ??
      support.qualities[0];
    if (quality !== undefined) out.quality = quality;
  }
  if (support.resolutions && support.resolutions.length > 0) {
    const resolution =
      (params.resolution === undefined ? undefined : matchOption(params.resolution, support.resolutions)) ??
      support.defaultResolution ??
      support.resolutions[0];
    if (resolution !== undefined) out.resolution = resolution;
  }
  return out;
}

// ===========================================================================
// 3.2.5 Naming, sizing, placement
// ===========================================================================

/** FNV-1a 32-bit over the UTF-8 bytes → base36, left-padded, last 6 chars. */
export function shortGenerationId(id: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/**
 * `gen-${short(generatorId)}-${short(runId)}-${index + 1}${attempt > 0 ? `r${attempt}` : ''}${surface === 'image' ? '.png' : '.mp4'}`
 * — flat (no '/'), safe for the daemon's `sanitizeName`, unique per slot and attempt.
 */
export function generationOutputName(i: {
  generatorId: string;
  runId: string;
  index: number;
  attempt: number;
  surface: GenerationSurface;
}): string {
  const retry = i.attempt > 0 ? `r${i.attempt}` : '';
  const ext = i.surface === 'image' ? '.png' : '.mp4';
  return `gen-${shortGenerationId(i.generatorId)}-${shortGenerationId(i.runId)}-${i.index + 1}${retry}${ext}`;
}

/** Basename without the last extension (a leading dot is not an extension, like the daemon). */
export function outputStemOf(fileName: string): string {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Board minimum node edge (04 BOARD_LIMITS.minNodeSize). */
const MEDIA_NODE_MIN_EDGE = 8;

/**
 * Long edge 320 (image) / 384 (video), short edge = round(long × ratio), never below the board's
 * minimum node size. Invalid dimensions are treated as 1:1.
 */
export function mediaNodeSizeFor(
  surface: GenerationSurface,
  aspect: MediaAspect | { width: number; height: number },
): { w: number; h: number } {
  const long = surface === 'image' ? 320 : 384;
  let ratio = typeof aspect === 'string' ? ratioOfAspect(aspect) : aspect.width / aspect.height;
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;
  if (ratio >= 1) return { w: long, h: Math.max(MEDIA_NODE_MIN_EDGE, Math.round(long / ratio)) };
  return { w: Math.max(MEDIA_NODE_MIN_EDGE, Math.round(long * ratio)), h: long };
}

/**
 * Moves `rect` down by (h + stepY) until it overlaps no non-group node (margin
 * `GENERATION_LIMITS.placementMargin`); after `maxSteps` (50) moves returns the last position.
 */
export function findFreePlacement(
  graph: GenerationGraph,
  rect: { x: number; y: number; w: number; h: number },
  options?: { stepY?: number | undefined; maxSteps?: number | undefined; ignoreIds?: string[] | undefined },
): { x: number; y: number } {
  const stepY = options?.stepY ?? GENERATION_LIMITS.placementStepY;
  const maxSteps = Math.max(0, Math.floor(options?.maxSteps ?? 50));
  const ignore = new Set(options?.ignoreIds ?? []);
  const margin = GENERATION_LIMITS.placementMargin;
  const obstacles = graph.nodes.filter((node) => node.kind !== 'group' && !ignore.has(node.id));
  let y = rect.y;
  for (let step = 0; step < maxSteps; step++) {
    const candidate = { x: rect.x, y, w: rect.w, h: rect.h };
    if (!obstacles.some((node) => rectsOverlap(candidate, node, margin))) return { x: rect.x, y };
    y += rect.h + stepY;
  }
  return { x: rect.x, y };
}

// ===========================================================================
// 3.2.6 Run planning, patches, reducers
// ===========================================================================

export interface PlanRunInput {
  graph: GenerationGraph;
  generatorId: string;
  /** ok === true */
  compiled: CompiledGeneration;
  /** Base id. */
  model: { id: string; provider: string; caps: readonly string[] };
  /** Already clamped. */
  params: GeneratorParams;
  support: GenerationParamSupport;
  now: number;
  ids: { next(): string };
  /** Caller computes (§4.6). */
  title: string;
  templateId?: string | undefined;
}
export interface PlannedRun {
  runId: string;
  outputNodeId: string;
  request: GenerationRequestRecord;
  /** node.add(R) + edge.add(G→R,'output') + node.patchData(G,{runs, model}) */
  ops: GenerationBoardOp[];
  slots: Array<{ candidateId: string; request: MediaGenerateRequest }>;
}

/**
 * Plans one run of a generator (spec 05 §3.2.6). Ids from `ids.next()` in this order: runId,
 * outputNodeId, one per candidate, the output edge. The output node R is placed right of G
 * (`outputGapX`) and moved down until free; `G.runs` gets the summary prepended (≤ runHistory) and
 * `G.model` the picker (base) id. Params are re-clamped (idempotent).
 *
 * @throws Error when `compiled.ok` is false or `generatorId` is not a generator node of `graph`.
 */
export function planGenerationRun(input: PlanRunInput): PlannedRun {
  const { graph, generatorId, compiled, model, support, now, ids } = input;
  if (!compiled.ok) {
    throw new Error(`planGenerationRun: generation is blocked (${compiled.blockReason ?? 'unknown'})`);
  }
  const generatorNode = graph.nodes.find((node) => node.id === generatorId);
  const generator = generatorNode?.kind === 'generator' ? generatorNode.generator : undefined;
  if (!generatorNode || !generator) {
    throw new Error(`planGenerationRun: generator node "${generatorId}" not found`);
  }
  const surface = generator.surface;
  const params = clampParams(input.params, support, surface);
  const group = variantGroupFor(model.id);
  const modelBase = group ? group.baseId : model.id;
  const sentModel = resolveModelVariant(model.id, params.resolution);

  const runId = ids.next();
  const outputNodeId = ids.next();
  const candidateIds = Array.from({ length: params.count }, () => ids.next());
  const edgeId = ids.next();

  const request: GenerationRequestRecord = {
    surface,
    model: sentModel,
    modelBase,
    provider: model.provider,
    prompt: compiled.prompt,
    promptSource: generator.prompt,
    aspect: params.aspect,
    references: compiled.references.map((ref) => ({ ...ref })),
    generatorId,
    runId,
    createdAt: now,
  };
  if (params.quality !== undefined && support.qualities?.includes(params.quality)) request.quality = params.quality;
  if (params.resolution !== undefined && support.resolutions?.includes(params.resolution)) {
    request.resolution = params.resolution;
  }
  if (surface === 'video' && params.length !== undefined) request.length = params.length;
  if (input.templateId) request.templateId = input.templateId;

  const outputNames = candidateIds.map((_, index) =>
    generationOutputName({ generatorId, runId, index, attempt: 0, surface }),
  );
  const candidates = candidateIds.map(
    (id, index): GenerationCandidate => ({
      id,
      runId,
      index,
      attempt: 0,
      status: 'pending',
      outputStem: outputStemOf(outputNames[index] ?? ''),
    }),
  );
  const size = mediaNodeSizeFor(surface, params.aspect);
  const at = findFreePlacement(
    graph,
    { x: generatorNode.x + generatorNode.w + GENERATION_LIMITS.outputGapX, y: generatorNode.y, w: size.w, h: size.h },
    { ignoreIds: [generatorNode.id] },
  );
  const outputNode: GenerationNodeInput = {
    id: outputNodeId,
    kind: surface,
    x: at.x,
    y: at.y,
    w: size.w,
    h: size.h,
    title: input.title,
    data: { generation: { candidates, request: cloneJson(request), sizedToMedia: false } },
  };
  const summary: GeneratorRunSummary = {
    runId,
    outputNodeId,
    surface,
    model: sentModel,
    count: params.count,
    startedAt: now,
  };
  const ops: GenerationBoardOp[] = [
    { type: 'node.add', node: outputNode },
    { type: 'edge.add', edge: { id: edgeId, from: generatorId, to: outputNodeId, role: 'output' } },
    {
      type: 'node.patchData',
      id: generatorId,
      patch: { runs: [summary, ...generator.runs].slice(0, GENERATION_LIMITS.runHistory), model: modelBase },
    },
  ];
  const slots = candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    request: buildMediaGenerateRequest(request, outputNames[index] ?? ''),
  }));
  return { runId, outputNodeId, request, ops, slots };
}

/**
 * `{ surface, model, prompt, aspect, output, image: refs[0]?.path, images: refs.slice(1) (omitted when
 * empty), quality/resolution when recorded (resolution omitted for variant groups — encoded in the
 * model id), length only for video }`.
 */
export function buildMediaGenerateRequest(record: GenerationRequestRecord, outputName: string): MediaGenerateRequest {
  const request: MediaGenerateRequest = {
    surface: record.surface,
    model: record.model,
    prompt: record.prompt,
    output: outputName,
  };
  if (record.aspect !== undefined) request.aspect = record.aspect;
  const [primary, ...extras] = record.references;
  if (primary) request.image = primary.path;
  if (extras.length > 0) request.images = extras.map((ref) => ref.path);
  if (record.quality !== undefined) request.quality = record.quality;
  if (record.resolution !== undefined && !variantGroupFor(record.modelBase) && !variantGroupFor(record.model)) {
    request.resolution = record.resolution;
  }
  if (record.surface === 'video' && record.length !== undefined) request.length = record.length;
  return request;
}

/** Candidate patch; a key set to `undefined` clears that optional field (id/runId/index are fixed). */
export type CandidatePatch = { id: string } & GenerationDataPatch<Omit<GenerationCandidate, 'id' | 'runId' | 'index'>>;

/**
 * Retry of a `failed | interrupted | lost | stopped` candidate: same id, `attempt + 1`, new output
 * stem, status `pending`, and the previous attempt's task/result fields cleared. Null otherwise.
 */
export function planCandidateRetry(
  node: GenerationGraphNode,
  candidateId: string,
): { patch: CandidatePatch; request: MediaGenerateRequest } | null {
  const generation = node.media?.generation;
  const candidate = generation?.candidates.find((entry) => entry.id === candidateId);
  if (!generation || !candidate || !RETRYABLE_SLOT_STATUSES.has(candidate.status)) return null;
  const attempt = candidate.attempt + 1;
  const outputName = generationOutputName({
    generatorId: generation.request.generatorId,
    runId: candidate.runId,
    index: candidate.index,
    attempt,
    surface: generation.request.surface,
  });
  const patch: CandidatePatch = {
    id: candidate.id,
    status: 'pending',
    attempt,
    outputStem: outputStemOf(outputName),
    taskId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    file: undefined,
    error: undefined,
    warnings: undefined,
    providerNote: undefined,
    stub: undefined,
  };
  return { patch, request: buildMediaGenerateRequest(generation.request, outputName) };
}

/**
 * One more candidate with the node's recorded request. It gets a fresh run id (id order: run id,
 * candidate id) so its output name can never collide with an earlier or deleted candidate's file.
 * Null without a recorded request or at `maxCandidatesPerNode`.
 */
export function planMoreLikeThis(
  node: GenerationGraphNode,
  ids: { next(): string },
): { ops: GenerationBoardOp[]; candidateId: string; request: MediaGenerateRequest } | null {
  const generation = node.media?.generation;
  if (!generation || generation.candidates.length >= GENERATION_LIMITS.maxCandidatesPerNode) return null;
  const runId = ids.next();
  const candidateId = ids.next();
  const outputName = generationOutputName({
    generatorId: generation.request.generatorId,
    runId,
    index: 0,
    attempt: 0,
    surface: generation.request.surface,
  });
  const candidate: GenerationCandidate = {
    id: candidateId,
    runId,
    index: 0,
    attempt: 0,
    status: 'pending',
    outputStem: outputStemOf(outputName),
  };
  const next: MediaNodeGeneration = { ...generation, candidates: [...generation.candidates, candidate] };
  return {
    ops: [{ type: 'node.patchData', id: node.id, patch: { generation: next } }],
    candidateId,
    request: buildMediaGenerateRequest(generation.request, outputName),
  };
}

/** 202 accepted → `taskId` + status. A terminal status here is kept active (`running`): its file/error comes from the wait. */
export function candidatePatchFromAccepted(id: string, accepted: MediaGenerateAccepted): CandidatePatch {
  const patch: CandidatePatch = {
    id,
    taskId: accepted.taskId,
    status: isTerminalMediaTaskStatus(accepted.status) ? 'running' : accepted.status,
  };
  if (accepted.startedAt > 0) patch.startedAt = accepted.startedAt;
  return patch;
}

/**
 * Snapshot mapping: `queued/running` → same status + `startedAt`; `done` → `file = {path: file.name,
 * size, mtime, mime}`, `providerNote`, `warnings`, `stub`, `endedAt`; `failed` → `error` with
 * `nextStep ?? mediaFailureNextStep({...error, model})`; `interrupted` → `nextStep 'retry-later'`.
 * A `done` snapshot without a file maps to `failed` (`contact-support`). Progress is not persisted.
 */
export function candidatePatchFromSnapshot(id: string, s: MediaTaskSnapshotResponse, model: string): CandidatePatch {
  return patchFromTaskState(
    id,
    { taskId: s.taskId, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, file: s.file, error: s.error },
    model,
  );
}

/** Same mapping as {@link candidatePatchFromSnapshot} for a row of `GET /api/projects/:id/media/tasks`. */
export function candidatePatchFromTask(id: string, task: ProjectMediaTask, model: string): CandidatePatch {
  return patchFromTaskState(
    id,
    {
      taskId: task.taskId,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      file: task.file,
      error: task.error,
    },
    model,
  );
}

/**
 * POST error → `failed`. `TOOL_TOKEN_MISSING` (sandbox) → `{nextStep:'unsupported',
 * messageKey:'fantay.gen.sandbox'}`; otherwise `mediaFailureNextStep({code, status, message, model})`.
 */
export function candidatePatchFromHttpError(id: string, error: DaemonApiErrorInfo, model: string): CandidatePatch {
  const candidateError: GenerationCandidateError =
    error.code === 'TOOL_TOKEN_MISSING'
      ? { message: error.message, nextStep: 'unsupported', messageKey: 'fantay.gen.sandbox' }
      : {
          message: error.message,
          nextStep: mediaFailureNextStep({ code: error.code, status: error.status, message: error.message, model }),
        };
  if (error.code !== undefined) candidateError.code = error.code;
  if (error.status > 0) candidateError.status = error.status;
  return { id, status: 'failed', error: candidateError };
}

/** POST never answered (network) → `failed`, `retry-later`. */
export function candidatePatchNetworkError(id: string, message: string): CandidatePatch {
  return {
    id,
    status: 'failed',
    error: { message: message.trim() ? message : 'Network error', nextStep: 'retry-later', retryable: true },
  };
}

/**
 * Replaces the candidate by id. The first candidate to reach `done` (with a file) while no primary is
 * set becomes primary (`firstDone: true`); `file` always mirrors the primary candidate's file.
 * Unknown candidate / no generation → data unchanged.
 */
export function applyCandidatePatch(
  data: MediaNodeData,
  patch: CandidatePatch,
): { data: MediaNodeData; firstDone: boolean } {
  const generation = data.generation;
  const index = generation ? generation.candidates.findIndex((candidate) => candidate.id === patch.id) : -1;
  const current = generation?.candidates[index];
  if (!generation || !current) return { data, firstDone: false };
  const updated = mergeCandidate(current, patch);
  const candidates = generation.candidates.slice();
  candidates[index] = updated;
  const next: MediaNodeGeneration = { ...generation, candidates };
  let firstDone = false;
  if (generation.primaryCandidateId === undefined && updated.status === 'done' && updated.file) {
    next.primaryCandidateId = updated.id;
    firstDone = true;
  }
  return { data: withMirroredFile({ ...data, generation: next }), firstDone };
}

/** Sets the primary candidate (any existing candidate) and mirrors its file; unknown id → unchanged. */
export function setPrimaryCandidate(data: MediaNodeData, candidateId: string): MediaNodeData {
  const generation = data.generation;
  if (!generation || !generation.candidates.some((candidate) => candidate.id === candidateId)) return data;
  return withMirroredFile({ ...data, generation: { ...generation, primaryCandidateId: candidateId } });
}

/**
 * Removes a candidate; null when it is the last one (would empty). Removing the primary falls back to
 * the first done candidate (or none, clearing `file`). Unknown id / no generation → unchanged.
 */
export function removeCandidate(data: MediaNodeData, candidateId: string): MediaNodeData | null {
  const generation = data.generation;
  if (!generation || !generation.candidates.some((candidate) => candidate.id === candidateId)) return data;
  const candidates = generation.candidates.filter((candidate) => candidate.id !== candidateId);
  if (candidates.length === 0) return null;
  const next: MediaNodeGeneration = { ...generation, candidates };
  if (generation.primaryCandidateId !== candidateId) return { ...data, generation: next };
  const fallback = firstDoneCandidate(candidates);
  const nextData: MediaNodeData = { ...data, generation: next };
  if (fallback) {
    next.primaryCandidateId = fallback.id;
  } else {
    delete next.primaryCandidateId;
    delete nextData.file;
  }
  return withMirroredFile(nextData);
}

/**
 * Promotes a done candidate to its own node (copy semantics: the candidate stays in R). The new node
 * has R's kind and frame, placed under R (`findFreePlacement` from `y = R.y + R.h + placementStepY`),
 * `data {file}`; the edge comes from the generator (`request.generatorId`, role `output`) if it still
 * exists, else from R (role `derived`). Ids: new node, then edge. Null when not promotable.
 */
export function promoteCandidateOps(
  graph: GenerationGraph,
  nodeId: string,
  candidateId: string,
  ids: { next(): string },
  title: string,
): { ops: GenerationBoardOp[]; newNodeId: string } | null {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node || (node.kind !== 'image' && node.kind !== 'video')) return null;
  const generation = node.media?.generation;
  const candidate = generation?.candidates.find((entry) => entry.id === candidateId);
  if (!generation || !candidate || candidate.status !== 'done' || !candidate.file) return null;
  const at = findFreePlacement(graph, {
    x: node.x,
    y: node.y + node.h + GENERATION_LIMITS.placementStepY,
    w: node.w,
    h: node.h,
  });
  const newNodeId = ids.next();
  const edgeId = ids.next();
  const generatorId = generation.request.generatorId;
  const generatorExists = graph.nodes.some((entry) => entry.id === generatorId && entry.kind === 'generator');
  const edge: GenerationEdgeInput = generatorExists
    ? { id: edgeId, from: generatorId, to: newNodeId, role: 'output' }
    : { id: edgeId, from: node.id, to: newNodeId, role: 'derived' };
  return {
    newNodeId,
    ops: [
      {
        type: 'node.add',
        node: {
          id: newNodeId,
          kind: node.kind,
          x: at.x,
          y: at.y,
          w: node.w,
          h: node.h,
          title,
          data: { file: { ...candidate.file } },
        },
      },
      { type: 'edge.add', edge },
    ],
  };
}

/** `pending | queued | running`. */
export function isActiveSlot(status: GenerationSlotStatus): boolean {
  return status === 'pending' || status === 'queued' || status === 'running';
}

export interface GeneratorRunState {
  active: boolean;
  runId?: string;
  outputNodeId?: string;
  outputMissing: boolean;
  total: number;
  counts: Record<GenerationSlotStatus, number>;
  startedAt?: number;
  firstError?: GenerationCandidateError;
}

/**
 * State of the generator's latest run (`runs[0]`): the candidates of that run on its output node
 * (more-like-this candidates carry their own run id and are not counted). `outputMissing` when the
 * output node is gone.
 */
export function generatorRunState(graph: GenerationGraph, generatorId: string): GeneratorRunState {
  const counts = emptySlotCounts();
  const generatorNode = graph.nodes.find((node) => node.id === generatorId);
  const run = generatorNode?.kind === 'generator' ? generatorNode.generator?.runs[0] : undefined;
  if (!run) return { active: false, outputMissing: false, total: 0, counts };
  const outputNode = graph.nodes.find((node) => node.id === run.outputNodeId);
  const state: GeneratorRunState = {
    active: false,
    runId: run.runId,
    outputNodeId: run.outputNodeId,
    outputMissing: !outputNode,
    total: 0,
    counts,
    startedAt: run.startedAt,
  };
  const candidates = (outputNode?.media?.generation?.candidates ?? [])
    .filter((candidate) => candidate.runId === run.runId)
    .sort((a, b) => a.index - b.index);
  for (const candidate of candidates) {
    if (!(candidate.status in counts)) continue;
    counts[candidate.status] += 1;
    if (isActiveSlot(candidate.status)) state.active = true;
    if (!state.firstError && candidate.error && (candidate.status === 'failed' || candidate.status === 'interrupted')) {
      state.firstError = candidate.error;
    }
  }
  state.total = candidates.length;
  return state;
}

// ===========================================================================
// 3.2.7 Prompt template arguments
// ===========================================================================

export interface TemplateArgument {
  name: string;
  defaultValue: string;
}
/** Global: callers must not share its `lastIndex`. */
export const TEMPLATE_ARGUMENT_PATTERN = /\{argument\s+name="([^"]*)"\s+default="([^"]*)"\s*\}/g;

/** Arguments in order of first appearance; dedupe by name, first default wins; empty names skipped. */
export function parseTemplateArguments(prompt: string): TemplateArgument[] {
  const seen = new Set<string>();
  const result: TemplateArgument[] = [];
  for (const match of prompt.matchAll(new RegExp(TEMPLATE_ARGUMENT_PATTERN.source, 'g'))) {
    const name = match[1] ?? '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, defaultValue: match[2] ?? '' });
  }
  return result;
}

/** Replaces every argument with `values[name] ?? default` (the first default of that name). */
export function fillTemplateArguments(prompt: string, values: Record<string, string>): string {
  const defaults = new Map(parseTemplateArguments(prompt).map((arg) => [arg.name, arg.defaultValue]));
  return prompt.replace(new RegExp(TEMPLATE_ARGUMENT_PATTERN.source, 'g'), (_match, name: string, fallback: string) => {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (typeof value === 'string') return value;
    return defaults.get(name) ?? fallback;
  });
}

// ===========================================================================
// internals
// ===========================================================================

const DEFAULT_VIDEO_LENGTH = 5;
const RETRYABLE_SLOT_STATUSES: ReadonlySet<GenerationSlotStatus> = new Set(['failed', 'interrupted', 'lost', 'stopped']);
const COPYABLE_SLOT_STATUSES: ReadonlySet<GenerationSlotStatus> = new Set(['done', 'failed', 'interrupted', 'lost']);
const REQUIRED_CANDIDATE_KEYS: ReadonlySet<string> = new Set(['status', 'attempt', 'outputStem']);
const FIXED_CANDIDATE_KEYS: ReadonlySet<string> = new Set(['id', 'runId', 'index']);

function surfaceDefaultParams(surface: GenerationSurface): GeneratorParams {
  return surface === 'image' ? { aspect: '1:1', count: 2 } : { aspect: '16:9', count: 1, length: DEFAULT_VIDEO_LENGTH };
}

/** Defaults + partial, sanitized without model knowledge (used for new generator nodes). */
function normalizeGeneratorParams(surface: GenerationSurface, partial: Partial<GeneratorParams> | undefined): GeneratorParams {
  const params = surfaceDefaultParams(surface);
  if (!partial) return params;
  if (partial.aspect !== undefined && MEDIA_ASPECT_VALUES.includes(partial.aspect)) params.aspect = partial.aspect;
  if (partial.count !== undefined) params.count = clampCount(partial.count, surface);
  if (surface === 'video' && typeof partial.length === 'number' && Number.isFinite(partial.length) && partial.length > 0) {
    params.length = partial.length;
  }
  if (typeof partial.quality === 'string' && partial.quality.trim()) params.quality = partial.quality;
  if (typeof partial.resolution === 'string' && partial.resolution.trim()) params.resolution = partial.resolution;
  return params;
}

function clampCount(count: unknown, surface: GenerationSurface): GeneratorParams['count'] {
  const value = Math.round(Number(count));
  if (!Number.isFinite(value)) return surfaceDefaultParams(surface).count;
  return Math.min(GENERATION_LIMITS.maxCount, Math.max(1, value)) as GeneratorParams['count'];
}

function ratioOfAspect(aspect: string): number {
  const [w, h] = aspect.split(':').map((part) => Number(part));
  return w !== undefined && h !== undefined && h > 0 ? w / h : Number.NaN;
}

function snapAspect(aspect: MediaAspect, allowed: readonly MediaAspect[], surface: GenerationSurface): MediaAspect {
  if (allowed.includes(aspect)) return aspect;
  const fallback = surfaceDefaultParams(surface).aspect;
  if (allowed.length === 0) return MEDIA_ASPECT_VALUES.includes(aspect) ? aspect : fallback;
  const target = Math.log(ratioOfAspect(aspect));
  if (!Number.isFinite(target)) return allowed.includes(fallback) ? fallback : (allowed[0] ?? fallback);
  let best: MediaAspect | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestSameOrientation = false;
  for (const option of allowed) {
    const logRatio = Math.log(ratioOfAspect(option));
    const distance = Math.abs(logRatio - target);
    const sameOrientation = Math.sign(logRatio) === Math.sign(target);
    const closer = distance < bestDistance - 1e-9;
    const tie = Math.abs(distance - bestDistance) <= 1e-9;
    if (best === undefined || closer || (tie && sameOrientation && !bestSameOrientation)) {
      best = option;
      bestDistance = distance;
      bestSameOrientation = sameOrientation;
    }
  }
  return best ?? fallback;
}

/** Nearest allowed value; ties keep the earlier one (same rule as the daemon's clampNumber). */
function snapNumber(value: number, allowed: readonly number[]): number {
  let best = allowed[0] ?? value;
  for (const option of allowed) {
    if (option === value) return option;
    if (Math.abs(value - option) < Math.abs(value - best)) best = option;
  }
  return best;
}

/** Case-insensitive match returning the canonical option. */
function matchOption(value: string, options: readonly string[]): string | undefined {
  if (options.includes(value)) return value;
  const lowered = value.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === lowered);
}

function variantResolutionOf(group: ModelVariantGroup, modelId: string): string | undefined {
  if (modelId === group.baseId && group.byResolution[group.defaultResolution] === group.baseId) {
    return group.defaultResolution;
  }
  return Object.keys(group.byResolution).find((key) => group.byResolution[key] === modelId);
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  margin: number,
): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

function indexNodes(graph: GenerationGraph): Map<string, GenerationGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function generationTokenRegExp(): RegExp {
  return new RegExp(GENERATION_TOKEN_PATTERN.source, 'g');
}

function inputFromNode(node: GenerationGraphNode, viaGroupId?: string): CollectedGeneratorInput | null {
  let input: CollectedGeneratorInput | null = null;
  if ((node.kind === 'image' || node.kind === 'other') && node.image) {
    input = { nodeId: node.id, kind: 'image', image: node.image };
  } else if (node.kind === 'note') {
    const text = (node.text ?? '').trim();
    if (text) input = { nodeId: node.id, kind: 'text', text };
  }
  if (!input) return null;
  if (node.title) input.title = node.title;
  if (viaGroupId !== undefined) input.viaGroupId = viaGroupId;
  return input;
}

function collectInputsDetailed(
  graph: GenerationGraph,
  generatorId: string,
): { inputs: CollectedGeneratorInput[]; warnings: CompileWarning[]; groupMembers: Map<string, string[]> } {
  const byId = indexNodes(graph);
  const edges = graph.edges
    .filter((edge) => edge.to === generatorId && edge.role === 'reference')
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inputs: CollectedGeneratorInput[] = [];
  const seen = new Set<string>();
  const warnings: CompileWarning[] = [];
  const warned = new Set<string>();
  const groupMembers = new Map<string, string[]>();
  const add = (input: CollectedGeneratorInput): void => {
    if (seen.has(input.nodeId)) return;
    seen.add(input.nodeId);
    inputs.push(input);
  };
  const warnIneligible = (nodeId: string): void => {
    if (warned.has(nodeId)) return;
    warned.add(nodeId);
    warnings.push({ kind: 'ineligible-input', nodeId });
  };
  for (const edge of edges) {
    const source = byId.get(edge.from);
    if (!source) continue;
    if (source.kind === 'group') {
      if (groupMembers.has(source.id)) continue;
      const members: string[] = [];
      for (const memberId of source.memberIds ?? []) {
        const member = byId.get(memberId);
        const input = member ? inputFromNode(member, source.id) : null;
        if (!input || members.includes(input.nodeId)) continue;
        members.push(input.nodeId);
        add(input);
      }
      groupMembers.set(source.id, members);
      if (members.length === 0) warnIneligible(source.id);
      continue;
    }
    const input = inputFromNode(source);
    if (input) add(input);
    else warnIneligible(source.id);
  }
  return { inputs, warnings, groupMembers };
}

/**
 * Replaces every `@[node:id]` token; a token replaced by '' collapses the spaces around it into one
 * (none at a line start/end), so removals do not leave runs of spaces.
 */
function rewriteGenerationTokens(source: string, replace: (id: string) => string): string {
  let out = '';
  let pendingRemoval = false;
  let pendingSpace = false;
  const appendText = (raw: string): void => {
    let text = raw;
    if (!text) return;
    if (pendingRemoval) {
      const leading = /^[ \t]*/.exec(text)?.[0] ?? '';
      if (leading) pendingSpace = true;
      text = text.slice(leading.length);
      if (!text) return;
      const atLineStart = out === '' || /[\r\n]$/.test(out);
      const atLineEnd = /^[\r\n]/.test(text);
      if (pendingSpace && !atLineStart && !atLineEnd) out += ' ';
      pendingRemoval = false;
      pendingSpace = false;
    }
    out += text;
  };
  const markRemoval = (): void => {
    const trailing = /[ \t]*$/.exec(out)?.[0] ?? '';
    if (trailing) {
      out = out.slice(0, out.length - trailing.length);
      pendingSpace = true;
    }
    pendingRemoval = true;
  };
  let last = 0;
  for (const match of source.matchAll(generationTokenRegExp())) {
    const start = match.index ?? 0;
    appendText(source.slice(last, start));
    const replacement = replace(match[1] ?? '');
    if (replacement) appendText(replacement);
    else markRemoval();
    last = start + match[0].length;
  }
  appendText(source.slice(last));
  return out;
}

function mediaFileOf(image: BoardMediaFile & { daemonReady?: boolean }): BoardMediaFile {
  const { daemonReady: _daemonReady, ...file } = image;
  return file;
}

function firstDoneCandidate(candidates: readonly GenerationCandidate[]): GenerationCandidate | undefined {
  return candidates.find((candidate) => candidate.status === 'done' && candidate.file !== undefined);
}

/** `file` mirrors the primary candidate's file (removed when the primary has none). */
function withMirroredFile(data: MediaNodeData): MediaNodeData {
  const generation = data.generation;
  if (!generation || generation.primaryCandidateId === undefined) return data;
  const primary = generation.candidates.find((candidate) => candidate.id === generation.primaryCandidateId);
  if (!primary) return data;
  const next: MediaNodeData = { ...data };
  if (primary.file) next.file = { ...primary.file };
  else delete next.file;
  return next;
}

function mergeCandidate(current: GenerationCandidate, patch: CandidatePatch): GenerationCandidate {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (FIXED_CANDIDATE_KEYS.has(key)) continue;
    if (value === undefined) {
      if (!REQUIRED_CANDIDATE_KEYS.has(key)) delete next[key];
      continue;
    }
    next[key] = value;
  }
  return next as unknown as GenerationCandidate;
}

function emptySlotCounts(): Record<GenerationSlotStatus, number> {
  return { pending: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, stopped: 0, lost: 0 };
}

type TaskState = {
  taskId: string;
  status: MediaTaskStatus;
  startedAt: number;
  endedAt: number | null;
  file: ProjectMediaTaskFile | MediaTaskFileRecord | null | undefined;
  error: ProjectMediaTaskError | null | undefined;
};

function patchFromTaskState(id: string, state: TaskState, model: string): CandidatePatch {
  const patch: CandidatePatch = { id, taskId: state.taskId, status: state.status };
  if (state.startedAt > 0) patch.startedAt = state.startedAt;
  if (state.status === 'queued' || state.status === 'running') return patch;
  if (typeof state.endedAt === 'number' && Number.isFinite(state.endedAt)) patch.endedAt = state.endedAt;
  if (state.status === 'done') {
    const file = state.file;
    if (!file || !file.name) {
      patch.status = 'failed';
      patch.error = {
        message: 'The task finished without reporting an output file.',
        nextStep: 'contact-support',
        code: 'MEDIA_OUTPUT_MISSING',
      };
      return patch;
    }
    const boardFile: BoardMediaFile = { path: file.name };
    if (typeof file.size === 'number') boardFile.size = file.size;
    if (typeof file.mtime === 'number') boardFile.mtime = file.mtime;
    if (typeof file.mime === 'string') boardFile.mime = file.mime;
    patch.file = boardFile;
    patch.error = undefined;
    const record = file as MediaTaskFileRecord;
    if (typeof record.providerNote === 'string' && record.providerNote) patch.providerNote = record.providerNote;
    if (Array.isArray(record.warnings) && record.warnings.length > 0) patch.warnings = [...record.warnings];
    if (record.usedStubFallback === true || record.intentionalStub === true) patch.stub = true;
    return patch;
  }
  if (state.status === 'interrupted') {
    patch.error = { ...candidateErrorFrom(state.error, model, 'The generation was interrupted.'), nextStep: 'retry-later' };
    return patch;
  }
  patch.error = candidateErrorFrom(state.error, model, 'The generation failed.');
  return patch;
}

function candidateErrorFrom(
  error: ProjectMediaTaskError | null | undefined,
  model: string,
  fallbackMessage: string,
): GenerationCandidateError {
  const message = error?.message?.trim() ? error.message : fallbackMessage;
  const nextStep =
    error?.nextStep !== undefined && (MEDIA_FAILURE_NEXT_STEPS as readonly string[]).includes(error.nextStep)
      ? error.nextStep
      : mediaFailureNextStep({
          code: error?.code,
          status: error?.status,
          message: error?.message,
          retryable: error?.retryable,
          model,
        });
  const result: GenerationCandidateError = { message, nextStep };
  if (error?.code !== undefined) result.code = error.code;
  if (error?.status !== undefined) result.status = error.status;
  if (error?.retryable !== undefined) result.retryable = error.retryable;
  if (error?.subject !== undefined) result.subject = error.subject;
  return result;
}

function isPlainProjectPath(path: string): boolean {
  if (!path || path !== path.trim()) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  return !path.split('/').includes('..');
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
