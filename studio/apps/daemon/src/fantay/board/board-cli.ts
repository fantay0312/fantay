// SPDX-License-Identifier: Apache-2.0
// `od board …` — CLI mirror of the project board (画板), spec 04 §5. Per AGENTS.md "Capability exposure
// (UI/CLI dual-track)" it drives the same `/api/projects/:id/board*` endpoints as the workspace, with
// `--json`, `--prompt-file <path|->` and structured errors. `generate` and `media` live in their own modules
// and are loaded on demand (amendment B7), so those commands never need an edit here.
//
// Kept out of cli.ts so it stays unit-testable without triggering cli.ts's import-time SUBCOMMAND_MAP
// dispatch (mirrors materials-cli.ts).

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  BOARD_EDGE_KINDS,
  BOARD_GENERATOR_SURFACES,
  BOARD_LIMITS,
  BOARD_NODE_KINDS,
  BOARD_PALETTE,
  MEDIA_ASPECT_VALUES,
  boardApiPath,
  boardNodesOnPage,
  boardPagesOf,
  createGeneratorNodeInput,
  isBoardId,
  type BoardActor,
  type BoardDocument,
  type BoardEdgeKind,
  type BoardGetResponse,
  type BoardImportDesignCanvasResponse,
  type BoardImportDesignCanvasResult,
  type BoardNode,
  type BoardNodeKind,
  type BoardOp,
  type BoardPatchResponse,
  type BoardPlacement,
  type BoardSyncResponse,
  type CanvasDocumentSummary,
  type GeneratorNodeData,
  type GeneratorParams,
  type MediaAspect,
} from '@open-design/contracts';

import { resolveDaemonUrl } from '../../daemon-url.js';
import { BOARD_EXIT_CODES, BOARD_SUBCOMMANDS, BOARD_USAGE, isBoardHelpArg, type BoardSubcommand } from './board-cli-help.js';

export interface BoardCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

export interface BoardCliResult {
  exitCode: number;
}

/** Subcommands served by their own modules (amendment B7). */
export type BoardExtensionName = 'generate' | 'media';

export interface BoardCliDeps {
  /** Loads the module behind `od board generate|media`; rejects like `import()` when it is absent. */
  importExtension?: (name: BoardExtensionName) => Promise<unknown>;
}

const defaultIo: BoardCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
};

/** Spec 04 §5.1 exit table (+ amendment B7 for generate); every other error code exits 1. */
const EXIT_BY_CODE = new Map<string, number>([
  ['invalid-request', BOARD_EXIT_CODES.usage],
  ['daemon-not-running', BOARD_EXIT_CODES.daemonNotRunning],
  ['missing-input', BOARD_EXIT_CODES.missingInput],
  ['project-not-found', BOARD_EXIT_CODES.projectNotFound],
  ['board-revision-conflict', BOARD_EXIT_CODES.revisionConflict],
]);

/** A mutating command sends at most this many writes (one per board read) before giving up on conflicts. */
const MAX_ATTEMPTS = 3;
const IMPORT_CHUNK_SIZE: number = BOARD_LIMITS.maxImportDocuments;

// ---- extension modules (`generate`, `media`) -------------------------------------------------

const BOARD_EXTENSIONS: Record<BoardExtensionName, { file: string; exportName: string }> = {
  generate: { file: 'board-generate-cli.js', exportName: 'runBoardGenerate' },
  media: { file: 'media-ops-cli.js', exportName: 'runBoardMedia' },
};

type ExtensionImport = { ok: true; module: unknown } | { ok: false; error: unknown };

/**
 * Loads the module behind `od board generate|media`. The specifiers are literal on purpose: tsc emits them
 * unchanged next to this file in dist/, and the packaged daemon's esbuild prebundle can only include a module
 * whose specifier is literal. Inside a try block esbuild also accepts a path that does not exist yet and leaves
 * that import to fail at run time. `@ts-ignore` covers TS2307 until the modules are added.
 */
async function importBoardExtension(name: BoardExtensionName): Promise<ExtensionImport> {
  try {
    if (name === 'generate') {
      // @ts-ignore TS2307 until apps/daemon/src/fantay/board-generate-cli.ts exists (spec 05 §8).
      return { ok: true, module: (await import('../board-generate-cli.js')) as unknown };
    }
    return { ok: true, module: (await import('../media-ops/media-ops-cli.js')) as unknown };
  } catch (error) {
    return { ok: false, error };
  }
}

async function loadExtension(name: BoardExtensionName, deps: BoardCliDeps): Promise<ExtensionImport> {
  if (!deps.importExtension) return importBoardExtension(name);
  try {
    return { ok: true, module: await deps.importExtension(name) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** True when `error` reports the extension module itself as absent (not one of its own imports). */
function isMissingExtensionModule(error: unknown, file: string): boolean {
  if (!isRecord(error) || error.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const missing = /Cannot find (?:module|package) '([^']+)'/u.exec(typeof error.message === 'string' ? error.message : '')?.[1];
  return missing === undefined || missing.replace(/\\/gu, '/').endsWith(`/${file}`);
}

function exitCodeOf(code: unknown): number {
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/u.test(code)) return Number(code);
  return BOARD_EXIT_CODES.ok;
}

async function runBoardExtension(
  name: BoardExtensionName,
  args: string[],
  io: BoardCliIo,
  deps: BoardCliDeps,
): Promise<BoardCliResult> {
  const extension = BOARD_EXTENSIONS[name];
  const loaded = await loadExtension(name, deps);
  if (!loaded.ok) {
    if (!isMissingExtensionModule(loaded.error, extension.file)) {
      return emitError(io, { code: 'cli-error', message: `od board ${name} failed to load: ${errorMessage(loaded.error)}` });
    }
    return notImplemented(io, name, errorMessage(loaded.error));
  }
  const run = isRecord(loaded.module) ? loaded.module[extension.exportName] : undefined;
  if (typeof run !== 'function') return notImplemented(io, name, `the module does not export ${extension.exportName}`);
  // The module writes to the process streams and reports through process.exitCode (SUBCOMMAND_MAP contract).
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await (run as (args: string[]) => Promise<void>)(args);
    return { exitCode: exitCodeOf(process.exitCode) };
  } catch (error) {
    return emitError(io, { code: 'cli-error', message: `od board ${name} failed: ${errorMessage(error)}` });
  } finally {
    process.exitCode = previous;
  }
}

function notImplemented(io: BoardCliIo, name: BoardExtensionName, cause: string): BoardCliResult {
  return emitError(io, {
    code: 'not-implemented',
    message: `od board ${name} is not available in this build.`,
    data: { subcommand: name, cause },
  });
}

// ---- argument parsing -------------------------------------------------------------------------

type CoreSubcommand = Exclude<BoardSubcommand, BoardExtensionName>;

interface FlagSpec {
  string?: readonly string[];
  boolean?: readonly string[];
  repeatable?: readonly string[];
}

const COMMON_STRING_FLAGS = ['project', 'workspace', 'workspace-member', 'daemon-url'] as const;
const COMMON_BOOLEAN_FLAGS = ['json', 'help'] as const;

/** Flags of `add` per node kind; every kind also takes ADD_PLACEMENT_FLAGS. */
const ADD_KIND_FLAGS: Record<BoardNodeKind, readonly string[]> = {
  frame: ['path', 'live-artifact', 'device'],
  web: ['url', 'device'],
  image: ['path'],
  video: ['path'],
  audio: ['path'],
  note: ['text', 'prompt-file', 'color'],
  shape: ['shape', 'text', 'prompt-file', 'fill', 'stroke'],
  group: ['role'],
  generator: ['surface', 'model', 'prompt', 'prompt-file', 'count', 'aspect', 'quality', 'resolution', 'duration'],
  design: ['path'],
  motion: ['movie', 'composition', 'render'],
};
const ADD_PLACEMENT_FLAGS = ['x', 'y', 'near', 'side', 'group', 'title', 'variant-label', 'id', 'page'] as const;

const SUBCOMMAND_FLAGS: Record<CoreSubcommand, FlagSpec> = {
  show: { string: ['kind'], boolean: ['no-sync', 'include-sync'], repeatable: ['node'] },
  add: { string: [...new Set([...Object.values(ADD_KIND_FLAGS).flat(), ...ADD_PLACEMENT_FLAGS])], boolean: ['if-absent'] },
  update: {
    string: ['title', 'text', 'prompt', 'prompt-file', 'x', 'y', 'w', 'h', 'locked', 'hidden', 'variant-label', 'parent', 'patch-file'],
  },
  remove: { boolean: ['cascade'] },
  move: { string: ['x', 'y', 'dx', 'dy'] },
  layout: { string: ['group', 'nodes', 'mode', 'gap', 'columns'], boolean: ['all'] },
  connect: { string: ['kind', 'label'] },
  group: { string: ['title', 'role'] },
  ungroup: {},
  sync: {},
  apply: { string: ['prompt-file'] },
  replace: { string: ['file', 'base-revision'], boolean: ['empty'] },
  'import-canvas': { boolean: ['all'] },
  pages: { string: ['add', 'rename', 'remove', 'title'] },
};

/** Flags whose value `-` means stdin; stdin can be read once per call. */
const STDIN_FLAGS = ['prompt-file', 'patch-file', 'file'] as const;

interface ParsedArgs {
  flags: Map<string, string>;
  repeated: Map<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
}

class UsageError extends Error {}

function parseArgs(sub: CoreSubcommand, args: readonly string[]): ParsedArgs {
  const spec = SUBCOMMAND_FLAGS[sub];
  const stringFlags = new Set<string>([...COMMON_STRING_FLAGS, ...(spec.string ?? [])]);
  const booleanFlags = new Set<string>([...COMMON_BOOLEAN_FLAGS, ...(spec.boolean ?? [])]);
  const repeatableFlags = new Set<string>(spec.repeatable ?? []);
  const parsed: ParsedArgs = { flags: new Map(), repeated: new Map(), booleans: new Set(), positionals: [] };
  let flagsDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flagsDone || !arg.startsWith('--')) {
      if (!flagsDone && arg === '-h') parsed.booleans.add('help');
      else parsed.positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      flagsDone = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (booleanFlags.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} does not take a value`);
      parsed.booleans.add(key);
      continue;
    }
    if (!stringFlags.has(key) && !repeatableFlags.has(key)) {
      throw new UsageError(`unknown flag for od board ${sub}: --${key}. Run \`od board --help\` for the accepted flags.`);
    }
    let value: string | undefined;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`flag --${key} requires a value`);
    if (repeatableFlags.has(key)) parsed.repeated.set(key, [...(parsed.repeated.get(key) ?? []), value]);
    else parsed.flags.set(key, value);
  }
  const stdinFlags = STDIN_FLAGS.filter((flag) => parsed.flags.get(flag) === '-');
  if (stdinFlags.length > 1) throw new UsageError(`only one of --${stdinFlags.join(', --')} can read stdin (-)`);
  return parsed;
}

function numberFlag(parsed: ParsedArgs, key: string, opts: { integer?: boolean; min?: number; max?: number } = {}): number | undefined {
  const raw = parsed.flags.get(key);
  if (raw === undefined) return undefined;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  const kind = opts.integer ? 'an integer' : 'a number';
  if (!Number.isFinite(value) || (opts.integer && !Number.isInteger(value))) throw new UsageError(`--${key} expects ${kind}, got "${raw}"`);
  if ((opts.min !== undefined && value < opts.min) || (opts.max !== undefined && value > opts.max)) {
    const range = opts.max !== undefined ? `${opts.min ?? '-∞'}..${opts.max}` : `≥ ${opts.min}`;
    throw new UsageError(`--${key} must be ${range}, got ${raw}`);
  }
  return value;
}

function enumFlag<T extends string>(parsed: ParsedArgs, key: string, values: readonly T[]): T | undefined {
  const raw = parsed.flags.get(key);
  if (raw === undefined) return undefined;
  if (!(values as readonly string[]).includes(raw)) throw new UsageError(`--${key} must be one of ${values.join(', ')}, got "${raw}"`);
  return raw as T;
}

function booleanValueFlag(parsed: ParsedArgs, key: string): boolean | undefined {
  const raw = parsed.flags.get(key);
  if (raw === undefined) return undefined;
  if (raw !== 'true' && raw !== 'false') throw new UsageError(`--${key} must be true or false, got "${raw}"`);
  return raw === 'true';
}

function requiredFlag(parsed: ParsedArgs, key: string, what: string): string {
  const value = parsed.flags.get(key)?.trim();
  if (!value) throw new UsageError(`${what} requires --${key}`);
  return value;
}

/** Project-relative POSIX path as the board stores it (`ProjectFile.name`). */
function projectPath(raw: string): string {
  let value = raw.trim().replace(/\\/gu, '/');
  while (value.startsWith('./')) value = value.slice(2);
  if (!value) throw new UsageError('expected a project-relative path');
  return value;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/u;

function colorFlag(parsed: ParsedArgs, key: string): string | undefined {
  const raw = parsed.flags.get(key);
  if (raw === undefined) return undefined;
  if (raw === 'none' || HEX_COLOR.test(raw) || (BOARD_PALETTE as readonly string[]).includes(raw)) return raw;
  throw new UsageError(`--${key} must be none, #RRGGBB[AA] or one of ${BOARD_PALETTE.join(', ')}, got "${raw}"`);
}

/** Inline text, a file, or stdin (`-`); files and stdin lose trailing whitespace (same as materials-cli). */
type TextSource = { kind: 'inline'; value: string } | { kind: 'file'; path: string };

function textSource(parsed: ParsedArgs, inlineFlags: readonly string[]): TextSource | undefined {
  const given = [...inlineFlags, 'prompt-file'].filter((flag) => parsed.flags.has(flag));
  if (given.length > 1) throw new UsageError(`use only one of --${given.join(', --')}`);
  const flag = given[0];
  if (flag === undefined) return undefined;
  const value = parsed.flags.get(flag)!;
  return flag === 'prompt-file' ? { kind: 'file', path: value } : { kind: 'inline', value };
}

async function readInput(io: BoardCliIo, flag: string, path: string): Promise<string> {
  try {
    const text = path === '-' ? await io.readStdin() : await readFile(path, 'utf8');
    return text.replace(/\s+$/u, '');
  } catch (error) {
    throw new UsageError(`cannot read --${flag} ${path}: ${errorMessage(error)}`);
  }
}

async function readText(io: BoardCliIo, source: TextSource): Promise<string> {
  return source.kind === 'inline' ? source.value : readInput(io, 'prompt-file', source.path);
}

async function readJsonInput(io: BoardCliIo, flag: string, path: string): Promise<unknown> {
  const text = await readInput(io, flag, path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`--${flag} ${path} is not valid JSON: ${errorMessage(error)}`);
  }
}

function idList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

// ---- daemon calls --------------------------------------------------------------------------------

interface StructuredError {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

type CallResult<T> = { ok: true; data: T } | { ok: false; error: StructuredError };

interface BoardCliContext {
  io: BoardCliIo;
  json: boolean;
  projectId: string;
  base: string;
  headers: Record<string, string>;
  actor: BoardActor;
}

async function callDaemon<T>(
  ctx: BoardCliContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  pathname: string,
  body?: unknown,
): Promise<CallResult<T>> {
  let resp: Response;
  try {
    resp = await fetch(`${ctx.base}${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...ctx.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // undici reports "fetch failed" and keeps the reason (ECONNREFUSED, bad port, …) on `cause`.
    const cause = isRecord(error) && isRecord(error.cause) ? (error.cause.code ?? error.cause.message) : undefined;
    return {
      ok: false,
      error: {
        code: 'daemon-not-running',
        message: `Cannot reach the daemon at ${ctx.base}: ${errorMessage(error)}${typeof cause === 'string' && cause ? ` (${cause})` : ''}`,
      },
    };
  }
  const raw = await resp.text().catch(() => '');
  let payload: unknown;
  try {
    payload = raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    payload = undefined;
  }
  if (!resp.ok) return { ok: false, error: httpError(resp.status, payload, raw) };
  if (!isRecord(payload)) {
    return { ok: false, error: { code: 'daemon-error', message: 'the daemon returned a malformed response', data: { status: resp.status } } };
  }
  return { ok: true, data: payload as T };
}

/**
 * Daemon error envelope → CLI error. Board routes answer `{error:{code,message,details}}`; older routes
 * answer `{error:'<message>'}` or `{error:'<code>', message}`.
 */
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
    }
  } else if (isRecord(envelope)) {
    if (typeof envelope.code === 'string') daemonCode = envelope.code;
    if (typeof envelope.message === 'string') message = envelope.message;
    details = envelope.details;
  }
  message ??= `HTTP ${status}${raw ? `: ${raw.slice(0, 500)}` : ''}`;
  const data: Record<string, unknown> = { status, ...(details !== undefined ? { details } : {}) };
  const remapped = (code: string): StructuredError => ({
    code,
    message,
    data: { ...data, ...(daemonCode !== undefined ? { daemonCode } : {}) },
  });
  if (status === 404 && (daemonCode === 'PROJECT_NOT_FOUND' || daemonCode === 'project-not-found')) return remapped('project-not-found');
  if (status === 409 && isRecord(details) && details.kind === 'board-conflict') return remapped('board-revision-conflict');
  if (status === 400) return remapped('invalid-request');
  return { code: daemonCode ?? 'daemon-error', message, data };
}

async function getBoard(ctx: BoardCliContext, includeSync = false): Promise<CallResult<BoardGetResponse>> {
  const got = await callDaemon<BoardGetResponse>(ctx, 'GET', boardApiPath(ctx.projectId, includeSync ? '?include=sync' : ''));
  if (got.ok && !(isRecord(got.data.board) && Array.isArray(got.data.board.nodes) && Array.isArray(got.data.board.edges))) {
    return { ok: false, error: { code: 'daemon-error', message: 'the daemon returned a malformed board' } };
  }
  return got;
}

function isRevisionConflict<T>(result: CallResult<T>): boolean {
  return !result.ok && result.error.code === 'board-revision-conflict';
}

/** Runs `attempt` again while it ends in a revision conflict, MAX_ATTEMPTS times in all (spec 04 §5.1). */
async function retryOnConflict<T>(attempt: () => Promise<CallResult<T>>): Promise<CallResult<T>> {
  let result = await attempt();
  for (let tries = 1; tries < MAX_ATTEMPTS && isRevisionConflict(result); tries += 1) result = await attempt();
  if (!result.ok && isRevisionConflict(result)) {
    return { ok: false, error: { ...result.error, message: `${result.error.message} (gave up after ${MAX_ATTEMPTS} attempts)` } };
  }
  return result;
}

/**
 * Every mutating command reads the board first and sends `baseRevision` (plus `expectRev` the builder takes
 * from the fetched entities); a conflict re-reads and rebuilds before the next attempt.
 */
function patchBoard(
  ctx: BoardCliContext,
  buildOps: (board: BoardDocument) => BoardOp[] | StructuredError,
): Promise<CallResult<BoardPatchResponse>> {
  return retryOnConflict(async () => {
    const got = await getBoard(ctx);
    if (!got.ok) return got;
    const ops = buildOps(got.data.board);
    if (!Array.isArray(ops)) return { ok: false, error: ops };
    return callDaemon<BoardPatchResponse>(ctx, 'PATCH', boardApiPath(ctx.projectId), {
      baseRevision: got.data.board.revision,
      ops,
      actor: ctx.actor,
    });
  });
}

// ---- output ---------------------------------------------------------------------------------------

function emitError(io: BoardCliIo, error: StructuredError, exitCode?: number): BoardCliResult {
  io.stderr(`${JSON.stringify({ error: { code: error.code, message: error.message, data: error.data ?? {} } })}\n`);
  return { exitCode: exitCode ?? EXIT_BY_CODE.get(error.code) ?? BOARD_EXIT_CODES.error };
}

function usageError(io: BoardCliIo, message: string): BoardCliResult {
  return emitError(io, { code: 'invalid-request', message }, BOARD_EXIT_CODES.usage);
}

function printJson(io: BoardCliIo, data: unknown): BoardCliResult {
  io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  return { exitCode: BOARD_EXIT_CODES.ok };
}

function printText(io: BoardCliIo, lines: readonly string[]): BoardCliResult {
  io.stdout(`${lines.join('\n')}\n`);
  return { exitCode: BOARD_EXIT_CODES.ok };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function excerpt(text: string, max = 60): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `<title|path|url>` column of `od board show`, with a readable fallback for text-only kinds. */
function nodeLabel(node: BoardNode): string {
  if (node.title) return excerpt(node.title);
  switch (node.kind) {
    case 'frame':
      return node.ref?.path ?? (node.liveArtifactId ? `live:${node.liveArtifactId}` : '');
    case 'image':
    case 'video':
    case 'audio':
      return node.ref?.path ?? '';
    case 'design':
      return node.ref.path;
    case 'web':
      return node.url;
    case 'motion':
      return node.source.type === 'movie' ? `movie:${node.source.projectId}` : node.source.ref.path;
    case 'note':
      return excerpt(node.text);
    case 'shape':
      return excerpt(node.text ?? node.shape);
    case 'generator':
      return excerpt(node.prompt);
    case 'group':
      return node.sectionKind ? `${node.role}:${node.sectionKind}` : node.role;
    default:
      return '';
  }
}

function nodeLine(node: BoardNode): string {
  const flags: string[] = [];
  if (node.parentId) flags.push(`[in ${node.parentId}]`);
  if (node.variantLabel) flags.push(`[variant ${node.variantLabel}]`);
  if ('pending' in node && node.pending) flags.push(`[pending ${node.pending.status}]`);
  if (node.missing) flags.push('[missing]');
  if (node.locked) flags.push('[locked]');
  if (node.hidden) flags.push('[hidden]');
  const geometry = `x=${formatNumber(node.x)} y=${formatNumber(node.y)} ${formatNumber(node.w)}×${formatNumber(node.h)}`;
  return [node.id, node.kind, nodeLabel(node) || '-', geometry, ...(flags.length ? [flags.join(' ')] : [])].join('\t');
}

function patchSummary(response: BoardPatchResponse, summary: string): string[] {
  const lines = [`${summary} · board r${response.revision}`];
  for (const result of response.results) {
    if (result.status !== 'skipped') continue;
    lines.push(`  op ${result.index} skipped (${result.reason ?? 'conflict'})${result.ids.length ? `: ${result.ids.join(', ')}` : ''}`);
  }
  return lines;
}

// ---- subcommands ------------------------------------------------------------------------------------

/** A validated command: `run` does the I/O once the project, daemon and identity are resolved. */
type PreparedCommand = (ctx: BoardCliContext) => Promise<BoardCliResult>;
type Preparer = (parsed: ParsedArgs) => PreparedCommand;

function finish<T>(ctx: BoardCliContext, result: CallResult<T>, text: (data: T) => string[]): BoardCliResult {
  if (!result.ok) return emitError(ctx.io, result.error);
  if (ctx.json) return printJson(ctx.io, result.data);
  return printText(ctx.io, text(result.data));
}

function noPositionals(parsed: ParsedArgs, sub: string): void {
  if (parsed.positionals.length > 0) throw new UsageError(`od board ${sub} takes no arguments (got ${parsed.positionals.join(' ')})`);
}

function nodeNotFound(ctx: BoardCliContext, id: string): StructuredError {
  return { code: 'node-not-found', message: `No node ${id} on the board of project ${ctx.projectId}.`, data: { nodeId: id } };
}

function findNode(board: BoardDocument, id: string): BoardNode | undefined {
  return board.nodes.find((node) => node.id === id);
}

/** The group check shared by `add --group`, `update --parent` and `layout --group`. */
function groupError(ctx: BoardCliContext, board: BoardDocument, id: string): StructuredError | undefined {
  const node = findNode(board, id);
  if (!node) return nodeNotFound(ctx, id);
  if (node.kind !== 'group') return { code: 'invalid-request', message: `${id} is a ${node.kind} node, not a group.`, data: { nodeId: id } };
  return undefined;
}

const prepareShow: Preparer = (parsed) => {
  noPositionals(parsed, 'show');
  const kind = enumFlag(parsed, 'kind', BOARD_NODE_KINDS);
  const only = new Set(idList(parsed.repeated.get('node') ?? []));
  const sync = !parsed.booleans.has('no-sync');
  const includeSync = parsed.booleans.has('include-sync');
  return async (ctx) => {
    if (sync) {
      const synced = await callDaemon<BoardSyncResponse>(ctx, 'POST', boardApiPath(ctx.projectId, '/sync'), {
        reason: 'manual',
        actor: ctx.actor,
      });
      // A viewer may read but not sync: show the stored board instead.
      if (!synced.ok && synced.error.data?.status !== 403) return emitError(ctx.io, synced.error);
    }
    const got = await getBoard(ctx, includeSync);
    if (!got.ok) return emitError(ctx.io, got.error);
    const board = got.data.board;
    const filtered = kind !== undefined || only.size > 0;
    const nodes = filtered
      ? board.nodes.filter((node) => (only.size === 0 || only.has(node.id)) && (kind === undefined || node.kind === kind))
      : board.nodes;
    if (ctx.json) {
      if (!filtered) return printJson(ctx.io, got.data);
      const kept = new Set(nodes.map((node) => node.id));
      const edges = board.edges.filter((edge) => kept.has(edge.from) || kept.has(edge.to));
      return printJson(ctx.io, { ...got.data, board: { ...board, nodes, edges } });
    }
    const header = `Board r${board.revision} · ${board.nodes.length} nodes · ${board.edges.length} edges · project ${board.projectId || ctx.projectId}`;
    return printText(ctx.io, [header, ...nodes.map(nodeLine)]);
  };
};

const DEVICES = ['desktop', 'tablet', 'mobile', 'custom'] as const;
const SHAPES = ['rect', 'ellipse', 'text'] as const;
const USER_GROUP_ROLES = ['section', 'variants'] as const;

/** Builds the kind-specific part of an `add` draft; text (note/shape/generator) is read later. */
function addDraftBuilder(kind: BoardNodeKind, parsed: ParsedArgs): { text?: TextSource; build: (text: string | undefined) => Record<string, unknown> } {
  switch (kind) {
    case 'frame': {
      const path = parsed.flags.get('path');
      const live = parsed.flags.get('live-artifact')?.trim();
      if ((path === undefined) === (live === undefined || live === '')) throw new UsageError('add frame needs exactly one of --path <file.html> or --live-artifact <id>');
      const device = enumFlag(parsed, 'device', DEVICES);
      const base = path !== undefined ? { ref: { path: projectPath(path) } } : { ref: null, liveArtifactId: live };
      return { build: () => ({ kind, ...base, ...(device ? { device } : {}) }) };
    }
    case 'web': {
      const url = requiredFlag(parsed, 'url', 'add web');
      const device = enumFlag(parsed, 'device', DEVICES);
      return { build: () => ({ kind, url, ...(device ? { device } : {}) }) };
    }
    case 'image':
    case 'video':
    case 'audio': {
      const path = projectPath(requiredFlag(parsed, 'path', `add ${kind}`));
      return { build: () => ({ kind, ref: { path } }) };
    }
    case 'note': {
      const text = textSource(parsed, ['text']);
      if (!text) throw new UsageError('add note needs --text <t> or --prompt-file <path|->');
      const color = enumFlag(parsed, 'color', BOARD_PALETTE);
      return { text, build: (value) => ({ kind, text: value ?? '', ...(color ? { color } : {}) }) };
    }
    case 'shape': {
      const shape = enumFlag(parsed, 'shape', SHAPES);
      if (!shape) throw new UsageError(`add shape requires --shape ${SHAPES.join('|')}`);
      const text = textSource(parsed, ['text']);
      const fill = colorFlag(parsed, 'fill');
      const stroke = colorFlag(parsed, 'stroke');
      return {
        ...(text ? { text } : {}),
        build: (value) => ({
          kind,
          shape,
          ...(value !== undefined ? { text: value } : {}),
          ...(fill ? { fill } : {}),
          ...(stroke ? { stroke } : {}),
        }),
      };
    }
    case 'group': {
      const role = enumFlag(parsed, 'role', USER_GROUP_ROLES);
      if (!role) throw new UsageError(`add group requires --role ${USER_GROUP_ROLES.join('|')}`);
      return { build: () => ({ kind, role }) };
    }
    case 'generator':
      return generatorDraftBuilder(parsed);
    case 'design': {
      const path = projectPath(requiredFlag(parsed, 'path', 'add design'));
      const format = /\.fig$/iu.test(path) ? 'fig' : /\.op$/iu.test(path) ? 'op' : null;
      if (!format) throw new UsageError('add design needs a .fig or .op --path (for example designs/home.fig)');
      return { build: () => ({ kind, ref: { path }, format }) };
    }
    case 'motion': {
      const movie = parsed.flags.get('movie')?.trim();
      const composition = parsed.flags.get('composition');
      const render = parsed.flags.get('render');
      if (Boolean(movie) === (composition !== undefined)) throw new UsageError('add motion needs exactly one of --movie <projectId> or --composition <path>');
      if (render !== undefined && composition === undefined) throw new UsageError('--render applies to --composition motion nodes');
      const source = movie ? { type: 'movie', projectId: movie } : { type: 'composition', ref: { path: projectPath(composition!) } };
      const renderRef = render !== undefined ? { render: { path: projectPath(render) } } : {};
      return { build: () => ({ kind, source, ...renderRef }) };
    }
    default:
      throw new UsageError(`unsupported node kind: ${String(kind)}`);
  }
}

function generatorDraftBuilder(parsed: ParsedArgs): { text: TextSource; build: (text: string | undefined) => Record<string, unknown> } {
  const rawSurface = parsed.flags.get('surface');
  if (rawSurface === 'audio') throw new UsageError('audio generators are not available yet; --surface must be image or video');
  const surface = enumFlag(parsed, 'surface', BOARD_GENERATOR_SURFACES);
  if (!surface) throw new UsageError(`add generator requires --surface ${BOARD_GENERATOR_SURFACES.join('|')}`);
  const model = requiredFlag(parsed, 'model', 'add generator');
  const text = textSource(parsed, ['prompt']);
  if (!text) throw new UsageError('add generator needs --prompt <text> or --prompt-file <path|->');
  const count = numberFlag(parsed, 'count', { integer: true, min: 1, max: BOARD_LIMITS.maxGeneratorCount });
  const aspect = enumFlag<MediaAspect>(parsed, 'aspect', MEDIA_ASPECT_VALUES);
  const duration = numberFlag(parsed, 'duration');
  if (duration !== undefined && surface !== 'video') throw new UsageError('--duration applies to video generators');
  if (duration !== undefined && duration <= 0) throw new UsageError('--duration must be greater than 0 seconds');
  const quality = parsed.flags.get('quality')?.trim();
  const resolution = parsed.flags.get('resolution')?.trim();
  const params: Partial<GeneratorParams> = {
    ...(aspect ? { aspect } : {}),
    ...(count !== undefined ? { count: count as GeneratorParams['count'] } : {}),
    ...(duration !== undefined ? { length: duration } : {}),
    ...(quality ? { quality } : {}),
    ...(resolution ? { resolution } : {}),
  };
  return {
    text,
    build: (prompt) => {
      // Same defaults as a generator created in the UI (count, aspect, video length, empty run history).
      const data = createGeneratorNodeInput({ id: 'draft', x: 0, y: 0, surface, prompt: prompt ?? '', model, params }).data as GeneratorNodeData;
      return { kind: 'generator', ...data };
    },
  };
}

const prepareAdd: Preparer = (parsed) => {
  if (parsed.positionals.length !== 1) throw new UsageError(`add takes exactly one <kind> (${BOARD_NODE_KINDS.join(', ')})`);
  const kind = parsed.positionals[0]! as BoardNodeKind;
  if (!(BOARD_NODE_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`unknown node kind: ${kind}. Expected one of ${BOARD_NODE_KINDS.join(', ')}.`);
  }
  const allowed = new Set<string>([...COMMON_STRING_FLAGS, ...ADD_KIND_FLAGS[kind], ...ADD_PLACEMENT_FLAGS]);
  for (const flag of parsed.flags.keys()) {
    if (!allowed.has(flag)) throw new UsageError(`--${flag} does not apply to ${kind} nodes`);
  }
  const draft = addDraftBuilder(kind, parsed);
  const x = numberFlag(parsed, 'x');
  const y = numberFlag(parsed, 'y');
  if ((x === undefined) !== (y === undefined)) throw new UsageError('pass --x and --y together');
  const near = parsed.flags.get('near')?.trim();
  const side = enumFlag(parsed, 'side', ['right', 'below'] as const);
  if (near !== undefined && x !== undefined) throw new UsageError('use either --x/--y or --near, not both');
  if (side !== undefined && !near) throw new UsageError('--side needs --near <nodeId>');
  const id = parsed.flags.get('id');
  if (id !== undefined && !isBoardId(id)) throw new UsageError(`--id must be 3-64 letters, digits, "_" or "-", got "${id}"`);
  const parentId = parsed.flags.get('group')?.trim();
  const title = parsed.flags.get('title');
  const variantLabel = parsed.flags.get('variant-label');
  const page = parsed.flags.get('page')?.trim();
  const placement: BoardPlacement | undefined = near ? { mode: 'near', nodeId: near, ...(side ? { side } : {}) } : undefined;
  const ifAbsent = parsed.booleans.has('if-absent');
  return async (ctx) => {
    const text = draft.text ? await readText(ctx.io, draft.text) : undefined;
    const node = {
      ...draft.build(text),
      ...(id !== undefined ? { id } : {}),
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
      ...(parentId ? { parentId } : {}),
      ...(page ? { page } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(variantLabel !== undefined ? { variantLabel } : {}),
    };
    const result = await patchBoard(ctx, (board) => {
      if (page && !boardPagesOf(board).some((entry) => entry.id === page)) {
        return { code: 'page-not-found', message: `no page ${page} on the board of project ${ctx.projectId}`, data: { page } };
      }
      if (parentId) {
        const error = groupError(ctx, board, parentId);
        if (error) return error;
      }
      if (near && !findNode(board, near)) return nodeNotFound(ctx, near);
      // A taken id is a 409 `exists` that no re-read resolves; report it instead of retrying into exit 72.
      if (id !== undefined && !ifAbsent && (findNode(board, id) || board.edges.some((edge) => edge.id === id))) {
        return {
          code: 'node-exists',
          message: `${id} is already used on the board of project ${ctx.projectId}; pass --if-absent to keep the existing one.`,
          data: { nodeId: id },
        };
      }
      return [{ op: 'add', node, ...(placement ? { placement } : {}), ...(ifAbsent ? { ifAbsent: true } : {}) } as BoardOp];
    });
    return finish(ctx, result, (response) => {
      const first = response.results[0];
      const summary = first?.status === 'applied' ? `Added ${kind} ${first.ids.join(', ')}` : `Nothing added`;
      return patchSummary(response, summary);
    });
  };
};

const prepareUpdate: Preparer = (parsed) => {
  if (parsed.positionals.length !== 1) throw new UsageError('update takes exactly one <nodeId>');
  const id = parsed.positionals[0]!;
  const text = textSource(parsed, ['text', 'prompt']);
  const patchFile = parsed.flags.get('patch-file');
  const flagPatch: Record<string, unknown> = {};
  const title = parsed.flags.get('title');
  if (title !== undefined) flagPatch.title = title;
  for (const key of ['x', 'y'] as const) {
    const value = numberFlag(parsed, key);
    if (value !== undefined) flagPatch[key] = value;
  }
  for (const key of ['w', 'h'] as const) {
    const value = numberFlag(parsed, key, { min: BOARD_LIMITS.minNodeSize });
    if (value !== undefined) flagPatch[key] = value;
  }
  const locked = booleanValueFlag(parsed, 'locked');
  if (locked !== undefined) flagPatch.locked = locked;
  const hidden = booleanValueFlag(parsed, 'hidden');
  if (hidden !== undefined) flagPatch.hidden = hidden;
  const variantLabel = parsed.flags.get('variant-label');
  if (variantLabel !== undefined) flagPatch.variantLabel = variantLabel === 'none' ? null : variantLabel;
  const parent = parsed.flags.get('parent')?.trim();
  if (parent !== undefined) flagPatch.parentId = parent === 'none' || parent === '' ? null : parent;
  if (!text && patchFile === undefined && Object.keys(flagPatch).length === 0) {
    throw new UsageError('update needs at least one field flag or --patch-file');
  }
  return async (ctx) => {
    const filePatch = patchFile !== undefined ? await readJsonInput(ctx.io, 'patch-file', patchFile) : {};
    if (!isRecord(filePatch)) throw new UsageError('--patch-file must hold a JSON object (a node patch)');
    const value = text ? await readText(ctx.io, text) : undefined;
    const patch = { ...filePatch, ...flagPatch };
    if (value === undefined && Object.keys(patch).length === 0) throw new UsageError('nothing to update: the patch is empty');
    const result = await patchBoard(ctx, (board) => {
      const node = findNode(board, id);
      if (!node) return nodeNotFound(ctx, id);
      const next: Record<string, unknown> = { ...patch };
      if (value !== undefined) {
        if (node.kind === 'generator') next.prompt = value;
        else if (node.kind === 'note' || node.kind === 'shape') next.text = value;
        else return { code: 'invalid-request', message: `--text applies to note, shape and generator nodes; ${id} is a ${node.kind}.` };
      }
      if (typeof next.parentId === 'string') {
        const error = groupError(ctx, board, next.parentId);
        if (error) return error;
      }
      return [{ op: 'update', id, patch: next, expectRev: node.rev } as BoardOp];
    });
    return finish(ctx, result, (response) => {
      const first = response.results[0];
      return patchSummary(response, first?.status === 'applied' ? `Updated ${id}` : `No change to ${id}`);
    });
  };
};

const prepareRemove: Preparer = (parsed) => {
  const ids = idList(parsed.positionals);
  if (ids.length === 0) throw new UsageError('remove needs at least one <nodeId>');
  const cascade = parsed.booleans.has('cascade');
  return async (ctx) => {
    const result = await patchBoard(ctx, (board) => {
      // Unknown ids are skipped by the daemon; only existing ones carry an expected rev.
      const expectRev: Record<string, number> = {};
      for (const id of ids) {
        const node = findNode(board, id);
        if (node) expectRev[id] = node.rev;
      }
      return [{ op: 'remove', ids, ...(cascade ? { cascade: true } : {}), ...(Object.keys(expectRev).length > 0 ? { expectRev } : {}) }];
    });
    return finish(ctx, result, (response) => {
      const first = response.results[0];
      return patchSummary(response, first?.status === 'applied' ? `Removed ${first.ids.join(', ')}` : 'Nothing removed');
    });
  };
};

const prepareMove: Preparer = (parsed) => {
  const ids = idList(parsed.positionals);
  if (ids.length === 0) throw new UsageError('move needs at least one <nodeId>');
  const x = numberFlag(parsed, 'x');
  const y = numberFlag(parsed, 'y');
  const dx = numberFlag(parsed, 'dx');
  const dy = numberFlag(parsed, 'dy');
  const absolute = x !== undefined || y !== undefined;
  const relative = dx !== undefined || dy !== undefined;
  if (absolute === relative) throw new UsageError('move needs --x <n> --y <n>, or --dx <n> and/or --dy <n>');
  if (absolute && (x === undefined || y === undefined)) throw new UsageError('pass --x and --y together');
  return async (ctx) => {
    const result = await patchBoard(ctx, (board) => {
      const nodes: BoardNode[] = [];
      for (const id of ids) {
        const node = findNode(board, id);
        if (!node) return nodeNotFound(ctx, id);
        nodes.push(node);
      }
      // Absolute: the first node lands on (x,y) and the others keep their offsets to it.
      const deltaX = absolute ? x! - nodes[0]!.x : (dx ?? 0);
      const deltaY = absolute ? y! - nodes[0]!.y : (dy ?? 0);
      return [{
        op: 'move',
        moves: nodes.map((node) => ({ id: node.id, x: node.x + deltaX, y: node.y + deltaY })),
        expectRev: Object.fromEntries(nodes.map((node) => [node.id, node.rev])),
      }];
    });
    return finish(ctx, result, (response) => patchSummary(response, `Moved ${ids.join(', ')}`));
  };
};

const LAYOUT_MODES = ['row', 'column', 'grid', 'tidy'] as const;

const prepareLayout: Preparer = (parsed) => {
  noPositionals(parsed, 'layout');
  const groupId = parsed.flags.get('group')?.trim();
  const nodesFlag = parsed.flags.get('nodes');
  const all = parsed.booleans.has('all');
  if ([groupId !== undefined, nodesFlag !== undefined, all].filter(Boolean).length !== 1) {
    throw new UsageError('layout needs exactly one of --group <id>, --nodes <id,id,...> or --all');
  }
  if (groupId === '') throw new UsageError('--group needs a group id');
  const ids = nodesFlag !== undefined ? idList(nodesFlag.split(',')) : [];
  if (nodesFlag !== undefined && ids.length === 0) throw new UsageError('--nodes needs at least one id');
  const mode = enumFlag(parsed, 'mode', LAYOUT_MODES) ?? 'tidy';
  const gap = numberFlag(parsed, 'gap', { min: 0 });
  const columns = numberFlag(parsed, 'columns', { integer: true, min: 1 });
  return async (ctx) => {
    const result = await patchBoard(ctx, (board) => {
      if (groupId !== undefined) {
        const error = groupError(ctx, board, groupId);
        if (error) return error;
      }
      const missing = ids.find((id) => !findNode(board, id));
      if (missing !== undefined) return nodeNotFound(ctx, missing);
      const target = groupId !== undefined ? { groupId } : all ? { all: true as const } : { ids };
      return [{ op: 'layout', target, mode, ...(gap !== undefined ? { gap } : {}), ...(columns !== undefined ? { columns } : {}) }];
    });
    const scope = groupId !== undefined ? `group ${groupId}` : all ? 'the board' : `${ids.length} node(s)`;
    return finish(ctx, result, (response) => patchSummary(response, `Arranged ${scope} (${mode})`));
  };
};

const prepareConnect: Preparer = (parsed) => {
  if (parsed.positionals.length !== 2) throw new UsageError('connect takes <fromId> <toId>');
  const [from, to] = parsed.positionals as [string, string];
  const kind: BoardEdgeKind = enumFlag(parsed, 'kind', BOARD_EDGE_KINDS) ?? 'lineage';
  const label = parsed.flags.get('label');
  return async (ctx) => {
    const result = await patchBoard(ctx, (board) => {
      for (const id of [from, to]) if (!findNode(board, id)) return nodeNotFound(ctx, id);
      // An existing (from, to, kind) edge is skipped, not a 409 `exists` conflict retried into exit 72.
      return [{ op: 'connect', edge: { kind, from, to, ...(label !== undefined ? { label } : {}) }, ifAbsent: true }];
    });
    return finish(ctx, result, (response) => {
      const first = response.results[0];
      const summary = first?.status === 'applied'
        ? `Connected ${from} → ${to} (${kind}) as ${first.ids.join(', ')}`
        : `Edge ${from} → ${to} (${kind}) already exists`;
      return patchSummary(response, summary);
    });
  };
};

const prepareGroup: Preparer = (parsed) => {
  const ids = idList(parsed.positionals);
  if (ids.length === 0) throw new UsageError('group needs at least one <nodeId>');
  const role = enumFlag(parsed, 'role', USER_GROUP_ROLES) ?? 'section';
  const title = parsed.flags.get('title');
  return async (ctx) => {
    const result = await patchBoard(ctx, (board) => {
      const missing = ids.find((id) => !findNode(board, id));
      if (missing !== undefined) return nodeNotFound(ctx, missing);
      return [{ op: 'group', ids, group: { role, ...(title !== undefined ? { title } : {}) } }];
    });
    return finish(ctx, result, (response) => {
      const first = response.results[0];
      return patchSummary(response, first?.status === 'applied' ? `Grouped ${ids.join(', ')} into ${first.ids.join(', ')}` : 'Nothing grouped');
    });
  };
};

const prepareUngroup: Preparer = (parsed) => {
  if (parsed.positionals.length !== 1) throw new UsageError('ungroup takes exactly one <groupId>');
  const id = parsed.positionals[0]!;
  return async (ctx) => {
    const result = await patchBoard(ctx, (board) => {
      const error = groupError(ctx, board, id);
      if (error) return error;
      return [{ op: 'ungroup', id, expectRev: findNode(board, id)!.rev }];
    });
    return finish(ctx, result, (response) => patchSummary(response, `Ungrouped ${id}`));
  };
};

const prepareSync: Preparer = (parsed) => {
  noPositionals(parsed, 'sync');
  return async (ctx) => {
    const result = await callDaemon<BoardSyncResponse>(ctx, 'POST', boardApiPath(ctx.projectId, '/sync'), {
      reason: 'manual',
      actor: ctx.actor,
    });
    return finish(ctx, result, (response) => [
      `Synced · board r${response.revision} · ${response.changed ? 'changed' : 'no changes'} · ${response.placements.length} placement(s)`,
      ...response.placements.map((placement) => `${placement.nodeId}\t${placement.status}\t${placement.path ?? placement.liveArtifactId ?? placement.mediaTaskId ?? '-'}`),
    ]);
  };
};

/** `apply` input: a JSON `BoardOp[]` or `{ops:[…]}`; the CLI adds baseRevision and actor itself. */
function opsFromJson(value: unknown): BoardOp[] {
  let ops: unknown = value;
  if (isRecord(value)) {
    const extra = Object.keys(value).filter((key) => key !== 'ops');
    if (extra.length > 0) throw new UsageError(`apply reads BoardOp[] or {"ops":[...]}; unexpected key(s): ${extra.join(', ')}`);
    ops = value.ops;
  }
  if (!Array.isArray(ops) || ops.length === 0) throw new UsageError('apply needs a non-empty JSON array of ops');
  if (ops.length > BOARD_LIMITS.maxOpsPerPatch) throw new UsageError(`apply takes at most ${BOARD_LIMITS.maxOpsPerPatch} ops per call`);
  ops.forEach((op, index) => {
    if (!isRecord(op) || typeof op.op !== 'string') throw new UsageError(`op ${index} must be an object with an "op" field`);
  });
  return ops as BoardOp[];
}

const prepareApply: Preparer = (parsed) => {
  noPositionals(parsed, 'apply');
  const file = parsed.flags.get('prompt-file');
  if (file === undefined) throw new UsageError('apply needs --prompt-file <path|-> with the ops JSON');
  return async (ctx) => {
    const ops = opsFromJson(await readJsonInput(ctx.io, 'prompt-file', file));
    const result = await patchBoard(ctx, () => ops);
    return finish(ctx, result, (response) => {
      const applied = response.results.filter((entry) => entry.status === 'applied').length;
      return patchSummary(response, `Applied ${applied} of ${ops.length} op(s)`);
    });
  };
};

/** `replace --file` input: `{nodes, edges, title?, settings?}` or a `BoardGetResponse` (`od board show --json`). */
function contentFromJson(value: unknown): { nodes: unknown[]; edges: unknown[]; title?: string; settings?: Record<string, unknown> } {
  const board = isRecord(value) && isRecord(value.board) ? value.board : value;
  if (!isRecord(board) || !Array.isArray(board.nodes)) {
    throw new UsageError('--file must hold {"nodes":[...],"edges":[...]} or the output of `od board show --json`');
  }
  if (board.edges !== undefined && !Array.isArray(board.edges)) throw new UsageError('--file: "edges" must be an array');
  return {
    nodes: board.nodes,
    edges: Array.isArray(board.edges) ? board.edges : [],
    ...(typeof board.title === 'string' ? { title: board.title } : {}),
    ...(isRecord(board.settings) ? { settings: board.settings } : {}),
  };
}

const prepareReplace: Preparer = (parsed) => {
  noPositionals(parsed, 'replace');
  const file = parsed.flags.get('file');
  const empty = parsed.booleans.has('empty');
  if ((file !== undefined) === empty) throw new UsageError('replace needs exactly one of --file <path|-> or --empty');
  const baseRevision = numberFlag(parsed, 'base-revision', { integer: true, min: 0 });
  return async (ctx) => {
    const fromFile = file !== undefined ? contentFromJson(await readJsonInput(ctx.io, 'file', file)) : undefined;
    const attempt = async (): Promise<CallResult<BoardGetResponse>> => {
      const got = await getBoard(ctx);
      if (!got.ok) return got;
      const current = got.data.board;
      const content = fromFile ?? {
        nodes: [],
        edges: [],
        ...(current.title !== undefined ? { title: current.title } : {}),
        settings: current.settings,
      };
      return callDaemon<BoardGetResponse>(ctx, 'PUT', boardApiPath(ctx.projectId), {
        baseRevision: baseRevision ?? current.revision,
        board: content,
        actor: ctx.actor,
      });
    };
    // An explicit --base-revision is the caller's own check: report its conflict instead of re-reading.
    const result = baseRevision !== undefined ? await attempt() : await retryOnConflict(attempt);
    return finish(ctx, result, (response) => [
      `Replaced the board · r${response.board.revision} · ${response.board.nodes.length} nodes · ${response.board.edges.length} edges`,
    ]);
  };
};

const prepareImportCanvas: Preparer = (parsed) => {
  const all = parsed.booleans.has('all');
  const ids = idList(parsed.positionals);
  if (all === (ids.length > 0)) throw new UsageError('import-canvas needs <documentId...> or --all (not both)');
  return async (ctx) => {
    let documentIds = ids;
    if (all) {
      const listed = await callDaemon<{ documents?: CanvasDocumentSummary[] }>(ctx, 'GET', '/api/design-canvas/documents');
      if (!listed.ok) return emitError(ctx.io, listed.error);
      const documents: unknown[] = Array.isArray(listed.data.documents) ? listed.data.documents : [];
      documentIds = idList(documents.flatMap((doc) => (isRecord(doc) && typeof doc.id === 'string' ? [doc.id] : [])));
    }
    const results: BoardImportDesignCanvasResult[] = [];
    const responses: BoardImportDesignCanvasResponse[] = [];
    if (documentIds.length === 0) {
      const got = await getBoard(ctx);
      if (!got.ok) return emitError(ctx.io, got.error);
      responses.push({ revision: got.data.board.revision, results: [], changes: null });
    }
    for (let start = 0; start < documentIds.length; start += IMPORT_CHUNK_SIZE) {
      const chunk = documentIds.slice(start, start + IMPORT_CHUNK_SIZE);
      const sent = await retryOnConflict(() =>
        callDaemon<BoardImportDesignCanvasResponse>(ctx, 'POST', boardApiPath(ctx.projectId, '/import-design-canvas'), { documentIds: chunk }));
      // Earlier chunks are committed; report them with the failure.
      if (!sent.ok) return emitError(ctx.io, { ...sent.error, data: { ...(sent.error.data ?? {}), imported: results } });
      responses.push(sent.data);
      results.push(...(Array.isArray(sent.data.results) ? sent.data.results : []));
    }
    const last = responses[responses.length - 1]!;
    // One response per chunk of 20; a multi-chunk import reports the merged results and no single change set.
    const merged: BoardImportDesignCanvasResponse = {
      revision: last.revision,
      results,
      changes: responses.length === 1 ? last.changes : null,
    };
    if (ctx.json) return printJson(ctx.io, merged);
    const imported = results.filter((entry) => entry.status === 'imported').length;
    return printText(ctx.io, [
      `Imported ${imported} of ${documentIds.length} document(s) · board r${merged.revision}`,
      ...results.map((entry) => [entry.documentId, entry.status, entry.path ?? '-', entry.nodeId ?? '-'].join('\t')),
    ]);
  };
};

const preparePages: Preparer = (parsed) => {
  noPositionals(parsed, 'pages');
  const add = parsed.flags.get('add')?.trim();
  const rename = parsed.flags.get('rename')?.trim();
  const remove = parsed.flags.get('remove')?.trim();
  const title = parsed.flags.get('title')?.trim();
  if ([add, rename, remove].filter((value) => value !== undefined).length > 1) throw new UsageError('use one of --add, --rename, --remove');
  if (add === '') throw new UsageError('--add needs a title');
  if (rename !== undefined && !title) throw new UsageError('--rename needs --title <t>');
  return async (ctx) => {
    if (add === undefined && rename === undefined && remove === undefined) {
      const result = await getBoard(ctx);
      if (!result.ok) return emitError(ctx.io, result.error);
      const pages = boardPagesOf(result.data.board);
      return ctx.json ? printJson(ctx.io, { pages }) : printText(ctx.io, pages.map((page) => `${page.id}  ${page.title}`));
    }
    const result = await patchBoard(ctx, (board) => {
      const pages = boardPagesOf(board);
      if (add !== undefined) {
        return [{ op: 'set-meta', pages: [...pages, { id: `page_${randomBytes(8).toString('hex')}`, title: add }] }];
      }
      const target = rename ?? remove!;
      if (!pages.some((page) => page.id === target)) {
        return { code: 'page-not-found', message: `no page ${target} on the board of project ${ctx.projectId}`, data: { page: target } };
      }
      if (rename !== undefined) {
        return [{ op: 'set-meta', pages: pages.map((page) => (page.id === rename ? { ...page, title: title! } : page)) }];
      }
      if (pages.length < 2) return { code: 'last-page', message: 'a board keeps at least one page' };
      const ids = boardNodesOnPage(board.nodes, pages, target).map((node) => node.id);
      return [
        ...(ids.length > 0 ? [{ op: 'remove', ids, cascade: true } as BoardOp] : []),
        { op: 'set-meta', pages: pages.filter((page) => page.id !== target) },
      ];
    });
    return finish(ctx, result, (response) => patchSummary(response, 'Pages updated.'));
  };
};

const PREPARERS: Record<CoreSubcommand, Preparer> = {
  show: prepareShow,
  add: prepareAdd,
  update: prepareUpdate,
  remove: prepareRemove,
  move: prepareMove,
  layout: prepareLayout,
  connect: prepareConnect,
  group: prepareGroup,
  ungroup: prepareUngroup,
  sync: prepareSync,
  apply: prepareApply,
  replace: prepareReplace,
  'import-canvas': prepareImportCanvas,
  pages: preparePages,
};

function isCoreSubcommand(sub: string): sub is CoreSubcommand {
  return Object.prototype.hasOwnProperty.call(PREPARERS, sub);
}

// ---- identity ---------------------------------------------------------------------------------------

/** `--workspace` + `--workspace-member` (both or neither), else `$OD_WORKSPACE_ID` + `$OD_WORKSPACE_MEMBER_ID`. */
function workspaceHeaders(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Record<string, string> {
  const explicit = parsed.flags.has('workspace') || parsed.flags.has('workspace-member');
  const workspaceId = (explicit ? parsed.flags.get('workspace') : env.OD_WORKSPACE_ID)?.trim() ?? '';
  const memberId = (explicit ? parsed.flags.get('workspace-member') : env.OD_WORKSPACE_MEMBER_ID)?.trim() ?? '';
  if (Boolean(workspaceId) !== Boolean(memberId)) {
    // A bound run without a member must not fall back to "no workspace" (server.ts createOpenDesignToolEnv).
    throw new UsageError(explicit
      ? 'pass --workspace <id> and --workspace-member <id> together'
      : 'OD_WORKSPACE_ID and OD_WORKSPACE_MEMBER_ID must be set together; pass --workspace <id> --workspace-member <id>');
  }
  return workspaceId ? { 'x-od-workspace-id': workspaceId, 'x-od-workspace-member-id': memberId } : {};
}

/** Agent runs write as the run (spec 04 §5.1); everything else as the CLI. */
function boardActor(env: NodeJS.ProcessEnv): BoardActor {
  const runId = env.OD_STOCK_RUN_ID?.trim();
  return runId ? { kind: 'agent', runId } : { kind: 'cli' };
}

// ---- entry points ---------------------------------------------------------------------------------

export async function runBoardCli(
  args: readonly string[],
  io: BoardCliIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: BoardCliDeps = {},
): Promise<BoardCliResult> {
  const sub = args[0];
  if (sub === undefined) {
    io.stdout(`${BOARD_USAGE}\n`);
    return { exitCode: BOARD_EXIT_CODES.usage };
  }
  if (isBoardHelpArg(sub)) {
    io.stdout(`${BOARD_USAGE}\n`);
    return { exitCode: BOARD_EXIT_CODES.ok };
  }
  if (sub === 'generate' || sub === 'media') return runBoardExtension(sub, args.slice(1), io, deps);
  if (!isCoreSubcommand(sub)) {
    return usageError(io, `unknown subcommand: ${sub}. Expected one of ${BOARD_SUBCOMMANDS.join(', ')}.`);
  }

  let parsed: ParsedArgs;
  let command: PreparedCommand;
  let headers: Record<string, string>;
  try {
    parsed = parseArgs(sub, args.slice(1));
    if (parsed.booleans.has('help')) {
      io.stdout(`${BOARD_USAGE}\n`);
      return { exitCode: BOARD_EXIT_CODES.ok };
    }
    command = PREPARERS[sub](parsed);
    headers = workspaceHeaders(parsed, env);
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
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

  const ctx: BoardCliContext = { io, json: parsed.booleans.has('json'), projectId, base, headers, actor: boardActor(env) };
  try {
    return await command(ctx);
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    return emitError(io, { code: 'cli-error', message: errorMessage(error) });
  }
}

/** Resolves once every write queued on the stream so far has been handed to the OS. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

/**
 * SUBCOMMAND_MAP entry: run and leave the exit code for cli.ts's dispatcher. The dispatcher calls
 * process.exit() right after, and pipe writes are async on macOS, so flush first (materials-cli.ts).
 */
export async function runBoard(args: string[]): Promise<void> {
  const { exitCode } = await runBoardCli(args);
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exitCode = exitCode;
}

// ---- helpers ------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
