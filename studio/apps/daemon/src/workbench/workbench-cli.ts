// SPDX-License-Identifier: AGPL-3.0-only
// `od workbench …` — CLI mirror of the Fantay 工作台 (workbench) surface.
// Per AGENTS.md "Capability exposure (UI/CLI dual-track)", it drives the same `/api/workbench/*`
// endpoints as the desktop UI and supports `--json` plus `--prompt-file <path|->` for long text.
// This is also how external agents find and read the 灵感 library (`search`, `read`).
import { readFile } from 'node:fs/promises';
import type {
  WorkbenchCaptureResponse, WorkbenchChatResponse, WorkbenchItem, WorkbenchOpsResponse, WorkbenchOrganizeResponse,
  WorkbenchProduceResponse, WorkbenchProductionResponse, WorkbenchReaderResponse, WorkbenchSearchResponse,
  WorkbenchSocialImportResponse, WorkbenchState, WorkbenchStateResponse, WorkbenchUndoResponse,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';

export interface WorkbenchCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

const defaultIo: WorkbenchCliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
};

export const WORKBENCH_SUBCOMMANDS = ['state', 'ops', 'capture', 'search', 'read', 'chat', 'produce', 'import', 'organize', 'undo'] as const;

export const WORKBENCH_USAGE = `Usage:
  od workbench state [--json]
  od workbench ops --file <path|-> [--label <text>] [--no-undo] [--json]
  od workbench capture <text|url> [--space <id|name>] [--tag <tag>]... [--title <text>] [--json]
  od workbench capture --prompt-file <path|-> [--space <id|name>] [--tag <tag>]... [--json]
  od workbench search <query> [--meaning] [--json]
  od workbench read <itemId> [--no-fetch] [--json]
  od workbench chat (<message> | --prompt-file <path|->) [--focus <itemId>] [--json]
  od workbench produce <itemId> [--no-images] [--wait] [--json]
  od workbench import <account-url> [--json]
  od workbench organize <itemId>... [--json]
  od workbench undo [--json]

Drive the Fantay 工作台 (灵感 library, 成稿 studio, 排期, 复盘, 风格) through the same daemon
HTTP API as the desktop UI. Text, image and social-data calls use the signed-in TokenToSea account.

Commands:
  state      Print the library summary (or the full state with --json).
  ops        Apply whitelisted ops from a JSON file: an array of ops or {"ops":[...],"label":"..."}.
  capture    Save a link (http/https) or a note into the Inbox; --space files it directly.
  search     Search the library; --meaning uses the text model for semantic search.
  read       Print one item in full, including its reader text. Web items without reader text
             are fetched first unless --no-fetch is given.
  chat       Ask the workbench assistant (library Q&A, edits through ops).
  produce    Start 一键成稿 for an item; --wait polls until it finishes.
  import     Import a public social account (TokenToSea 社媒数据) and learn its style.
  organize   Run AI auto-organise (title, tags, space, summary) on items.
  undo       Undo the last undoable workbench change.

Options:
  --lang <zh|en>          Language for receipts and generated text (default zh).
  --daemon-url <url>      Override daemon URL.
  --json                  Emit the daemon response as JSON.`;

const STRING_FLAGS = new Set(['daemon-url', 'file', 'label', 'space', 'title', 'prompt-file', 'focus', 'lang']);
const REPEATABLE_FLAGS = new Set(['tag']);
const BOOLEAN_FLAGS = new Set(['json', 'help', 'meaning', 'no-fetch', 'no-images', 'wait', 'no-undo']);
const USAGE_EXIT_CODE = 2;

class UsageError extends Error {}

interface ParsedArgs { flags: Record<string, string>; repeated: Record<string, string[]>; booleans: Set<string>; positionals: string[] }

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { flags: {}, repeated: {}, booleans: new Set(), positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-h') { parsed.booleans.add('help'); continue; }
    if (arg === '-' || !arg.startsWith('--')) { parsed.positionals.push(arg); continue; }
    if (arg === '--') { parsed.positionals.push(...args.slice(index + 1)); break; }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} does not take a value`);
      parsed.booleans.add(key);
      continue;
    }
    if (!STRING_FLAGS.has(key) && !REPEATABLE_FLAGS.has(key)) throw new UsageError(`unknown flag: --${key}. Run \`od workbench --help\` for the accepted flags.`);
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else { value = args[index + 1]; index += 1; }
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`flag --${key} requires a value`);
    if (REPEATABLE_FLAGS.has(key)) (parsed.repeated[key] ??= []).push(value);
    else parsed.flags[key] = value;
  }
  return parsed;
}

type Result = { exitCode: number };

function emitError(io: WorkbenchCliIo, code: string, message: string, data: Record<string, unknown> = {}, exitCode?: number): Result {
  io.stderr(`${JSON.stringify({ error: { code, message, data } })}\n`);
  return { exitCode: exitCode ?? (code === 'daemon-not-running' ? 64 : 1) };
}

class CallFailed extends Error { constructor(readonly result: Result) { super('call failed'); } }

interface Client { call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> }

function client(io: WorkbenchCliIo, base: string, lang: string): Client {
  return {
    async call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
      let resp: Response;
      try {
        resp = await fetch(`${base}/api/workbench/${route}`, {
          method,
          headers: { 'x-workbench-lang': lang, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new CallFailed(emitError(io, 'daemon-not-running', `Cannot reach daemon at ${base}: ${error instanceof Error ? error.message : String(error)}`));
      }
      const raw = await resp.text().catch(() => '');
      let payload: unknown;
      try { payload = raw ? JSON.parse(raw) : undefined; } catch { payload = undefined; }
      if (!resp.ok) {
        const envelope = (payload as { error?: unknown } | undefined)?.error;
        const message = typeof envelope === 'string' ? envelope : envelope && typeof envelope === 'object' && typeof (envelope as { message?: unknown }).message === 'string' ? String((envelope as { message: string }).message) : `HTTP ${resp.status}${raw ? `: ${raw.slice(0, 500)}` : ''}`;
        throw new CallFailed(emitError(io, resp.status === 401 ? 'auth-required' : 'daemon-error', message, { status: resp.status }));
      }
      if (payload === undefined || payload === null || typeof payload !== 'object') throw new CallFailed(emitError(io, 'daemon-error', 'daemon returned a malformed response', { status: resp.status }));
      return payload as T;
    },
  };
}

async function readText(io: WorkbenchCliIo, source: string): Promise<string> {
  const text = source === '-' ? await io.readStdin() : await readFile(source, 'utf8');
  return text.replace(/\s+$/u, '');
}

function printJson(io: WorkbenchCliIo, data: unknown): Result {
  io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  return { exitCode: 0 };
}

const live = (state: WorkbenchState) => state.items.filter(item => !item.trashedAt);

function itemLine(item: WorkbenchItem, state: WorkbenchState): string {
  const space = item.spaceId ? state.spaces.find(row => row.id === item.spaceId)?.name : null;
  const flags = [item.starred ? '★' : '', !item.triagedAt ? 'inbox' : '', space ? `[${space}]` : ''].filter(Boolean).join(' ');
  return `${item.id}\t${item.kind}\t${item.title}${flags ? `\t${flags}` : ''}`;
}

function formatState(data: WorkbenchStateResponse): string {
  const { state } = data;
  const items = live(state);
  const lines = [
    `TokenToSea: ${data.signedIn ? `signed in · text model ${data.model ?? 'none'}${data.modelOk === false ? ` (last call failed: ${data.modelError ?? ''})` : ''}` : 'signed out (local rules only)'}`,
    `Library: ${items.length} items · ${items.filter(i => !i.triagedAt).length} in Inbox · ${items.filter(i => i.starred).length} starred · ${state.items.length - items.length} in Trash`,
  ];
  if (state.spaces.length) lines.push(`Spaces: ${state.spaces.map(s => `${s.name} (${items.filter(i => i.spaceId === s.id).length}) ${s.id}`).join(' · ')}`);
  const inbox = items.filter(i => !i.triagedAt).slice(0, 10);
  if (inbox.length) lines.push('', 'Inbox:', ...inbox.map(i => `  ${itemLine(i, state)}`));
  lines.push('', 'Recent:', ...items.slice(0, 15).map(i => `  ${itemLine(i, state)}`));
  if (data.canUndo) lines.push('', `Undo available: ${data.undoLabel ?? ''}`);
  return `${lines.join('\n')}\n`;
}

function formatItem(item: WorkbenchItem, state: WorkbenchState): string {
  const space = item.spaceId ? state.spaces.find(row => row.id === item.spaceId)?.name : null;
  const lines = [`${item.title} (${item.id})`, `  ${item.kind} · ${item.status}${space ? ` · space ${space}` : ''}${item.starred ? ' · starred' : ''}${!item.triagedAt ? ' · inbox' : ''}${item.trashedAt ? ' · trashed' : ''}`];
  if (item.url) lines.push(`  ${item.url}`);
  if (item.tags.length) lines.push(`  tags: ${item.tags.join(', ')}`);
  if (item.media?.src) lines.push(`  media: ${item.media.src}`);
  if (item.summary) lines.push('', 'Summary:', item.summary);
  if (item.body) lines.push('', item.body);
  if (item.ocrText) lines.push('', 'Text in image:', item.ocrText);
  if (item.highlights?.length) lines.push('', 'Highlights:', ...item.highlights.map(h => `  - ${h.text}${h.note ? ` (${h.note})` : ''}`));
  if (item.reader?.text) lines.push('', `Reader${item.reader.siteName ? ` · ${item.reader.siteName}` : ''}${item.readMinutes ? ` · ${item.readMinutes} min` : ''}:`, item.reader.text);
  else if (item.reader?.error) lines.push('', `Reader unavailable: ${item.reader.error}`);
  if (item.production?.article) lines.push('', `Production (${item.production.status}): ${item.production.title}`, item.production.article);
  return `${lines.join('\n')}\n`;
}

function receiptsText(receipts: Array<{ text: string }>, errors: string[]): string {
  return `${[...receipts.map(r => `✓ ${r.text}`), ...errors.map(e => `✗ ${e}`)].join('\n') || 'No changes.'}\n`;
}

async function resolveSpace(api: Client, value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const { state } = await api.call<WorkbenchStateResponse>('GET', 'state');
  const space = state.spaces.find(row => row.id === value) ?? state.spaces.find(row => row.name === value) ?? state.spaces.find(row => row.name.toLowerCase() === value.toLowerCase());
  if (!space) throw new UsageError(`unknown space: ${value}. Spaces: ${state.spaces.map(s => `${s.name} (${s.id})`).join(', ') || 'none'}`);
  return space.id;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runWorkbenchCli(args: readonly string[], io: WorkbenchCliIo = defaultIo): Promise<Result> {
  const sub = args[0];
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    io.stdout(`${WORKBENCH_USAGE}\n`);
    return { exitCode: sub === undefined ? USAGE_EXIT_CODE : 0 };
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args.slice(1));
  } catch (error) {
    return emitError(io, 'invalid-request', error instanceof Error ? error.message : String(error), {}, USAGE_EXIT_CODE);
  }
  if (parsed.booleans.has('help')) { io.stdout(`${WORKBENCH_USAGE}\n`); return { exitCode: 0 }; }
  if (!(WORKBENCH_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return emitError(io, 'invalid-request', `unknown subcommand: ${sub}. Expected one of ${WORKBENCH_SUBCOMMANDS.join(', ')}.`, {}, USAGE_EXIT_CODE);
  }
  const json = parsed.booleans.has('json');
  const lang = parsed.flags.lang === 'en' ? 'en' : 'zh';
  let base: string;
  try {
    const flagUrl = parsed.flags['daemon-url'];
    base = (await resolveDaemonUrl(flagUrl ? { flagUrl } : {})).replace(/\/+$/u, '');
  } catch (error) {
    return emitError(io, 'daemon-not-running', error instanceof Error ? error.message : String(error));
  }
  const api = client(io, base, lang);
  const [first, ...rest] = parsed.positionals;

  try {
    switch (sub) {
      case 'state': {
        const data = await api.call<WorkbenchStateResponse>('GET', 'state');
        if (json) return printJson(io, data);
        io.stdout(formatState(data));
        return { exitCode: 0 };
      }
      case 'ops': {
        const file = parsed.flags.file ?? parsed.flags['prompt-file'] ?? first;
        if (!file) throw new UsageError('ops requires --file <path|->');
        let input: unknown;
        try { input = JSON.parse(await readText(io, file)); } catch (error) { throw new UsageError(`ops file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
        const ops = Array.isArray(input) ? input : (input as { ops?: unknown })?.ops;
        if (!Array.isArray(ops)) throw new UsageError('ops file must be an array of ops or {"ops":[...]}');
        const label = parsed.flags.label ?? (Array.isArray(input) ? undefined : (input as { label?: unknown }).label);
        const data = await api.call<WorkbenchOpsResponse>('POST', 'ops', { ops, ...(typeof label === 'string' ? { label } : {}), ...(parsed.booleans.has('no-undo') ? { undoable: false } : {}) });
        if (json) return printJson(io, data);
        io.stdout(receiptsText(data.receipts, data.errors));
        return { exitCode: data.errors.length && !data.receipts.length ? 1 : 0 };
      }
      case 'capture': {
        const fromFile = parsed.flags['prompt-file'];
        if (fromFile && parsed.positionals.length) throw new UsageError('use either <text|url> or --prompt-file, not both');
        const text = fromFile ? await readText(io, fromFile) : parsed.positionals.join(' ').trim();
        if (!text) throw new UsageError('capture requires <text|url> or --prompt-file');
        const spaceId = await resolveSpace(api, parsed.flags.space);
        const tags = parsed.repeated.tag ?? [];
        if (/^https?:\/\/\S+$/i.test(text)) {
          const data = await api.call<WorkbenchCaptureResponse>('POST', 'capture-url', { url: text, tags, ...(spaceId ? { spaceId } : {}), ...(parsed.flags.title ? { title: parsed.flags.title } : {}) });
          if (json) return printJson(io, data);
          io.stdout(`${receiptsText(data.receipts, data.errors)}${data.id ? `id: ${data.id}\n` : ''}`);
          return { exitCode: data.id ? 0 : 1 };
        }
        const title = parsed.flags.title ?? (text.split(/[。！？\n]|[.!?](?:\s|$)/)[0] ?? text).slice(0, 40);
        const kind = /^[「“"].+[」”"]$/su.test(text) ? 'quote' : 'note';
        const data = await api.call<WorkbenchOpsResponse>('POST', 'ops', { ops: [{ op: 'add_item', kind, title, body: text, tags, ...(spaceId ? { spaceId } : {}) }], label: lang === 'en' ? 'Capture' : '收集' });
        if (json) return printJson(io, data);
        const id = data.receipts[0]?.target;
        io.stdout(`${receiptsText(data.receipts, data.errors)}${id ? `id: ${id}\n` : ''}`);
        return { exitCode: id ? 0 : 1 };
      }
      case 'search': {
        const q = parsed.positionals.join(' ').trim();
        if (!q) throw new UsageError('search requires <query>');
        const mode = parsed.booleans.has('meaning') ? 'meaning' : 'text';
        const data = await api.call<WorkbenchSearchResponse>('GET', `library/search?q=${encodeURIComponent(q)}&mode=${mode}`);
        if (json) return printJson(io, data);
        if (!data.hits.length) { io.stdout(`No matches for "${q}".\n`); return { exitCode: 0 }; }
        const { state } = await api.call<WorkbenchStateResponse>('GET', 'state');
        const byId = new Map(state.items.map(item => [item.id, item]));
        io.stdout(`${data.hits.map((hit) => {
          const item = byId.get(hit.id);
          return `${hit.id}\t${hit.score.toFixed(2)}\t${item?.kind ?? ''}\t${item?.title ?? ''}${hit.excerpt ? `\n    ${hit.excerpt.replace(/\s+/g, ' ')}` : ''}`;
        }).join('\n')}\n`);
        return { exitCode: 0 };
      }
      case 'read': {
        if (!first || rest.length) throw new UsageError('read requires exactly one <itemId>');
        let { state } = await api.call<WorkbenchStateResponse>('GET', 'state');
        let item = state.items.find(row => row.id === first);
        if (!item) return emitError(io, 'not-found', `item not found: ${first}`, {}, 1);
        if (item.url && !item.reader?.text && !parsed.booleans.has('no-fetch')) {
          try {
            const data = await api.call<WorkbenchReaderResponse>('POST', 'library/reader', { id: item.id });
            state = data.state;
            item = state.items.find(row => row.id === first) ?? item;
          } catch (error) {
            if (!(error instanceof CallFailed)) throw error;
            // The item itself is still readable without reader text; the error is already on stderr.
          }
        }
        if (json) return printJson(io, { item, space: item.spaceId ? state.spaces.find(row => row.id === item!.spaceId) ?? null : null });
        io.stdout(formatItem(item, state));
        return { exitCode: 0 };
      }
      case 'chat': {
        const fromFile = parsed.flags['prompt-file'];
        if (fromFile && parsed.positionals.length) throw new UsageError('use either <message> or --prompt-file, not both');
        const message = fromFile ? await readText(io, fromFile) : parsed.positionals.join(' ').trim();
        if (!message) throw new UsageError('chat requires <message> or --prompt-file');
        const data = await api.call<WorkbenchChatResponse>('POST', 'chat', { message, ...(parsed.flags.focus ? { focusId: parsed.flags.focus } : {}) });
        if (json) return printJson(io, data);
        const { answer } = data;
        const lines = [answer.text];
        if (answer.notice) lines.push(`(${answer.notice})`);
        for (const receipt of answer.receipts ?? []) lines.push(`✓ ${receipt.text}`);
        for (const error of answer.errors ?? []) lines.push(`✗ ${error}`);
        if (answer.citations?.length) {
          const byId = new Map(data.state.items.map(item => [item.id, item]));
          lines.push('', 'Sources:', ...answer.citations.map(id => `  ${id}\t${byId.get(id)?.title ?? ''}`));
        }
        if (data.actions.length) lines.push('', `Suggested actions: ${data.actions.map(a => (a.type === 'nav' ? `nav ${a.page}` : `${a.type} ${a.id}`)).join(', ')}`);
        io.stdout(`${lines.join('\n')}\n`);
        return { exitCode: 0 };
      }
      case 'produce': {
        if (!first || rest.length) throw new UsageError('produce requires exactly one <itemId>');
        const started = await api.call<WorkbenchProduceResponse>('POST', 'produce', { id: first, ...(parsed.booleans.has('no-images') ? { withImages: false } : {}) });
        if (!parsed.booleans.has('wait')) {
          if (json) return printJson(io, { started: started.started, production: started.state.items.find(row => row.id === first)?.production ?? null });
          io.stdout(started.started ? `Production started for ${first}. Poll with: od workbench read ${first}\n` : `A production is already running for ${first}.\n`);
          return { exitCode: 0 };
        }
        let last: WorkbenchProductionResponse;
        for (;;) {
          last = await api.call<WorkbenchProductionResponse>('GET', `production?id=${encodeURIComponent(first)}`);
          if (!last.live?.running && last.production?.status !== 'running') break;
          await sleep(2000);
        }
        if (json) return printJson(io, last);
        const production = last.production;
        if (!production) { io.stdout('No production.\n'); return { exitCode: 1 }; }
        const assets = [production.cover, ...production.images, ...production.shots].filter(Boolean);
        io.stdout(`${production.status}: ${production.title}${production.error ? ` (${production.error})` : ''}\n${production.notice ? `${production.notice}\n` : ''}images: ${assets.filter(a => a!.status === 'done').length}/${assets.length} done\n\n${production.article}\n`);
        return { exitCode: production.status === 'done' ? 0 : 1 };
      }
      case 'import': {
        const text = parsed.positionals.join(' ').trim();
        if (!text) throw new UsageError('import requires <account-url>');
        const data = await api.call<WorkbenchSocialImportResponse>('POST', 'social/import', { text });
        if (json) return printJson(io, data);
        io.stdout(`Imported ${data.count} posts from ${data.platform} · ${data.nickname} (${data.added} new) · charged $${data.chargedUsd}\n${data.styleName ? `Style learned: ${data.styleName}\n` : data.styleError ? `Style not learned: ${data.styleError}\n` : ''}`);
        return { exitCode: 0 };
      }
      case 'organize': {
        if (!parsed.positionals.length) throw new UsageError('organize requires <itemId>...');
        const data = await api.call<WorkbenchOrganizeResponse>('POST', 'library/organize', { ids: parsed.positionals });
        if (json) return printJson(io, data);
        const byId = new Map(data.state.items.map(item => [item.id, item]));
        io.stdout(`${[...data.organized.map(id => `✓ ${byId.get(id) ? itemLine(byId.get(id)!, data.state) : id}`), ...data.errors.map(e => `✗ ${e}`)].join('\n') || 'Nothing organised.'}\n`);
        return { exitCode: data.organized.length || !data.errors.length ? 0 : 1 };
      }
      case 'undo': {
        const data = await api.call<WorkbenchUndoResponse>('POST', 'undo');
        if (json) return printJson(io, data);
        io.stdout(data.label ? `Undid: ${data.label}\n` : 'Nothing to undo.\n');
        return { exitCode: 0 };
      }
      default:
        return emitError(io, 'invalid-request', `unknown subcommand: ${sub}`, {}, USAGE_EXIT_CODE);
    }
  } catch (error) {
    if (error instanceof CallFailed) return error.result;
    if (error instanceof UsageError) return emitError(io, 'invalid-request', error.message, {}, USAGE_EXIT_CODE);
    return emitError(io, 'cli-error', error instanceof Error ? error.message : String(error));
  }
}

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise(resolve => stream.write('', () => resolve()));
}

/** SUBCOMMAND_MAP entry: run, flush (large --json payloads), and leave the exit code for cli.ts. */
export async function runWorkbench(args: string[]): Promise<void> {
  const { exitCode } = await runWorkbenchCli(args);
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exitCode = exitCode;
}
