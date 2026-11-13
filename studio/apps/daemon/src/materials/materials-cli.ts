// `od materials …` — CLI mirror of the material library (素材库) surface.
// Per AGENTS.md "Capability exposure (UI/CLI dual-track)", it drives the same
// `/api/materials/*` endpoints as the web UI and supports `--json` plus
// `--prompt-file <path|->` for the context task text.
//
// Kept out of cli.ts so it stays unit-testable without triggering cli.ts's
// import-time SUBCOMMAND_MAP dispatch (mirrors handoff-cli.ts).

import { readFile } from 'node:fs/promises';

import type {
  MaterialApplyRequest,
  MaterialApplyResponse,
  MaterialContextRequest,
  MaterialContextResponse,
  MaterialDetailResponse,
  MaterialSearchResponse,
  MaterialSummaryResponse,
  MaterialLibrariesResponse,
  MaterialLibrary,
} from '@open-design/contracts';

import { MATERIALS_SUBCOMMANDS, MATERIALS_USAGE, isMaterialsHelpArg } from '../cli-help/materials-cli-help.js';
import { resolveDaemonUrl } from '../daemon-url.js';

export interface MaterialsCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

export interface MaterialsCliResult {
  exitCode: number;
}

const defaultIo: MaterialsCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
};

/** Same exit codes as `exitWithStructuredError` in cli.ts for shared codes. */
const EXIT_CODES: Record<string, number> = {
  'daemon-not-running': 64,
  'project-not-found': 68,
};
const USAGE_EXIT_CODE = 2;

const STRING_FLAGS = new Set([
  'daemon-url', 'kind', 'category', 'collection', 'section', 'limit', 'offset', 'query',
  'task', 'prompt-file', 'project', 'dir', 'workspace', 'workspace-member', 'member', 'library', 'name',
]);
const REPEATABLE_FLAGS = new Set(['field', 'file']);
const BOOLEAN_FLAGS = new Set(['json', 'help']);

interface ParsedArgs {
  flags: Record<string, string>;
  repeated: Record<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
}

class UsageError extends Error {}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { flags: {}, repeated: {}, booleans: new Set(), positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-h') {
      parsed.booleans.add('help');
      continue;
    }
    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} does not take a value`);
      parsed.booleans.add(key);
      continue;
    }
    if (!STRING_FLAGS.has(key) && !REPEATABLE_FLAGS.has(key)) {
      throw new UsageError(`unknown flag: --${key}. Run \`od materials --help\` for the accepted flags.`);
    }
    let value: string | undefined;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`flag --${key} requires a value`);
    if (REPEATABLE_FLAGS.has(key)) (parsed.repeated[key] ??= []).push(value);
    else parsed.flags[key] = value;
  }
  return parsed;
}

interface StructuredError {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

function emitError(io: MaterialsCliIo, error: StructuredError, exitCode?: number): MaterialsCliResult {
  io.stderr(`${JSON.stringify({ error: { code: error.code, message: error.message, data: error.data ?? {} } })}\n`);
  return { exitCode: exitCode ?? EXIT_CODES[error.code] ?? 1 };
}

function usageError(io: MaterialsCliIo, message: string): MaterialsCliResult {
  return emitError(io, { code: 'invalid-request', message }, USAGE_EXIT_CODE);
}

type CallResult<T> = { ok: true; data: T } | { ok: false; result: MaterialsCliResult };

async function callDaemon<T>(
  io: MaterialsCliIo,
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<CallResult<T>> {
  let resp: Response;
  try {
    resp = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return {
      ok: false,
      result: emitError(io, {
        code: 'daemon-not-running',
        message: `Cannot reach daemon at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
  const raw = await resp.text().catch(() => '');
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : undefined;
  } catch {
    payload = undefined;
  }
  if (!resp.ok) {
    const envelope = (payload as { error?: unknown } | undefined)?.error;
    const errorObject =
      typeof envelope === 'string'
        ? { message: envelope }
        : envelope && typeof envelope === 'object'
          ? (envelope as { code?: unknown; message?: unknown })
          : {};
    const code = typeof (errorObject as { code?: unknown }).code === 'string'
      ? String((errorObject as { code?: unknown }).code)
      : 'daemon-error';
    const message = typeof errorObject.message === 'string'
      ? errorObject.message
      : `HTTP ${resp.status}${raw ? `: ${raw.slice(0, 500)}` : ''}`;
    return { ok: false, result: emitError(io, { code, message, data: { status: resp.status } }) };
  }
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    return {
      ok: false,
      result: emitError(io, { code: 'daemon-error', message: 'daemon returned a malformed response', data: { status: resp.status } }),
    };
  }
  return { ok: true, data: payload as T };
}

function printJson(io: MaterialsCliIo, data: unknown): MaterialsCliResult {
  io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  return { exitCode: 0 };
}

function countLines(title: string, counts: Record<string, number>): string[] {
  const entries = Object.entries(counts);
  if (entries.length === 0) return [];
  return ['', `${title}:`, ...entries.map(([name, count]) => `  ${name}\t${count}`)];
}

function formatSummary(data: MaterialSummaryResponse): string {
  const { status } = data;
  const lines: string[] = [];
  if (!status.enabled) {
    lines.push(`Material library unavailable (${status.reason ?? 'unknown'}): ${status.message ?? ''}`.trimEnd());
    if (status.root) lines.push(`Root: ${status.root}`);
  } else {
    lines.push(`Material library: ${status.root} (${status.rootSource})`);
    if (status.indexUpdatedAt) lines.push(`Index updated: ${status.indexUpdatedAt}`);
    lines.push(`Records: ${data.total}`);
    lines.push(...countLines('Kinds', data.kinds));
    lines.push(...countLines('Categories', data.categories));
    lines.push(...countLines('Collections', data.collections));
  }
  lines.push('', data.notice);
  return `${lines.join('\n')}\n`;
}

function formatSearch(data: MaterialSearchResponse): string {
  const label = data.query ? ` for "${data.query}"` : '';
  const lines: string[] = [];
  if (data.returned === 0) {
    lines.push(`No matches${label} (total ${data.total}, offset ${data.offset}).`);
  } else {
    lines.push(
      `${data.total} match${data.total === 1 ? '' : 'es'}${label}; showing ${data.offset + 1}-${data.offset + data.returned}` +
        (data.nextOffset !== null ? `; next --offset ${data.nextOffset}` : ''),
    );
    for (const item of data.items) lines.push(`${item.id}\t${item.kind}\t${item.category}\t${item.title}`);
  }
  lines.push('', data.notice);
  return `${lines.join('\n')}\n`;
}

function formatDetail(data: MaterialDetailResponse): string {
  const { item } = data;
  const lines = [`${item.title} (${item.id})`, `  ${item.kind} · ${item.category} · ${item.collection}`];
  if (item.description) lines.push('', item.description);
  lines.push('', `Entry: ${item.absolutePath}`, `License: ${item.license}`);
  if (item.source) lines.push(`Source: ${item.source}`);
  if (item.status) lines.push(`Status: ${item.status}`);
  if (item.useStatus) lines.push(`Use status: ${item.useStatus}`);
  if (item.collectionRoot) lines.push(`Collection root: ${item.collectionRoot}`);
  if (item.files.length > 0) {
    lines.push('Files:');
    for (const file of item.files) {
      lines.push(`  ${file.field}\t${file.absolutePath}${file.exists ? '' : ' [missing]'}`);
    }
  }
  if (item.children.length > 0) lines.push(`Children: ${item.children.join(', ')}`);
  lines.push('', data.notice);
  return `${lines.join('\n')}\n`;
}

function formatApply(data: MaterialApplyResponse): string {
  const lines = [`Copied ${data.files.length} file${data.files.length === 1 ? '' : 's'} into ${data.dir} (project ${data.projectId})`];
  for (const file of data.files) lines.push(`  ${file.relPath}\t${file.bytes} B`);
  lines.push(`Receipt: ${data.receiptRelPath}`);
  if (data.attachments.length > 0) lines.push(`Attachments: ${data.attachments.join(', ')}`);
  lines.push('', data.notice);
  return `${lines.join('\n')}\n`;
}

async function readTask(io: MaterialsCliIo, parsed: ParsedArgs): Promise<string | undefined> {
  const task = parsed.flags.task;
  const promptFile = parsed.flags['prompt-file'];
  if (task !== undefined && promptFile !== undefined) throw new UsageError('use either --task or --prompt-file, not both');
  if (promptFile === undefined) return task;
  const text = promptFile === '-' ? await io.readStdin() : await readFile(promptFile, 'utf8');
  return text.replace(/\s+$/u, '');
}

export async function runMaterialsCli(args: readonly string[], io: MaterialsCliIo = defaultIo): Promise<MaterialsCliResult> {
  const sub = args[0];
  if (sub === undefined) {
    io.stdout(`${MATERIALS_USAGE}\n`);
    return { exitCode: USAGE_EXIT_CODE };
  }
  if (isMaterialsHelpArg(sub)) {
    io.stdout(`${MATERIALS_USAGE}\n`);
    return { exitCode: 0 };
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args.slice(1));
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : String(error));
  }
  if (parsed.booleans.has('help')) {
    io.stdout(`${MATERIALS_USAGE}\n`);
    return { exitCode: 0 };
  }
  if (!(MATERIALS_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return usageError(io, `unknown subcommand: ${sub}. Expected one of ${MATERIALS_SUBCOMMANDS.join(', ')}.`);
  }
  const json = parsed.booleans.has('json');
  let base: string;
  try {
    const flagUrl = parsed.flags['daemon-url'];
    base = (await resolveDaemonUrl(flagUrl ? { flagUrl } : {})).replace(/\/+$/u, '');
  } catch (error) {
    return emitError(io, {
      code: 'daemon-not-running',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    switch (sub) {
      case 'libraries': {
        if (parsed.positionals.length) return usageError(io, 'libraries takes no arguments');
        const call = await callDaemon<MaterialLibrariesResponse>(io, base, 'GET', '/api/materials/libraries');
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(call.data.libraries.map((entry) => `${entry.id}\t${entry.name}\t${entry.status.enabled ? entry.total : 'unavailable'}\t${entry.root}`).join('\n') + '\n');
        return { exitCode: 0 };
      }
      case 'add-library': {
        if (parsed.positionals.length !== 1) return usageError(io, 'add-library takes one <folder>');
        const call = await callDaemon<{ library: MaterialLibrary }>(io, base, 'POST', '/api/materials/libraries',
          { root: parsed.positionals[0], name: parsed.flags.name });
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(`${call.data.library.id}\t${call.data.library.name}\t${call.data.library.root}\n`);
        return { exitCode: 0 };
      }
      case 'remove-library': {
        if (parsed.positionals.length !== 1) return usageError(io, 'remove-library takes one <library-id>');
        const call = await callDaemon<{ ok: boolean }>(io, base, 'DELETE', `/api/materials/libraries/${encodeURIComponent(parsed.positionals[0]!)}`);
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout('Library disconnected. Original files were kept.\n');
        return { exitCode: 0 };
      }
      case 'scan-library': {
        if (parsed.positionals.length !== 1) return usageError(io, 'scan-library takes one <library-id>');
        const call = await callDaemon<{ library: MaterialLibrary }>(io, base, 'POST', `/api/materials/libraries/${encodeURIComponent(parsed.positionals[0]!)}/scan`);
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(`${call.data.library.name}\t${call.data.library.total} items\n`);
        return { exitCode: 0 };
      }
      case 'summary': {
        if (parsed.positionals.length > 0) return usageError(io, 'summary takes no arguments');
        const scope = parsed.flags.library ? `?libraryId=${encodeURIComponent(parsed.flags.library)}` : '';
        const call = await callDaemon<MaterialSummaryResponse>(io, base, 'GET', `/api/materials/summary${scope}`);
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(formatSummary(call.data));
        return { exitCode: 0 };
      }
      case 'search': {
        const query = [parsed.flags.query, ...parsed.positionals].filter((part) => part !== undefined && part !== '').join(' ');
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (parsed.flags.library) params.set('libraryId', parsed.flags.library);
        for (const key of ['kind', 'category', 'collection', 'section', 'limit', 'offset'] as const) {
          const value = parsed.flags[key];
          if (value !== undefined && value !== '') params.set(key, value);
        }
        const encoded = params.toString();
        const suffix = encoded ? `?${encoded}` : '';
        const call = await callDaemon<MaterialSearchResponse>(io, base, 'GET', `/api/materials/items${suffix}`);
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(formatSearch(call.data));
        return { exitCode: 0 };
      }
      case 'show': {
        if (parsed.positionals.length !== 1) return usageError(io, 'show takes exactly one <id>');
        const id = parsed.positionals[0]!;
        const call = await callDaemon<MaterialDetailResponse>(io, base, 'GET', `/api/materials/items/${encodeURIComponent(id)}`);
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(formatDetail(call.data));
        return { exitCode: 0 };
      }
      case 'context': {
        if (parsed.positionals.length === 0) return usageError(io, 'context requires at least one <id>');
        const task = await readTask(io, parsed);
        const body: MaterialContextRequest = { ids: parsed.positionals, ...(task ? { task } : {}) };
        const call = await callDaemon<MaterialContextResponse>(io, base, 'POST', '/api/materials/context', body);
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(`${call.data.markdown}\n`);
        return { exitCode: 0 };
      }
      case 'apply': {
        if (parsed.positionals.length !== 1) return usageError(io, 'apply takes exactly one <id>');
        const projectId = parsed.flags.project;
        if (!projectId) return usageError(io, 'apply requires --project <projectId>');
        // Team-shared projects need the caller's workspace identity, as with `od library apply`.
        const workspaceId = parsed.flags.workspace?.trim() ?? '';
        const workspaceMemberId = (parsed.flags['workspace-member'] ?? parsed.flags.member)?.trim() ?? '';
        if (Boolean(workspaceId) !== Boolean(workspaceMemberId)) {
          return usageError(io, 'pass --workspace <id> and --workspace-member <id>');
        }
        const workspaceHeaders: Record<string, string> = workspaceId
          ? { 'x-od-workspace-id': workspaceId, 'x-od-workspace-member-id': workspaceMemberId }
          : {};
        const id = parsed.positionals[0]!;
        const body: MaterialApplyRequest = {
          projectId,
          ...(parsed.flags.dir !== undefined ? { dir: parsed.flags.dir } : {}),
          ...(parsed.repeated.field
            ? { fields: parsed.repeated.field as NonNullable<MaterialApplyRequest['fields']> }
            : {}),
          ...(parsed.repeated.file ? { files: parsed.repeated.file } : {}),
        };
        const call = await callDaemon<MaterialApplyResponse>(
          io,
          base,
          'POST',
          `/api/materials/items/${encodeURIComponent(id)}/apply`,
          body,
          workspaceHeaders,
        );
        if (!call.ok) return call.result;
        if (json) return printJson(io, call.data);
        io.stdout(formatApply(call.data));
        return { exitCode: 0 };
      }
      default:
        return usageError(io, `unknown subcommand: ${sub}`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    return emitError(io, { code: 'cli-error', message: error instanceof Error ? error.message : String(error) });
  }
}

/** Resolves once every write queued on the stream so far has been handed to the OS. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

/**
 * SUBCOMMAND_MAP entry: run and leave the exit code for cli.ts's dispatcher.
 * The dispatcher calls process.exit() right after, and pipe writes are async
 * on macOS, so flush first or a large --json payload is cut at 64 KiB.
 */
export async function runMaterials(args: string[]): Promise<void> {
  const { exitCode } = await runMaterialsCli(args);
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exitCode = exitCode;
}
