// SPDX-License-Identifier: Apache-2.0
// `od canvas` (spec 06 §7.4). With `--project <id>`: the project's design documents over the same
// `/api/projects/:id/designs*` routes the web editor uses, plus migration of legacy global documents into the
// project. Without `--project`: the legacy global design-canvas store, unchanged. Output is JSON either way; errors
// print `{"error","code","reason"?}` to stderr. Exit codes follow `od board` (amendment B7 table): 0 ok, 1 error,
// 2 usage, 64 daemon not running, 68 project not found.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  designCoverApiPath,
  designFileNameFromTitle,
  designFormatForPath,
  designNameFromPath,
  uniqueDesignPath,
  type CanvasDocument,
  type CanvasDocumentSummary,
  type DesignDocumentFormat,
  type DesignDocumentListResponse,
  type DesignMigrationListResponse,
  type DesignMigrationRecord,
  type ImportLegacyDesignResponse,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';

export const CANVAS_EXIT_CODES = { ok: 0, error: 1, usage: 2, daemonNotRunning: 64, projectNotFound: 68 } as const;

export const CANVAS_USAGE = `Usage:
  od canvas list --project <id>                                List the project's design documents
  od canvas show <path> --project <id>                         Summary of one document, incl. sha256
  od canvas import <file.fig|file.op> --project <id> [--as <designs/name.fig>] [--replace]
                                                               Copy a local file into the project (default
                                                               designs/<name>.<ext>, made unique); --replace
                                                               overwrites the target (compare-and-swap)
  od canvas export <path> <output-file> --project <id>         Save a document; refuses to overwrite
  od canvas cover <path> <output.png> --project <id>           Save the cover PNG; refuses to overwrite
  od canvas migrate <legacyId> --project <id> [--as <path>]    Import a legacy global document into the project
  od canvas migrate --all --project <id> [--dry-run]           Every legacy document not yet imported into <id>
  od canvas migrations                                         Ledger of imported legacy documents

Legacy global store (unchanged behaviour):
  od canvas list | show <id> | import <file.fig|file.op> | export <id> <output-file>

Common: [--daemon-url <url>] [--workspace <id> --workspace-member <id>] [--json]
Output is JSON either way (--json is accepted for parity). Errors go to stderr as
{"error": "...", "code": "<ApiErrorCode>", "reason"?: "..."}.
Exit codes: 0 ok, 1 error, 2 usage, 64 daemon not running, 68 project not found.
.svg / .html / .pen conversion runs in the editor only (not in the CLI).`;

const LEGACY_HINT =
  'Note: without --project, od canvas uses the legacy global design store. Project designs: od canvas list --project <id>; '
  + 'move legacy documents into a project: od canvas migrate <legacyId> --project <id>.';

export interface CanvasCliCommon {
  json: boolean;
  daemonUrl?: string;
  workspace?: { id: string; memberId: string };
}

export type CanvasCliCommand =
  | { kind: 'help' }
  | { kind: 'invalid'; message: string }
  | { kind: 'list'; projectId: string; common: CanvasCliCommon }
  | { kind: 'show'; projectId: string; path: string; common: CanvasCliCommon }
  | { kind: 'import'; projectId: string; file: string; as?: string; replace: boolean; common: CanvasCliCommon }
  | { kind: 'export'; projectId: string; path: string; output: string; common: CanvasCliCommon }
  | { kind: 'cover'; projectId: string; path: string; output: string; common: CanvasCliCommon }
  | { kind: 'migrate'; projectId: string; legacyId: string; as?: string; common: CanvasCliCommon }
  | { kind: 'migrate-all'; projectId: string; dryRun: boolean; common: CanvasCliCommon }
  | { kind: 'migrations'; common: CanvasCliCommon }
  | { kind: 'legacy-list'; common: CanvasCliCommon }
  | { kind: 'legacy-show'; id: string; common: CanvasCliCommon }
  | { kind: 'legacy-import'; file: string; common: CanvasCliCommon }
  | { kind: 'legacy-export'; id: string; output: string; common: CanvasCliCommon };

export interface CanvasCliDeps {
  fetch: typeof fetch;
  readFile: (file: string) => Promise<Buffer>;
  /** Called with `{ flag: 'wx' }`: outputs are never overwritten. */
  writeFile: (file: string, data: Buffer, options: { flag: 'wx' }) => Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
  daemonUrl: string;
  /** The one-line legacy-store hint is printed only on an interactive stderr. */
  stderrIsTTY?: boolean;
}

// ---- argument parsing -------------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--project', '--as', '--daemon-url', '--workspace', '--workspace-member']);
const BOOLEAN_FLAGS = new Set(['--replace', '--all', '--dry-run', '--json', '--help', '-h']);
const COMMON_FLAGS = ['--daemon-url', '--workspace', '--workspace-member', '--json'];

function invalid(message: string): CanvasCliCommand {
  return { kind: 'invalid', message };
}

export function parseCanvasCliArgs(args: readonly string[]): CanvasCliCommand {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (VALUE_FLAGS.has(name)) {
        const value = eq > 0 ? arg.slice(eq + 1) : args[index + 1];
        if (eq < 0) index += 1;
        if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) return invalid(`${name} needs a value`);
        if (values.has(name)) return invalid(`${name} is given twice`);
        values.set(name, value);
        continue;
      }
      if (BOOLEAN_FLAGS.has(name) && eq < 0) {
        flags.add(name);
        continue;
      }
      return invalid(`unknown option ${arg}`);
    }
    positionals.push(arg);
  }
  const [command, ...rest] = positionals;
  if (flags.has('--help') || flags.has('-h') || command === undefined || command === 'help') return { kind: 'help' };

  const workspaceId = values.get('--workspace');
  const memberId = values.get('--workspace-member');
  if ((workspaceId === undefined) !== (memberId === undefined)) return invalid('--workspace and --workspace-member go together');
  const daemonUrl = values.get('--daemon-url');
  const common: CanvasCliCommon = {
    json: flags.has('--json'),
    ...(daemonUrl !== undefined ? { daemonUrl } : {}),
    ...(workspaceId !== undefined && memberId !== undefined ? { workspace: { id: workspaceId, memberId } } : {}),
  };
  const projectId = values.get('--project');
  const as = values.get('--as');
  const used = [...values.keys(), ...flags];
  /** Rejects options the chosen form does not take. */
  const only = (allowed: readonly string[], build: () => CanvasCliCommand): CanvasCliCommand => {
    const extra = used.find((name) => !COMMON_FLAGS.includes(name) && !allowed.includes(name));
    return extra ? invalid(`${extra} does not apply to od canvas ${command}${projectId === undefined ? ' without --project' : ''}`) : build();
  };
  const arity = (count: number, synopsis: string): string | null =>
    rest.length === count ? null : `usage: od canvas ${synopsis}`;

  switch (command) {
    case 'list': {
      const wrong = arity(0, projectId === undefined ? 'list' : 'list --project <id>');
      if (wrong) return invalid(wrong);
      return projectId === undefined
        ? only([], () => ({ kind: 'legacy-list', common }))
        : only(['--project'], () => ({ kind: 'list', projectId, common }));
    }
    case 'show': {
      const wrong = arity(1, projectId === undefined ? 'show <id>' : 'show <path> --project <id>');
      if (wrong) return invalid(wrong);
      const target = rest[0]!;
      return projectId === undefined
        ? only([], () => ({ kind: 'legacy-show', id: target, common }))
        : only(['--project'], () => ({ kind: 'show', projectId, path: target, common }));
    }
    case 'import': {
      const wrong = arity(1, projectId === undefined ? 'import <file.fig|file.op>' : 'import <file.fig|file.op> --project <id> [--as <path>] [--replace]');
      if (wrong) return invalid(wrong);
      const file = rest[0]!;
      return projectId === undefined
        ? only([], () => ({ kind: 'legacy-import', file, common }))
        : only(['--project', '--as', '--replace'], () => ({
            kind: 'import',
            projectId,
            file,
            ...(as !== undefined ? { as } : {}),
            replace: flags.has('--replace'),
            common,
          }));
    }
    case 'export': {
      const wrong = arity(2, projectId === undefined ? 'export <id> <output-file>' : 'export <path> <output-file> --project <id>');
      if (wrong) return invalid(wrong);
      const [target, output] = rest as [string, string];
      return projectId === undefined
        ? only([], () => ({ kind: 'legacy-export', id: target, output, common }))
        : only(['--project'], () => ({ kind: 'export', projectId, path: target, output, common }));
    }
    case 'cover': {
      if (projectId === undefined) return invalid('od canvas cover needs --project <id>');
      const wrong = arity(2, 'cover <path> <output.png> --project <id>');
      if (wrong) return invalid(wrong);
      const [target, output] = rest as [string, string];
      return only(['--project'], () => ({ kind: 'cover', projectId, path: target, output, common }));
    }
    case 'migrate': {
      if (projectId === undefined) return invalid('od canvas migrate needs --project <id>');
      if (flags.has('--all')) {
        const wrong = arity(0, 'migrate --all --project <id> [--dry-run]');
        if (wrong) return invalid(wrong);
        return only(['--project', '--all', '--dry-run'], () => ({ kind: 'migrate-all', projectId, dryRun: flags.has('--dry-run'), common }));
      }
      const wrong = arity(1, 'migrate <legacyId> --project <id> [--as <path>]');
      if (wrong) return invalid(wrong);
      const legacyId = rest[0]!;
      return only(['--project', '--as'], () => ({ kind: 'migrate', projectId, legacyId, ...(as !== undefined ? { as } : {}), common }));
    }
    case 'migrations': {
      const wrong = arity(0, 'migrations');
      if (wrong) return invalid(wrong);
      return only([], () => ({ kind: 'migrations', common }));
    }
    default:
      return invalid(`unknown command ${command}; see od canvas --help`);
  }
}

// ---- execution ----------------------------------------------------------------------------------------

class CanvasCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number = CANVAS_EXIT_CODES.error,
    readonly reason?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  428: 'BAD_REQUEST',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodedProject(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function designQuery(designPath: string): string {
  return `?path=${encodeURIComponent(designPath)}`;
}

function formatOfFile(file: string): DesignDocumentFormat | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ext === 'fig' || ext === 'op' ? ext : null;
}

async function errorFromResponse(response: Response): Promise<CanvasCliError> {
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const fallback = STATUS_CODES[response.status] ?? 'INTERNAL_ERROR';
  let code = fallback;
  let message = `HTTP ${response.status}`;
  let reason: string | undefined;
  let suggestion: string | undefined;
  if (isRecord(body) && isRecord(body.error)) {
    if (typeof body.error.code === 'string') code = body.error.code;
    if (typeof body.error.message === 'string') message = body.error.message;
    const details = body.error.details;
    if (isRecord(details) && typeof details.reason === 'string') reason = details.reason;
    if (isRecord(details) && typeof details.suggestion === 'string') suggestion = details.suggestion;
  } else if (isRecord(body) && typeof body.error === 'string') {
    message = body.error;
  }
  const exitCode = code === 'PROJECT_NOT_FOUND' ? CANVAS_EXIT_CODES.projectNotFound : CANVAS_EXIT_CODES.error;
  return new CanvasCliError(message, code, exitCode, reason, suggestion ? { suggestion } : {});
}

class CanvasCliRunner {
  private readonly base: string;

  constructor(
    private readonly deps: CanvasCliDeps,
    private readonly common: CanvasCliCommon,
  ) {
    this.base = deps.daemonUrl.replace(/\/+$/, '');
  }

  print(value: unknown, pretty = true): void {
    this.deps.stdout(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  }

  async request(method: string, pathname: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    // Project-scoped routes authorize team-bound projects by the workspace pair (as `od board`).
    if (this.common.workspace && pathname.startsWith('/api/projects/')) {
      headers['x-od-workspace-id'] = this.common.workspace.id;
      headers['x-od-workspace-member-id'] = this.common.workspace.memberId;
    }
    const requestInit: RequestInit = { method, headers };
    if (init.body !== undefined) requestInit.body = init.body as NonNullable<RequestInit['body']>;
    try {
      return await this.deps.fetch(`${this.base}${pathname}`, requestInit);
    } catch (error) {
      const cause = isRecord(error) && isRecord(error.cause) && typeof error.cause.code === 'string' ? ` (${error.cause.code})` : '';
      throw new CanvasCliError(
        `daemon is not reachable at ${this.base}: ${error instanceof Error ? error.message : String(error)}${cause}`,
        'UPSTREAM_UNAVAILABLE',
        CANVAS_EXIT_CODES.daemonNotRunning,
      );
    }
  }

  async json<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await this.request(method, pathname, body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await errorFromResponse(response);
    return (await response.json()) as T;
  }

  async bytes(pathname: string): Promise<{ bytes: Buffer; headers: Headers }> {
    const response = await this.request('GET', pathname);
    if (!response.ok) throw await errorFromResponse(response);
    return { bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
  }

  async readLocal(file: string): Promise<Buffer> {
    try {
      return await this.deps.readFile(file);
    } catch (error) {
      throw new CanvasCliError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, 'FILE_NOT_FOUND');
    }
  }

  async writeLocal(file: string, data: Buffer): Promise<string> {
    try {
      await this.deps.writeFile(file, data, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CanvasCliError(`${file} already exists; choose a new output path`, 'CONFLICT');
      }
      throw new CanvasCliError(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`, 'INTERNAL_ERROR');
    }
    return path.resolve(file);
  }

  /** HEAD of a project design: its sha256, format and revision; `null` when it does not exist. */
  async head(projectId: string, designPath: string): Promise<{ sha256: string; format: string; revision: string; size: number } | null> {
    const response = await this.request('HEAD', `${encodedProject(projectId)}/designs/content${designQuery(designPath)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await errorFromResponse(response);
    return {
      sha256: response.headers.get('x-design-sha256') ?? '',
      format: response.headers.get('x-design-format') ?? (designFormatForPath(designPath) ?? 'fig'),
      revision: response.headers.get('x-design-revision') ?? '',
      size: Number(response.headers.get('content-length') ?? 0),
    };
  }

  async listDesigns(projectId: string): Promise<DesignDocumentListResponse> {
    return this.json<DesignDocumentListResponse>('GET', `${encodedProject(projectId)}/designs`);
  }
}

async function runProjectShow(runner: CanvasCliRunner, projectId: string, designPath: string): Promise<void> {
  const head = await runner.head(projectId, designPath);
  if (!head) {
    // HEAD carries no body: tell a missing project (68) from a missing document.
    await runner.listDesigns(projectId);
    throw new CanvasCliError(`${designPath} is not a design document of project ${projectId}`, 'FILE_NOT_FOUND');
  }
  const [sizeHex = '', mtimeHex = ''] = head.revision.split('-');
  const size = Number.parseInt(sizeHex, 16);
  const mtime = Number.parseInt(mtimeHex, 16);
  runner.print({
    projectId,
    path: designPath,
    name: designNameFromPath(designPath),
    format: head.format,
    size: Number.isFinite(size) ? size : head.size,
    mtime: Number.isFinite(mtime) ? mtime : null,
    revision: head.revision,
    coverUrl: designCoverApiPath(projectId, designPath, head.revision),
    sha256: head.sha256,
  });
}

async function runProjectImport(runner: CanvasCliRunner, cmd: Extract<CanvasCliCommand, { kind: 'import' }>): Promise<void> {
  const format = formatOfFile(cmd.file);
  if (!format) throw new CanvasCliError('od canvas import takes a .fig or .op file', 'BAD_REQUEST', CANVAS_EXIT_CODES.usage);
  if (cmd.as !== undefined && designFormatForPath(cmd.as) !== format) {
    throw new CanvasCliError(`--as must end in .${format} like ${cmd.file}`, 'BAD_REQUEST', CANVAS_EXIT_CODES.usage);
  }
  const bytes = await runner.readLocal(cmd.file);
  const baseName = designFileNameFromTitle(path.basename(cmd.file, path.extname(cmd.file)));
  let target: string;
  let precondition: Record<string, string>;
  if (cmd.replace) {
    target = cmd.as ?? `designs/${baseName}.${format}`;
    const current = await runner.head(cmd.projectId, target);
    precondition = current ? { 'If-Match': `"${current.sha256}"` } : { 'If-None-Match': '*' };
  } else {
    target = cmd.as ?? uniqueDesignPath(baseName, format, (await runner.listDesigns(cmd.projectId)).designs.map((design) => design.path));
    precondition = { 'If-None-Match': '*' };
  }
  const response = await runner.request('PUT', `${encodedProject(cmd.projectId)}/designs/content${designQuery(target)}`, {
    headers: { 'Content-Type': 'application/octet-stream', ...precondition },
    body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
  if (!response.ok) throw await errorFromResponse(response);
  runner.print(await response.json());
}

async function runMigrateAll(runner: CanvasCliRunner, projectId: string, dryRun: boolean): Promise<void> {
  await runner.listDesigns(projectId); // a missing project fails here (exit 68), before anything is listed or written
  const { documents } = await runner.json<{ documents?: CanvasDocumentSummary[] }>('GET', '/api/design-canvas/documents');
  const { migrations } = await runner.json<DesignMigrationListResponse>('GET', '/api/design-canvas/migrations');
  const imported = (record: DesignMigrationRecord, doc: CanvasDocumentSummary) =>
    record.projectId === projectId && record.legacyId === doc.id && record.legacySha256 === doc.sha256;
  const pending = (Array.isArray(documents) ? documents : []).filter((doc) => !migrations.some((record) => imported(record, doc)));
  if (dryRun) {
    runner.print({ projectId, dryRun: true, documents: pending });
    return;
  }
  const results: ImportLegacyDesignResponse[] = [];
  for (const doc of pending) {
    try {
      results.push(await runner.json<ImportLegacyDesignResponse>('POST', `${encodedProject(projectId)}/designs/import-legacy`, { legacyId: doc.id }));
    } catch (error) {
      if (error instanceof CanvasCliError) {
        throw new CanvasCliError(`${doc.id}: ${error.message}`, error.code, error.exitCode, error.reason, { legacyId: doc.id, imported: results });
      }
      throw error;
    }
  }
  runner.print({ projectId, results });
}

async function runCommand(runner: CanvasCliRunner, cmd: Exclude<CanvasCliCommand, { kind: 'help' | 'invalid' }>): Promise<void> {
  switch (cmd.kind) {
    case 'list':
      runner.print(await runner.listDesigns(cmd.projectId));
      return;
    case 'show':
      await runProjectShow(runner, cmd.projectId, cmd.path);
      return;
    case 'import':
      await runProjectImport(runner, cmd);
      return;
    case 'export': {
      const { bytes, headers } = await runner.bytes(`${encodedProject(cmd.projectId)}/designs/content${designQuery(cmd.path)}`);
      const written = await runner.writeLocal(cmd.output, bytes);
      runner.print({ path: written, sha256: headers.get('x-design-sha256') ?? '', format: headers.get('x-design-format') ?? null, size: bytes.length });
      return;
    }
    case 'cover': {
      const { bytes, headers } = await runner.bytes(`${encodedProject(cmd.projectId)}/designs/cover${designQuery(cmd.path)}`);
      const written = await runner.writeLocal(cmd.output, bytes);
      runner.print({ path: written, source: headers.get('x-design-cover-source') ?? null, size: bytes.length });
      return;
    }
    case 'migrate':
      runner.print(await runner.json<ImportLegacyDesignResponse>('POST', `${encodedProject(cmd.projectId)}/designs/import-legacy`, {
        legacyId: cmd.legacyId,
        ...(cmd.as !== undefined ? { path: cmd.as } : {}),
      }));
      return;
    case 'migrate-all':
      await runMigrateAll(runner, cmd.projectId, cmd.dryRun);
      return;
    case 'migrations':
      runner.print(await runner.json<DesignMigrationListResponse>('GET', '/api/design-canvas/migrations'));
      return;
    // Legacy global store: same requests and output as before the project mode existed.
    case 'legacy-list':
      runner.print(await runner.json('GET', '/api/design-canvas/documents'));
      return;
    case 'legacy-show': {
      const { data: _data, ...doc } = await runner.json<CanvasDocument>('GET', `/api/design-canvas/documents/${encodeURIComponent(cmd.id)}`);
      runner.print(doc);
      return;
    }
    case 'legacy-import': {
      const format = formatOfFile(cmd.file);
      if (!format) throw new CanvasCliError('Expected a .fig or .op file', 'BAD_REQUEST', CANVAS_EXIT_CODES.usage);
      const data = await runner.readLocal(cmd.file);
      const { data: _data, ...doc } = await runner.json<CanvasDocument>('PUT', `/api/design-canvas/documents/${randomUUID()}`, {
        name: path.basename(cmd.file, `.${format}`),
        format,
        data: data.toString('base64'),
        expected: null,
      });
      runner.print(doc);
      return;
    }
    case 'legacy-export': {
      const doc = await runner.json<CanvasDocument>('GET', `/api/design-canvas/documents/${encodeURIComponent(cmd.id)}`);
      // Refuse accidental overwrites; exporting to a new path is always reversible.
      const written = await runner.writeLocal(cmd.output, Buffer.from(doc.data, 'base64'));
      runner.print({ path: written, sha256: doc.sha256 }, false);
      return;
    }
  }
}

/** Runs one parsed command; returns the exit code. */
export async function runCanvasCli(cmd: CanvasCliCommand, deps: CanvasCliDeps): Promise<number> {
  if (cmd.kind === 'help') {
    deps.stdout(CANVAS_USAGE);
    return CANVAS_EXIT_CODES.ok;
  }
  if (cmd.kind === 'invalid') {
    deps.stderr(JSON.stringify({ error: cmd.message, code: 'BAD_REQUEST' }));
    return CANVAS_EXIT_CODES.usage;
  }
  if (cmd.kind.startsWith('legacy-') && deps.stderrIsTTY) deps.stderr(LEGACY_HINT);
  try {
    await runCommand(new CanvasCliRunner(deps, cmd.common), cmd);
    return CANVAS_EXIT_CODES.ok;
  } catch (error) {
    const failure = error instanceof CanvasCliError
      ? error
      : new CanvasCliError(error instanceof Error ? error.message : String(error), 'INTERNAL_ERROR');
    deps.stderr(JSON.stringify({ error: failure.message, code: failure.code, ...(failure.reason ? { reason: failure.reason } : {}), ...failure.extra }));
    return failure.exitCode;
  }
}

/** Workspace identity from `$OD_WORKSPACE_ID` + `$OD_WORKSPACE_MEMBER_ID` for project commands without the flags. */
export function withWorkspaceEnv(cmd: CanvasCliCommand, env: NodeJS.ProcessEnv): CanvasCliCommand {
  if (cmd.kind === 'help' || cmd.kind === 'invalid' || !('projectId' in cmd) || cmd.common.workspace) return cmd;
  const id = env.OD_WORKSPACE_ID?.trim() ?? '';
  const memberId = env.OD_WORKSPACE_MEMBER_ID?.trim() ?? '';
  if (!id && !memberId) return cmd;
  if (!id || !memberId) return invalid('OD_WORKSPACE_ID and OD_WORKSPACE_MEMBER_ID must be set together');
  return { ...cmd, common: { ...cmd.common, workspace: { id, memberId } } };
}

/** `od canvas …` entry (registered in cli.ts). */
export async function handleCanvasCli(args: string[]): Promise<void> {
  const cmd = withWorkspaceEnv(parseCanvasCliArgs(args), process.env);
  const daemonUrl = cmd.kind === 'help' || cmd.kind === 'invalid'
    ? ''
    : await resolveDaemonUrl({ flagUrl: cmd.common.daemonUrl ?? null });
  const exitCode = await runCanvasCli(cmd, {
    fetch,
    readFile: (file) => readFile(file),
    writeFile: (file, data, options) => writeFile(file, data, options),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    daemonUrl,
    stderrIsTTY: Boolean(process.stderr.isTTY),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
