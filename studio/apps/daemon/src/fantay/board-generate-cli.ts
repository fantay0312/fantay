// SPDX-License-Identifier: Apache-2.0
// `od board generate` — run a board generator node from the CLI (spec 05 §8, plan R4, amendments B7/C8).
// UI/CLI dual track: the same daemon endpoints as the workspace generation service — the board through
// `GET`/`PATCH /api/projects/:id/board` contract ops (R4: not PUT), media through
// `POST /api/projects/:id/media/generate` and `POST /api/media/tasks/:id/wait` — and the same pure model in
// `@open-design/contracts` (compiler, param tables, run planning, candidate reducers). Board writes are
// read-modify-write with a revision check and up to five attempts on 409.
//
// Loaded on demand by `od board generate` (board-cli.ts, amendment B7). Exit codes: 0 ok (≥ 1 done, none
// running), 2 usage / invalid request, 64 daemon not running, 67 no project, 68 project not found,
// 72 board revision conflict, 73 still running at --timeout (or --no-wait), 74 every candidate failed,
// 1 anything else.

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  BOARD_GENERATOR_SURFACES,
  GENERATION_EDGE_ROLE_TO_BOARD_KIND,
  GENERATION_LIMITS,
  MEDIA_ASPECT_VALUES,
  MEDIA_TASK_WAIT_MAX_TIMEOUT_MS,
  applyCandidatePatch,
  boardApiPath,
  boardKindForPath,
  candidatePatchFromAccepted,
  candidatePatchFromHttpError,
  candidatePatchFromSnapshot,
  candidatePatchNetworkError,
  clampParams,
  compileGeneration,
  createGeneratorNodeInput,
  findFreePlacement,
  generationEdgeRoleFromBoardKind,
  generatorRunState,
  isActiveSlot,
  isBoardId,
  isDaemonReadyImage,
  isTerminalMediaTaskStatus,
  outputStemOf,
  paramSupportFor,
  parseDaemonApiError,
  parseMediaGenerateAccepted,
  parseMediaTaskSnapshot,
  planGenerationRun,
  referenceLabelSetFor,
  type BoardActor,
  type BoardDocument,
  type BoardGetResponse,
  type BoardMediaFile,
  type BoardNode,
  type BoardNodeDraft,
  type BoardNodePatch,
  type BoardOp,
  type BoardPatchResponse,
  type CandidatePatch,
  type CompileWarning,
  type GenerationBoardOp,
  type GenerationCandidate,
  type GenerationCandidateError,
  type GenerationGraph,
  type GenerationGraphNode,
  type GenerationParamSupport,
  type GenerationSurface,
  type GeneratorNodeData,
  type GeneratorParams,
  type MediaAspect,
  type MediaGenerateRequest,
  type MediaNodeData,
  type MediaTaskSnapshotResponse,
  type PlannedRun,
  type ProjectFile,
} from '@open-design/contracts';

import { resolveDaemonUrl } from '../daemon-url.js';
import { BOARD_EXIT_CODES } from './board/board-cli-help.js';

// ---- io --------------------------------------------------------------------------------------------------

export interface BoardGenerateIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

export interface BoardGenerateDeps {
  /** Pause between retries after a network failure (tests: no real waiting). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Id source for new board entities and runs (tests: deterministic). */
  newId?: () => string;
}

const defaultIo: BoardGenerateIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
};

export const BOARD_GENERATE_USAGE = `Usage:
  od board generate <generatorNodeId> [flags]
  od board generate --create [--surface image|video] (--prompt <text> | --prompt-file <path|->) [flags]

Run a generator node of the project board (画板) with the configured media providers.
The run is written into the board like a run started in the workspace: an output
node with one candidate per requested result, linked to the generator. Flags
override the generator's settings and are saved into it.

Flags:
  --project <id>            Project (default $OD_PROJECT_ID).
  --create                  Create a new generator right of the board content first.
  --surface image|video     Output kind (switching keeps the prompt and picks a model
                            for the new kind unless --model is given).
  --prompt <text>           Prompt; @[node:<id>] tokens reference connected nodes.
  --prompt-file <path|->    Read the prompt from a file or stdin.
  --model <id>              Model id (see GET /api/media/models); default: the
                            generator's model, else the project's default model.
  --aspect <ratio>          1:1 | 16:9 | 9:16 | 4:3 | 3:4 (models may allow fewer).
  --quality <q>             gpt-image quality (high | medium | low | auto).
  --resolution <r>          Nano Banana size (1K | 2K | 4K) or a video variant (480p | 720p | 1080p).
  --length <sec>            Video seconds (one of the lengths the model supports).
  --count 1-4               Number of results.
  --locale zh-CN|en         Language of the reference labels sent to the model (default en).
  --no-wait                 Return after the tasks are queued.
  --timeout <sec>           How long to wait for the results (default 600).
  --json                    Print the result as JSON.
  --daemon-url <url>        Fantay daemon HTTP base.
  --workspace <id> --workspace-member <id>
                            Team-project identity, both or neither (default
                            $OD_WORKSPACE_ID + $OD_WORKSPACE_MEMBER_ID).

References that the daemon cannot read (non-PNG/JPEG/WebP/GIF images, covers of
frames and designs) are skipped with a warning; the workspace converts them.
\`od media generate|wait\` stay the low-level path.

--json prints {ok, projectId, generatorId, runId, outputNodeId,
status: done|partial|running|failed, candidates[{id, status, taskId, file, error}], warnings}.

Exit codes:
  0 at least one result and none running; 2 usage (invalid-request); 64
  daemon-not-running; 67 missing-input (no project id); 68 project-not-found;
  72 board-revision-conflict; 73 still running at --timeout (or --no-wait); 74
  every candidate failed; 1 anything else.
  Errors print {"error":{"code","message","data"}} on stderr.`;

/** Writes per board change before a revision conflict is reported (spec 05 §8). */
const MAX_WRITE_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_SEC = 600;
/** Consecutive failed daemon calls while waiting before the daemon is reported unreachable. */
const MAX_WAIT_NETWORK_FAILURES = 5;
const NETWORK_RETRY_MS = 1_000;

// ---- arguments -----------------------------------------------------------------------------------------

class UsageError extends Error {}

const STRING_FLAGS = new Set([
  'project', 'workspace', 'workspace-member', 'daemon-url', 'surface', 'prompt', 'prompt-file', 'model',
  'aspect', 'quality', 'resolution', 'length', 'count', 'locale', 'timeout',
]);
const BOOLEAN_FLAGS = new Set(['create', 'no-wait', 'json', 'help']);

interface ParsedArgs {
  flags: Map<string, string>;
  booleans: Set<string>;
  positionals: string[];
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { flags: new Map(), booleans: new Set(), positionals: [] };
  let flagsDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flagsDone || !arg.startsWith('--')) {
      if (!flagsDone && (arg === '-h' || arg === 'help')) parsed.booleans.add('help');
      else parsed.positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      flagsDone = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} does not take a value`);
      parsed.booleans.add(key);
      continue;
    }
    if (!STRING_FLAGS.has(key)) {
      throw new UsageError(`unknown flag for od board generate: --${key}. Run \`od board generate --help\` for the flags.`);
    }
    let value: string | undefined;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`flag --${key} requires a value`);
    parsed.flags.set(key, value);
  }
  return parsed;
}

function numberFlag(parsed: ParsedArgs, key: string, opts: { integer?: boolean; min?: number; max?: number; positive?: boolean } = {}): number | undefined {
  const raw = parsed.flags.get(key);
  if (raw === undefined) return undefined;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || (opts.integer && !Number.isInteger(value))) {
    throw new UsageError(`--${key} expects ${opts.integer ? 'an integer' : 'a number'}, got "${raw}"`);
  }
  if (opts.positive && value <= 0) throw new UsageError(`--${key} must be greater than 0, got ${raw}`);
  if ((opts.min !== undefined && value < opts.min) || (opts.max !== undefined && value > opts.max)) {
    throw new UsageError(`--${key} must be ${opts.min ?? '-∞'}..${opts.max ?? '∞'}, got ${raw}`);
  }
  return value;
}

interface GenerateOptions {
  generatorId: string | null;
  create: boolean;
  surface?: GenerationSurface;
  prompt?: { kind: 'inline'; value: string } | { kind: 'file'; path: string };
  model?: string;
  aspect?: MediaAspect;
  quality?: string;
  resolution?: string;
  length?: number;
  count?: GeneratorParams['count'];
  locale: string;
  wait: boolean;
  timeoutMs: number;
  json: boolean;
}

function prepareOptions(parsed: ParsedArgs): GenerateOptions {
  if (parsed.positionals.length > 1) {
    throw new UsageError(`od board generate takes one <generatorNodeId> (got ${parsed.positionals.join(' ')})`);
  }
  const create = parsed.booleans.has('create');
  const generatorId = parsed.positionals[0]?.trim() || null;
  if (create && generatorId) throw new UsageError('pass either a <generatorNodeId> or --create, not both');
  if (!create && !generatorId) throw new UsageError('od board generate needs a <generatorNodeId> or --create');
  if (generatorId && !isBoardId(generatorId)) throw new UsageError(`"${generatorId}" is not a board node id`);

  const rawSurface = parsed.flags.get('surface');
  if (rawSurface === 'audio') throw new UsageError('audio generators are not available yet; --surface must be image or video');
  if (rawSurface !== undefined && !(BOARD_GENERATOR_SURFACES as readonly string[]).includes(rawSurface)) {
    throw new UsageError(`--surface must be one of ${BOARD_GENERATOR_SURFACES.join(', ')}, got "${rawSurface}"`);
  }
  if (parsed.flags.has('prompt') && parsed.flags.has('prompt-file')) throw new UsageError('use only one of --prompt, --prompt-file');
  const rawAspect = parsed.flags.get('aspect');
  if (rawAspect !== undefined && !MEDIA_ASPECT_VALUES.includes(rawAspect as MediaAspect)) {
    throw new UsageError(`--aspect must be one of ${MEDIA_ASPECT_VALUES.join(', ')}, got "${rawAspect}"`);
  }
  const count = numberFlag(parsed, 'count', { integer: true, min: 1, max: GENERATION_LIMITS.maxCount });
  const length = numberFlag(parsed, 'length', { positive: true });
  const timeout = numberFlag(parsed, 'timeout', { positive: true });
  const model = parsed.flags.get('model')?.trim();
  if (parsed.flags.has('model') && !model) throw new UsageError('--model needs a model id');
  const locale = parsed.flags.get('locale')?.trim() || 'en';

  const options: GenerateOptions = {
    generatorId,
    create,
    locale,
    wait: !parsed.booleans.has('no-wait'),
    timeoutMs: Math.round((timeout ?? DEFAULT_TIMEOUT_SEC) * 1000),
    json: parsed.booleans.has('json'),
  };
  if (rawSurface !== undefined) options.surface = rawSurface as GenerationSurface;
  const prompt = parsed.flags.get('prompt');
  const promptFile = parsed.flags.get('prompt-file');
  if (prompt !== undefined) options.prompt = { kind: 'inline', value: prompt };
  else if (promptFile !== undefined) options.prompt = { kind: 'file', path: promptFile };
  if (model) options.model = model;
  if (rawAspect !== undefined) options.aspect = rawAspect as MediaAspect;
  const quality = parsed.flags.get('quality')?.trim();
  if (quality) options.quality = quality;
  const resolution = parsed.flags.get('resolution')?.trim();
  if (resolution) options.resolution = resolution;
  if (length !== undefined) options.length = length;
  if (count !== undefined) options.count = count as GeneratorParams['count'];
  return options;
}

async function readPrompt(io: BoardGenerateIo, source: NonNullable<GenerateOptions['prompt']>): Promise<string> {
  if (source.kind === 'inline') return source.value;
  try {
    const text = source.path === '-' ? await io.readStdin() : await readFile(source.path, 'utf8');
    return text.replace(/\s+$/u, '');
  } catch (error) {
    throw new UsageError(`cannot read --prompt-file ${source.path}: ${errorMessage(error)}`);
  }
}

// ---- daemon calls -----------------------------------------------------------------------------------------

interface StructuredError {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

type CallResult<T> = { ok: true; data: T; status: number } | { ok: false; error: StructuredError; status: number; body: unknown };

interface CliContext {
  io: BoardGenerateIo;
  projectId: string;
  base: string;
  headers: Record<string, string>;
  actor: BoardActor;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  newId: () => string;
}

const EXIT_BY_CODE = new Map<string, number>([
  ['invalid-request', BOARD_EXIT_CODES.usage],
  ['daemon-not-running', BOARD_EXIT_CODES.daemonNotRunning],
  ['missing-input', BOARD_EXIT_CODES.missingInput],
  ['project-not-found', BOARD_EXIT_CODES.projectNotFound],
  ['board-revision-conflict', BOARD_EXIT_CODES.revisionConflict],
]);

function httpError(status: number, payload: unknown, raw: string): StructuredError {
  const envelope = isRecord(payload) ? payload.error : undefined;
  let daemonCode: string | undefined;
  let message: string | undefined;
  let details: unknown;
  if (typeof envelope === 'string') {
    if (isRecord(payload) && typeof payload.message === 'string') {
      daemonCode = envelope;
      message = payload.message;
    } else {
      message = envelope;
      if (isRecord(payload) && typeof payload.code === 'string') daemonCode = payload.code;
    }
  } else if (isRecord(envelope)) {
    if (typeof envelope.code === 'string') daemonCode = envelope.code;
    if (typeof envelope.message === 'string') message = envelope.message;
    details = envelope.details;
  }
  message ??= `HTTP ${status}${raw ? `: ${raw.slice(0, 500)}` : ''}`;
  const data: Record<string, unknown> = { status, ...(details !== undefined ? { details } : {}), ...(daemonCode ? { daemonCode } : {}) };
  if (status === 404 && (daemonCode === 'PROJECT_NOT_FOUND' || daemonCode === 'project-not-found')) {
    return { code: 'project-not-found', message, data };
  }
  if (status === 409 && isRecord(details) && details.kind === 'board-conflict') return { code: 'board-revision-conflict', message, data };
  if (status === 400) return { code: 'invalid-request', message, data };
  return { code: daemonCode ?? 'daemon-error', message, data };
}

async function callDaemon<T>(
  ctx: CliContext,
  method: 'GET' | 'POST' | 'PATCH',
  pathname: string,
  body?: unknown,
): Promise<CallResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${ctx.base}${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...ctx.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const cause = isRecord(error) && isRecord(error.cause) ? (error.cause.code ?? error.cause.message) : undefined;
    return {
      ok: false,
      status: 0,
      body: undefined,
      error: {
        code: 'daemon-not-running',
        message: `Cannot reach the daemon at ${ctx.base}: ${errorMessage(error)}${typeof cause === 'string' && cause ? ` (${cause})` : ''}`,
      },
    };
  }
  const raw = await response.text().catch(() => '');
  let payload: unknown;
  try {
    payload = raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    payload = raw;
  }
  if (!response.ok) return { ok: false, status: response.status, body: payload, error: httpError(response.status, payload, raw) };
  return { ok: true, status: response.status, data: payload as T };
}

async function getBoard(ctx: CliContext): Promise<CallResult<BoardDocument>> {
  const got = await callDaemon<BoardGetResponse>(ctx, 'GET', boardApiPath(ctx.projectId));
  if (!got.ok) return got;
  const board = isRecord(got.data) ? got.data.board : undefined;
  if (!isRecord(board) || !Array.isArray(board.nodes) || !Array.isArray(board.edges)) {
    return { ok: false, status: got.status, body: got.data, error: { code: 'daemon-error', message: 'the daemon returned a malformed board' } };
  }
  return { ok: true, status: got.status, data: board as unknown as BoardDocument };
}

/**
 * Read-modify-write of the board: `build` derives the ops from a fresh read each attempt; a 409 board
 * conflict re-reads and rebuilds (≤ 5 attempts). `build` returning `[]` means nothing to write.
 */
async function writeBoard(
  ctx: CliContext,
  build: (board: BoardDocument) => BoardOp[] | StructuredError,
): Promise<CallResult<BoardPatchResponse | null>> {
  let last: CallResult<BoardPatchResponse | null> | null = null;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const got = await getBoard(ctx);
    if (!got.ok) return got;
    const ops = build(got.data);
    if (!Array.isArray(ops)) return { ok: false, status: 0, body: undefined, error: ops };
    if (ops.length === 0) return { ok: true, status: 200, data: null };
    last = await callDaemon<BoardPatchResponse>(ctx, 'PATCH', boardApiPath(ctx.projectId), {
      baseRevision: got.data.revision,
      ops,
      actor: ctx.actor,
    });
    if (last.ok || last.error.code !== 'board-revision-conflict') return last;
  }
  if (last && !last.ok) {
    return { ...last, error: { ...last.error, message: `${last.error.message} (gave up after ${MAX_WRITE_ATTEMPTS} attempts)` } };
  }
  return last ?? { ok: true, status: 200, data: null };
}

// ---- board ↔ generation graph (local pair, spec 05 §8) ------------------------------------------------------

type MediaBoardNode = Extract<BoardNode, { kind: 'image' | 'video' }>;

function mediaDataOf(node: MediaBoardNode): MediaNodeData {
  const data: MediaNodeData = {};
  const generation = node.generation;
  const primary = generation?.primaryCandidateId
    ? generation.candidates.find((candidate) => candidate.id === generation.primaryCandidateId)?.file
    : undefined;
  if (node.ref) {
    const file: BoardMediaFile = { ...(primary && primary.path === node.ref.path ? primary : {}), path: node.ref.path };
    if (typeof node.naturalWidth === 'number' && node.naturalWidth > 0) file.width = node.naturalWidth;
    if (typeof node.naturalHeight === 'number' && node.naturalHeight > 0) file.height = node.naturalHeight;
    data.file = file;
  } else if (primary) {
    data.file = { ...primary };
  }
  if (node.refProxy) data.refProxy = { path: node.refProxy.path, sourceKey: node.refProxy.sourceKey };
  if (generation) data.generation = generation;
  return data;
}

/** Same view as the web adapter (board-adapter.ts); covers are references the CLI cannot convert. */
export function toGenerationGraph(board: Pick<BoardDocument, 'nodes' | 'edges'>): GenerationGraph {
  const children = new Map<string, string[]>();
  for (const node of board.nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  const nodes = board.nodes.map((node): GenerationGraphNode => {
    const base: GenerationGraphNode = { id: node.id, kind: 'other', x: node.x, y: node.y, w: node.w, h: node.h };
    if (node.title) base.title = node.title;
    switch (node.kind) {
      case 'generator': {
        const generator: GeneratorNodeData = {
          version: 1,
          surface: node.surface,
          prompt: node.prompt,
          model: node.model,
          params: node.params,
          runs: node.runs,
        };
        if (node.templateId) generator.templateId = node.templateId;
        return { ...base, kind: 'generator', generator };
      }
      case 'image':
      case 'video': {
        const media = mediaDataOf(node);
        const graphNode: GenerationGraphNode = { ...base, kind: node.kind, media };
        if (node.kind === 'image' && !node.missing && media.file) {
          const sourceKey = `${media.file.path}@${media.file.mtime ?? 0}`;
          graphNode.image =
            node.refProxy && node.refProxy.sourceKey === sourceKey
              ? { path: node.refProxy.path, daemonReady: true }
              : { ...media.file, daemonReady: isDaemonReadyImage(media.file) };
        }
        return graphNode;
      }
      case 'note':
        return { ...base, kind: 'note', text: node.text };
      case 'group':
        return { ...base, kind: 'group', memberIds: children.get(node.id) ?? [] };
      case 'frame':
      case 'web':
      case 'design': {
        // A cover is a picture the daemon cannot read as a reference (not a project file): the compiler
        // reports it as `reference-not-ready`; the workspace converts covers into project files.
        if (!node.cover || node.missing) return base;
        const path =
          node.cover.source === 'board-cover' ? `board-cover:${node.cover.digest}` : `chat-artifact-snapshot:${node.cover.snapshotId}`;
        return { ...base, image: { path, daemonReady: false } };
      }
      default:
        return base;
    }
  });
  const edges: GenerationGraph['edges'] = [];
  board.edges.forEach((edge, order) => {
    const role = generationEdgeRoleFromBoardKind(edge.kind);
    if (role) edges.push({ id: edge.id, from: edge.from, to: edge.to, role, order });
  });
  return { nodes, edges };
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function placeable(file: BoardMediaFile | undefined, kind: 'image' | 'video'): BoardMediaFile | undefined {
  return file && boardKindForPath(file.path) === kind ? file : undefined;
}

/** Generation ops → contract ops against `board` (same mapping as the web adapter). */
export function generationOpsToBoardOps(board: Pick<BoardDocument, 'nodes'>, ops: readonly GenerationBoardOp[]): BoardOp[] {
  const kinds = new Map<string, BoardNode['kind']>(board.nodes.map((node) => [node.id, node.kind]));
  const refPaths = new Map<string, string | null>(
    board.nodes.map((node) => [node.id, node.kind === 'image' || node.kind === 'video' ? (node.ref?.path ?? null) : null]),
  );
  const outputFrom = new Map<string, string>();
  for (const op of ops) if (op.type === 'edge.add' && op.edge.role === 'output') outputFrom.set(op.edge.to, op.edge.from);
  const out: BoardOp[] = [];
  for (const op of ops) {
    if (op.type === 'node.add') {
      const input = op.node;
      const common = { id: input.id, x: input.x, y: input.y, w: input.w, h: input.h, ...(input.title.trim() ? { title: input.title } : {}) };
      if (input.kind === 'generator') {
        const data = input.data as GeneratorNodeData;
        out.push({
          op: 'add',
          node: {
            ...common,
            kind: 'generator',
            version: 1,
            surface: data.surface,
            prompt: data.prompt,
            model: data.model,
            params: { ...data.params },
            ...(data.templateId ? { templateId: data.templateId } : {}),
            runs: data.runs.map((run) => ({ ...run })),
          } as BoardNodeDraft,
        });
        kinds.set(input.id, 'generator');
      } else {
        const data = input.data as MediaNodeData;
        const file = placeable(data.file, input.kind);
        const generatorId = data.generation?.request.generatorId ?? outputFrom.get(input.id);
        out.push({
          op: 'add',
          node: {
            ...common,
            kind: input.kind,
            ref: file ? { path: file.path } : null,
            ...(file?.width ? { naturalWidth: file.width } : {}),
            ...(file?.height ? { naturalHeight: file.height } : {}),
            ...(data.generation ? { generation: data.generation } : {}),
            ...(data.refProxy ? { refProxy: { ...data.refProxy } } : {}),
            ...(generatorId ? { origin: { source: 'generator', generatorNodeId: generatorId } } : {}),
          } as BoardNodeDraft,
        });
        kinds.set(input.id, input.kind);
        refPaths.set(input.id, file?.path ?? null);
      }
      continue;
    }
    if (op.type === 'node.patchData') {
      const kind = kinds.get(op.id);
      const patch: BoardNodePatch = {};
      if (kind === 'generator') {
        const value = op.patch as Partial<GeneratorNodeData>;
        if (value.surface !== undefined) patch.surface = value.surface;
        if (typeof value.prompt === 'string') patch.prompt = value.prompt;
        if (hasOwn(value, 'model') && value.model !== undefined) patch.model = value.model;
        if (value.params) patch.params = { ...value.params };
        if (hasOwn(value, 'templateId')) patch.templateId = value.templateId ?? null;
        if (value.runs) patch.runs = value.runs.map((run) => ({ ...run }));
      } else if (kind === 'image' || kind === 'video') {
        const value = op.patch as Partial<MediaNodeData>;
        const current = refPaths.get(op.id) ?? null;
        if (hasOwn(value, 'file')) {
          const file = placeable(value.file, kind);
          if (file && file.path !== current) {
            patch.ref = { path: file.path };
            patch.naturalWidth = file.width ?? null;
            patch.naturalHeight = file.height ?? null;
            refPaths.set(op.id, file.path);
          }
        }
        if (hasOwn(value, 'generation')) patch.generation = value.generation ?? null;
        if (hasOwn(value, 'refProxy')) patch.refProxy = value.refProxy ? { ...value.refProxy } : null;
      } else {
        continue;
      }
      if (Object.keys(patch).length > 0) out.push({ op: 'update', id: op.id, patch });
      continue;
    }
    if (op.type === 'node.setFrame') {
      out.push({ op: 'update', id: op.id, patch: { x: op.x, y: op.y, w: op.w, h: op.h } });
    } else if (op.type === 'node.setTitle') {
      out.push({ op: 'update', id: op.id, patch: { title: op.title.trim() ? op.title : null } });
    } else if (op.type === 'edge.add') {
      out.push({
        op: 'connect',
        edge: { id: op.edge.id, kind: GENERATION_EDGE_ROLE_TO_BOARD_KIND[op.edge.role], from: op.edge.from, to: op.edge.to },
        ifAbsent: true,
      });
    } else if (op.type === 'edge.remove') {
      out.push({ op: 'disconnect', ids: [op.id] });
    }
  }
  return out;
}

// ---- model catalog ------------------------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  label?: string;
  provider: string;
  caps?: string[];
}
interface MediaModelsResponse {
  image?: CatalogModel[];
  video?: CatalogModel[];
}

type ResolvedModel = { id: string; provider: string; caps: string[]; label: string };

/**
 * Model of the static catalog; ids absent from it are synthesized like the daemon dispatcher
 * (media/index.ts): `aihubmix-*` → AIHubMix, `fal-ai/*` → Fal.
 */
function resolveModel(catalog: MediaModelsResponse, id: string, surface: GenerationSurface): ResolvedModel | StructuredError {
  const list = (surface === 'image' ? catalog.image : catalog.video) ?? [];
  const found = list.find((model) => model.id === id);
  if (found) return { id: found.id, provider: found.provider, caps: [...(found.caps ?? [])], label: found.label ?? found.id };
  if (id.startsWith('aihubmix-')) {
    return { id, provider: 'aihubmix', caps: surface === 'image' ? ['t2i', 'i2i'] : ['t2v', 'i2v'], label: id };
  }
  if (id.startsWith('fal-ai/')) return { id, provider: 'fal', caps: surface === 'image' ? ['t2i'] : ['t2v'], label: id };
  const other = ((surface === 'image' ? catalog.video : catalog.image) ?? []).some((model) => model.id === id);
  return {
    code: 'invalid-request',
    message: other
      ? `${id} is a ${surface === 'image' ? 'video' : 'image'} model; pass --surface ${surface === 'image' ? 'video' : 'image'} or another --model`
      : `unknown model ${id} (see GET /api/media/models)`,
    data: { model: id, surface },
  };
}

function matchOption(value: string, options: readonly string[] | undefined): string | undefined {
  if (!options) return undefined;
  return options.find((option) => option === value) ?? options.find((option) => option.toLowerCase() === value.toLowerCase());
}

// ---- run planning ------------------------------------------------------------------------------------------

interface Setup {
  setupOps: GenerationBoardOp[];
  graph: GenerationGraph;
  generatorId: string;
  data: GeneratorNodeData;
  model: ResolvedModel;
  support: GenerationParamSupport;
}

/** Ids replayed identically on every write attempt, so a retried write is the same write. */
function replayableIds(newId: () => string): { reset(): { next(): string } } {
  const pool: string[] = [];
  return {
    reset() {
      let index = 0;
      return {
        next() {
          if (index >= pool.length) pool.push(newId());
          return pool[index++]!;
        },
      };
    },
  };
}

function boardBounds(graph: GenerationGraph): { right: number; top: number } | null {
  const nodes = graph.nodes.filter((node) => node.kind !== 'group');
  if (nodes.length === 0) return null;
  return { right: Math.max(...nodes.map((node) => node.x + node.w)), top: Math.min(...nodes.map((node) => node.y)) };
}

function prepareSetup(
  board: BoardDocument,
  options: GenerateOptions,
  prompt: string | undefined,
  catalog: MediaModelsResponse,
  projectDefaults: { image?: string; video?: string },
  createdId: string,
): Setup | StructuredError {
  const graph = toGenerationGraph(board);
  const setupOps: GenerationBoardOp[] = [];
  let node: GenerationGraphNode;
  let data: GeneratorNodeData;
  let created = false;
  const generatorId = options.create ? createdId : options.generatorId!;
  const existing = graph.nodes.find((entry) => entry.id === generatorId);
  if (existing) {
    if (existing.kind !== 'generator' || !existing.generator) {
      return { code: 'invalid-request', message: `${generatorId} is a ${existing.kind === 'other' ? 'non-generator' : existing.kind} node, not a generator.`, data: { nodeId: generatorId } };
    }
    node = existing;
    data = { ...existing.generator, params: { ...existing.generator.params } };
  } else if (options.create) {
    const bounds = boardBounds(graph);
    const placed = createGeneratorNodeInput({
      id: generatorId,
      x: bounds ? bounds.right + GENERATION_LIMITS.outputGapX : 0,
      y: bounds ? bounds.top : 0,
      surface: options.surface ?? 'image',
    });
    const input = { ...placed, ...findFreePlacement(graph, placed) };
    data = input.data as GeneratorNodeData;
    node = { id: input.id, kind: 'generator', x: input.x, y: input.y, w: input.w, h: input.h, generator: data };
    created = true;
  } else {
    return { code: 'node-not-found', message: `No node ${generatorId} on the board of project ${board.projectId}.`, data: { nodeId: generatorId } };
  }

  const before = JSON.stringify(data);
  if (options.surface && options.surface !== data.surface) {
    data.surface = options.surface;
    if (!options.model) data.model = null; // re-pick a model for the new kind (same as the UI's surface switch)
  }
  if (prompt !== undefined) data.prompt = prompt;
  if (options.model) data.model = options.model;
  const surface = data.surface;

  const modelId = data.model ?? (surface === 'image' ? projectDefaults.image : projectDefaults.video);
  if (!modelId) {
    return {
      code: 'invalid-request',
      message: `generator ${generatorId} has no model and the project has no default ${surface} model; pass --model <id>`,
      data: { nodeId: generatorId, reason: 'no-model' },
    };
  }
  const model = resolveModel(catalog, modelId, surface);
  if ('code' in model) return model;
  const support = paramSupportFor(model, surface);
  if (!support.usable) {
    return {
      code: 'invalid-request',
      message: `model ${model.id} cannot generate ${surface} on the board (no renderer for this provider, or it needs references it cannot read)`,
      data: { model: model.id, surface, reason: 'model-unavailable' },
    };
  }

  const params: GeneratorParams = { ...data.params };
  if (options.aspect) {
    if (!support.aspects.includes(options.aspect)) {
      return { code: 'invalid-request', message: `--aspect ${options.aspect} is not supported by ${model.id} (${support.aspects.join(', ')})`, data: { model: model.id } };
    }
    params.aspect = options.aspect;
  }
  if (options.count !== undefined) params.count = options.count;
  if (options.length !== undefined) {
    if (surface !== 'video') return { code: 'invalid-request', message: '--length applies to video generators', data: { surface } };
    if (!support.lengths?.includes(options.length)) {
      return { code: 'invalid-request', message: `--length ${options.length} is not supported by ${model.id} (${(support.lengths ?? []).join(', ')} s)`, data: { model: model.id } };
    }
    params.length = options.length;
  }
  if (options.quality) {
    const quality = matchOption(options.quality, support.qualities);
    if (!quality) {
      return { code: 'invalid-request', message: `--quality is not supported by ${model.id}${support.qualities ? ` (${support.qualities.join(', ')})` : ''}`, data: { model: model.id } };
    }
    params.quality = quality;
  }
  if (options.resolution) {
    const resolution = matchOption(options.resolution, support.resolutions);
    if (!resolution) {
      return { code: 'invalid-request', message: `--resolution is not supported by ${model.id}${support.resolutions ? ` (${support.resolutions.join(', ')})` : ''}`, data: { model: model.id } };
    }
    params.resolution = resolution;
  }
  data.params = clampParams(params, support, surface);

  const generatorNode: GenerationGraphNode = { ...node, generator: data };
  const nextGraph: GenerationGraph = {
    ...graph,
    nodes: created ? [...graph.nodes, generatorNode] : graph.nodes.map((entry) => (entry.id === generatorId ? generatorNode : entry)),
  };
  if (created) {
    setupOps.push({ type: 'node.add', node: { id: generatorId, kind: 'generator', x: node.x, y: node.y, w: node.w, h: node.h, title: '', data } });
  } else if (JSON.stringify(data) !== before) {
    setupOps.push({
      type: 'node.patchData',
      id: generatorId,
      patch: { surface: data.surface, prompt: data.prompt, model: data.model, params: data.params },
    });
  }
  return { setupOps, graph: nextGraph, generatorId, data, model, support };
}

function runTitle(prompt: string, labels: ReadonlyMap<string, string>, fallback: string): string {
  const text = prompt
    .replace(/@\[node:([^\]\s]+)\]/gu, (_token, id: string) => labels.get(id) ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > 0 ? chars.slice(0, 32).join('') : fallback;
}

interface PlannedWrite {
  ops: BoardOp[];
  plan: PlannedRun;
  warnings: CompileWarning[];
  generatorId: string;
}

// ---- result ------------------------------------------------------------------------------------------------

interface CandidateState {
  candidate: GenerationCandidate;
  since: number;
  /** Stop watching (4xx on wait): reported as it is. */
  detached: boolean;
}

type RunStatus = 'done' | 'partial' | 'running' | 'failed';

function runStatusOf(candidates: readonly GenerationCandidate[]): RunStatus {
  if (candidates.some((candidate) => isActiveSlot(candidate.status))) return 'running';
  const done = candidates.filter((candidate) => candidate.status === 'done').length;
  if (done === candidates.length && done > 0) return 'done';
  return done > 0 ? 'partial' : 'failed';
}

function exitCodeOf(status: RunStatus): number {
  if (status === 'running') return BOARD_EXIT_CODES.generationRunning;
  if (status === 'failed') return BOARD_EXIT_CODES.generationFailed;
  return BOARD_EXIT_CODES.ok;
}

function candidateJson(candidate: GenerationCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    status: candidate.status,
    taskId: candidate.taskId ?? null,
    file: candidate.file
      ? {
          path: candidate.file.path,
          ...(candidate.file.mime ? { mime: candidate.file.mime } : {}),
          ...(typeof candidate.file.size === 'number' ? { size: candidate.file.size } : {}),
        }
      : null,
    error: candidate.error ? errorJson(candidate.error) : null,
    ...(candidate.warnings?.length ? { warnings: candidate.warnings } : {}),
    ...(candidate.stub ? { stub: true } : {}),
  };
}

function errorJson(error: GenerationCandidateError): Record<string, unknown> {
  return {
    message: error.message,
    nextStep: error.nextStep,
    ...(error.code ? { code: error.code } : {}),
    ...(typeof error.status === 'number' ? { status: error.status } : {}),
  };
}

function warningText(warning: CompileWarning): string {
  switch (warning.kind) {
    case 'refs-truncated':
      return `the model reads at most ${warning.kept} reference images; ${warning.total - warning.kept} were not sent`;
    case 'refs-ignored-by-model':
      return `the model ignores reference images (${warning.count} connected)`;
    case 'reference-not-ready':
      return `reference ${warning.nodeId} is not a project PNG/JPEG/WebP/GIF ≤ 16 MB and was skipped (open the board in the workspace to convert it)`;
    case 'unresolved-token':
      return `prompt token @[node:${warning.nodeId}] does not name a connected reference and was removed`;
    case 'ineligible-input':
      return `connected node ${warning.nodeId} cannot be used as a reference`;
    default:
      return JSON.stringify(warning);
  }
}

// ---- command --------------------------------------------------------------------------------------------------

function emitError(io: BoardGenerateIo, error: StructuredError, exitCode?: number): { exitCode: number } {
  io.stderr(`${JSON.stringify({ error: { code: error.code, message: error.message, data: error.data ?? {} } })}\n`);
  return { exitCode: exitCode ?? EXIT_BY_CODE.get(error.code) ?? BOARD_EXIT_CODES.error };
}

function workspaceHeaders(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Record<string, string> {
  const explicit = parsed.flags.has('workspace') || parsed.flags.has('workspace-member');
  const workspaceId = (explicit ? parsed.flags.get('workspace') : env.OD_WORKSPACE_ID)?.trim() ?? '';
  const memberId = (explicit ? parsed.flags.get('workspace-member') : env.OD_WORKSPACE_MEMBER_ID)?.trim() ?? '';
  if (Boolean(workspaceId) !== Boolean(memberId)) {
    throw new UsageError(explicit
      ? 'pass --workspace <id> and --workspace-member <id> together'
      : 'OD_WORKSPACE_ID and OD_WORKSPACE_MEMBER_ID must be set together; pass --workspace <id> --workspace-member <id>');
  }
  return workspaceId ? { 'x-od-workspace-id': workspaceId, 'x-od-workspace-member-id': memberId } : {};
}

function boardActor(env: NodeJS.ProcessEnv): BoardActor {
  const runId = env.OD_STOCK_RUN_ID?.trim();
  return runId ? { kind: 'agent', runId } : { kind: 'cli' };
}

interface MediaCallResult {
  kind: 'accepted' | 'http-error' | 'network';
  patch: CandidatePatch;
  taskId?: string;
}

async function postGenerate(ctx: CliContext, candidateId: string, request: MediaGenerateRequest): Promise<MediaCallResult> {
  const result = await callDaemon<unknown>(ctx, 'POST', `/api/projects/${encodeURIComponent(ctx.projectId)}/media/generate`, request);
  if (result.ok) {
    const accepted = parseMediaGenerateAccepted(result.data);
    if (accepted) return { kind: 'accepted', patch: candidatePatchFromAccepted(candidateId, accepted), taskId: accepted.taskId };
    return {
      kind: 'http-error',
      patch: candidatePatchFromHttpError(candidateId, { status: result.status, message: 'The daemon accepted the request without a task id.' }, request.model),
    };
  }
  if (result.status === 0) return { kind: 'network', patch: candidatePatchNetworkError(candidateId, result.error.message) };
  return { kind: 'http-error', patch: candidatePatchFromHttpError(candidateId, parseDaemonApiError(result.status, result.body), request.model) };
}

/** Applies candidate patches to the output node with a fresh read per attempt. */
async function writeCandidates(
  ctx: CliContext,
  outputNodeId: string,
  patches: readonly CandidatePatch[],
): Promise<CallResult<BoardPatchResponse | null>> {
  if (patches.length === 0) return { ok: true, status: 200, data: null };
  return writeBoard(ctx, (board) => {
    const node = board.nodes.find((entry) => entry.id === outputNodeId);
    if (!node || (node.kind !== 'image' && node.kind !== 'video') || !node.generation) return []; // removed meanwhile
    const before = mediaDataOf(node);
    let data = before;
    for (const patch of patches) data = applyCandidatePatch(data, patch).data;
    if (JSON.stringify(data.generation) === JSON.stringify(before.generation)) return [];
    return generationOpsToBoardOps(board, [
      { type: 'node.patchData', id: outputNodeId, patch: { generation: data.generation, file: data.file } },
    ]);
  });
}

async function fileByStem(ctx: CliContext, stem: string): Promise<ProjectFile | null | 'error'> {
  const listed = await callDaemon<{ files?: ProjectFile[] }>(ctx, 'GET', `/api/projects/${encodeURIComponent(ctx.projectId)}/files`);
  if (!listed.ok || !Array.isArray(listed.data?.files)) return 'error';
  return listed.data.files.find((file) => file.type !== 'dir' && outputStemOf(file.name) === stem) ?? null;
}

export async function runBoardGenerateCli(
  args: readonly string[],
  io: BoardGenerateIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: BoardGenerateDeps = {},
): Promise<{ exitCode: number }> {
  let parsed: ParsedArgs;
  let options: GenerateOptions;
  let headers: Record<string, string>;
  try {
    parsed = parseArgs(args);
    if (parsed.booleans.has('help')) {
      io.stdout(`${BOARD_GENERATE_USAGE}\n`);
      return { exitCode: BOARD_EXIT_CODES.ok };
    }
    options = prepareOptions(parsed);
    headers = workspaceHeaders(parsed, env);
  } catch (error) {
    if (error instanceof UsageError) return emitError(io, { code: 'invalid-request', message: error.message }, BOARD_EXIT_CODES.usage);
    return emitError(io, { code: 'cli-error', message: errorMessage(error) });
  }

  const projectId = parsed.flags.get('project')?.trim() || env.OD_PROJECT_ID?.trim() || '';
  if (!projectId) {
    return emitError(io, {
      code: 'missing-input',
      message: 'project id required: pass --project <id> or set OD_PROJECT_ID (the daemon sets it for agent runs).',
    });
  }
  let base: string;
  try {
    const flagUrl = parsed.flags.get('daemon-url');
    base = (await resolveDaemonUrl({ ...(flagUrl ? { flagUrl } : {}), env })).replace(/\/+$/u, '');
  } catch (error) {
    return emitError(io, { code: 'daemon-not-running', message: errorMessage(error) });
  }
  const ctx: CliContext = {
    io,
    projectId,
    base,
    headers,
    actor: boardActor(env),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? (() => randomUUID()),
  };
  try {
    return await generate(ctx, options);
  } catch (error) {
    if (error instanceof UsageError) return emitError(io, { code: 'invalid-request', message: error.message }, BOARD_EXIT_CODES.usage);
    return emitError(io, { code: 'cli-error', message: errorMessage(error) });
  }
}

async function generate(ctx: CliContext, options: GenerateOptions): Promise<{ exitCode: number }> {
  const { io } = ctx;
  const prompt = options.prompt ? await readPrompt(io, options.prompt) : undefined;

  // The project: existence, imported-folder check (outputs would be invisible, spec 05 F15), default models.
  const project = await callDaemon<{ project?: { metadata?: Record<string, unknown> } }>(
    ctx,
    'GET',
    `/api/projects/${encodeURIComponent(ctx.projectId)}`,
  );
  if (!project.ok) {
    if (project.status === 404) return emitError(io, { ...project.error, code: 'project-not-found' });
    return emitError(io, project.error);
  }
  const metadata = isRecord(project.data?.project?.metadata) ? project.data.project.metadata : {};
  if (typeof metadata.baseDir === 'string' && metadata.baseDir) {
    return emitError(io, {
      code: 'imported-folder-unsupported',
      message: 'Board generation is not available for imported-folder projects yet (generated files would not appear in the folder).',
      data: { projectId: ctx.projectId },
    });
  }
  const projectDefaults: { image?: string; video?: string } = {};
  if (typeof metadata.imageModel === 'string' && metadata.imageModel) projectDefaults.image = metadata.imageModel;
  if (typeof metadata.videoModel === 'string' && metadata.videoModel) projectDefaults.video = metadata.videoModel;

  const catalogResult = await callDaemon<MediaModelsResponse>(ctx, 'GET', '/api/media/models');
  if (!catalogResult.ok) return emitError(io, catalogResult.error);
  const catalog = isRecord(catalogResult.data) ? catalogResult.data : {};

  // 1. Setup + plan in one board write (the generator overrides, the output node, the edge, runs[0]).
  const createdId = options.create ? ctx.newId() : '';
  const ids = replayableIds(ctx.newId);
  let planned: PlannedWrite | null = null;
  let blocked: StructuredError | null = null;
  const written = await writeBoard(ctx, (board) => {
    planned = null;
    const setup = prepareSetup(board, options, prompt, catalog, projectDefaults, createdId);
    if ('code' in setup) {
      blocked = setup;
      return setup;
    }
    const state = generatorRunState(setup.graph, setup.generatorId);
    if (state.active) {
      return {
        code: 'generation-running',
        message: `generator ${setup.generatorId} is still running (run ${state.runId ?? '?'}); wait for it or stop it in the workspace`,
        data: { generatorId: setup.generatorId, runId: state.runId ?? null, outputNodeId: state.outputNodeId ?? null },
      };
    }
    const compiled = compileGeneration(setup.graph, setup.generatorId, {
      maxReferences: setup.support.maxReferences,
      requiresReference: setup.support.requiresReference,
      labels: referenceLabelSetFor(options.locale),
    });
    if (!compiled.ok) {
      blocked = {
        code: 'invalid-request',
        message:
          compiled.blockReason === 'needs-reference'
            ? `model ${setup.model.id} needs at least one reference image connected to ${setup.generatorId}`
            : `generator ${setup.generatorId} has an empty prompt and no references; pass --prompt or --prompt-file`,
        data: { generatorId: setup.generatorId, reason: compiled.blockReason ?? 'empty-prompt', warnings: compiled.warnings },
      };
      return blocked;
    }
    const labels = new Map(compiled.inputs.map((input) => [input.nodeId, input.label]));
    const plan = planGenerationRun({
      graph: setup.graph,
      generatorId: setup.generatorId,
      compiled,
      model: { id: setup.model.id, provider: setup.model.provider, caps: setup.model.caps },
      params: setup.data.params,
      support: setup.support,
      now: ctx.now(),
      ids: ids.reset(),
      title: runTitle(setup.data.prompt, labels, `${setup.model.label} · ${setup.data.params.aspect}`),
      templateId: setup.data.templateId,
    });
    const ops = generationOpsToBoardOps(board, [...setup.setupOps, ...plan.ops]);
    planned = { ops, plan, warnings: compiled.warnings, generatorId: setup.generatorId };
    return ops;
  });
  if (!written.ok) return emitError(io, written.error);
  const run = planned as PlannedWrite | null;
  if (!run) return emitError(io, blocked ?? { code: 'cli-error', message: 'the run could not be planned' });
  const { plan } = run;
  const outputNodeId = plan.outputNodeId;

  // 2. One POST per candidate, then one board write with every task id (or POST error).
  const states = new Map<string, CandidateState>();
  for (const slot of plan.slots) {
    const node = plan.ops.find((op) => op.type === 'node.add' && op.node.id === outputNodeId);
    const candidate = (node?.type === 'node.add' ? (node.node.data as MediaNodeData).generation?.candidates : undefined)?.find(
      (entry) => entry.id === slot.candidateId,
    );
    if (candidate) states.set(slot.candidateId, { candidate, since: 0, detached: false });
  }
  const posted = await Promise.all(plan.slots.map((slot) => postGenerate(ctx, slot.candidateId, slot.request)));
  const postPatches = posted.map((entry) => entry.patch);
  for (const patch of postPatches) mergeState(states, patch);
  const afterPost = await writeCandidates(ctx, outputNodeId, postPatches);
  if (!afterPost.ok) return emitError(io, afterPost.error);

  // 3. Wait: sequential long-polls (≤ 25 s each) until every candidate is terminal or --timeout elapses.
  if (options.wait) {
    const deadline = ctx.now() + options.timeoutMs;
    let failures = 0;
    for (;;) {
      const active = [...states.values()].filter((state) => isActiveSlot(state.candidate.status) && !state.detached);
      if (active.length === 0) break;
      if (ctx.now() >= deadline) break;
      for (const state of active) {
        const remaining = deadline - ctx.now();
        if (remaining <= 0) break;
        const taskId = state.candidate.taskId;
        if (!taskId) {
          state.detached = true;
          continue;
        }
        const waited = await callDaemon<unknown>(ctx, 'POST', `/api/media/tasks/${encodeURIComponent(taskId)}/wait`, {
          since: state.since,
          timeoutMs: Math.max(0, Math.min(MEDIA_TASK_WAIT_MAX_TIMEOUT_MS, Math.round(remaining))),
        });
        if (!waited.ok && waited.status === 0) {
          failures += 1;
          if (failures >= MAX_WAIT_NETWORK_FAILURES) return emitError(io, waited.error);
          await ctx.sleep(NETWORK_RETRY_MS);
          continue;
        }
        failures = 0;
        let patch: CandidatePatch | null = null;
        if (waited.ok) {
          const snapshot: MediaTaskSnapshotResponse | null = parseMediaTaskSnapshot(waited.data);
          if (!snapshot) {
            state.detached = true;
            continue;
          }
          state.since = snapshot.nextSince;
          if (snapshot.status === state.candidate.status && !isTerminalMediaTaskStatus(snapshot.status)) continue;
          patch = candidatePatchFromSnapshot(state.candidate.id, snapshot, plan.request.model);
        } else if (waited.status === 404) {
          // The task row is gone (daemon restart or GC): find the output by its unique stem.
          const file = await fileByStem(ctx, state.candidate.outputStem);
          if (file === 'error') {
            state.detached = true;
            continue;
          }
          patch = file
            ? {
                id: state.candidate.id,
                status: 'done',
                file: { path: file.name, ...(file.mime ? { mime: file.mime } : {}), size: file.size, mtime: file.mtime },
                error: undefined,
              }
            : { id: state.candidate.id, status: 'lost' };
        } else {
          state.detached = true; // 4xx: cannot be waited out from here
          continue;
        }
        mergeState(states, patch);
        const result = await writeCandidates(ctx, outputNodeId, [patch]);
        if (!result.ok) return emitError(io, result.error);
      }
    }
  }

  // 4. Report.
  const candidates = plan.slots
    .map((slot) => states.get(slot.candidateId)?.candidate)
    .filter((candidate): candidate is GenerationCandidate => Boolean(candidate));
  const status = runStatusOf(candidates);
  const exitCode = exitCodeOf(status);
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          ok: exitCode === BOARD_EXIT_CODES.ok,
          projectId: ctx.projectId,
          generatorId: run.generatorId,
          runId: plan.runId,
          outputNodeId,
          status,
          model: plan.request.model,
          candidates: candidates.map(candidateJson),
          warnings: run.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return { exitCode };
  }
  const done = candidates.filter((candidate) => candidate.status === 'done').length;
  const lines = [
    `Generator ${run.generatorId} · run ${plan.runId} → node ${outputNodeId} · ${status} (${done}/${candidates.length} done) · ${plan.request.model}`,
    ...candidates.map((candidate, index) => {
      const detail = candidate.file?.path ?? (candidate.error ? `${candidate.error.nextStep}: ${candidate.error.message}` : candidate.taskId ? `task ${candidate.taskId}` : '');
      return `  ${index + 1} ${candidate.status}${detail ? ` ${detail}` : ''}`;
    }),
    ...run.warnings.map((warning) => `warning: ${warningText(warning)}`),
  ];
  if (status === 'running') lines.push(`still running; check later with \`od board show --node ${outputNodeId} --json\``);
  io.stdout(`${lines.join('\n')}\n`);
  return { exitCode };
}

function mergeState(states: Map<string, CandidateState>, patch: CandidatePatch): void {
  const state = states.get(patch.id);
  if (!state) return;
  const next: Record<string, unknown> = { ...state.candidate };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  state.candidate = next as unknown as GenerationCandidate;
}

/** Resolves once every write queued on the stream so far has been handed to the OS. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

/**
 * `od board generate` entry (loaded by board-cli.ts, amendment B7): writes to the process streams and
 * reports through `process.exitCode`.
 */
export async function runBoardGenerate(args: string[]): Promise<void> {
  const { exitCode } = await runBoardGenerateCli(args);
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exitCode = exitCode;
}

// ---- helpers --------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
