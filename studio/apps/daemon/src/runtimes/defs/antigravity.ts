import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import { agentCapabilities } from '../capabilities.js';
import {
  foldModelVariants,
  isReasoningEffort,
  resolveVariantModelId,
  type ModelVariantParse,
} from '../model-variants.js';
import type { RuntimeAgentDef, RuntimeBuildOptions, RuntimeModelOption } from '../types.js';

const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

// Headless runs use agy's documented stdin channel (agy >= 1.1.15):
//   agy --input-format stream-json --output-format stream-json
// with the prompt written to stdin as one NDJSON `user` message. The prompt
// must never ride argv: on Windows the composed OD prompt routinely exceeds
// CreateProcess's 32_767-char command line and the spawn dies with
// `ENAMETOOLONG` before agy starts (OPEND-3495). And agy has no other way to
// read stdin — with `-p <text>` it ignores stdin entirely (agy 1.1.1: "no
// longer reading stdin when a prompt is provided via a flag"), while `-p -`
// is the literal prompt "-" (#7161). Every stream-json message runs one turn;
// the daemon hands the frame over as a complete file-backed stdin, so agy
// sees EOF after it and ends the session once the turn finishes.
const ANTIGRAVITY_STREAM_JSON_ARGS = [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
] as const;

export function encodeAntigravityStdinPrompt(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

// Current `agy` lists its models (`agy models`, tab-separated `id<TAB>label`) and
// takes `--model <id>` on headless runs: checked on 1.4.12, where the log confirms
// `Propagating selected model override to backend: label="<model>"`.
//
// Older builds had no such flag (upstream issue #35). There the TUI's Switch-Model
// picker writes the choice to its settings.json, and every headless `agy` run
// re-reads that file on startup, so the daemon writes the label there right before
// spawn. A saved pick from those builds is a label with spaces, so it keeps that
// route; `antigravityTakesModelFlag` decides.
//
// `default` passes nothing and leaves settings.json alone, so agy keeps whatever
// the user last picked in its own TUI.
//
// `supportsCustomModel: false` because the label set is a server-side
// enum — a typed id agy doesn't recognise resolves to a silent
// `availableModels` cache miss + empty headless output, which surfaces
// to the user as a generic "empty response" error.
//
// The 8 model labels mirror what `Switch Model` in agy's TUI lists for
// consumer-tier accounts as of 2026-05-28. The set is small and stable
// enough to ship statically until upstream adds a programmatic
// `agy models` subcommand (also tracked under issue #35).
const ANTIGRAVITY_SETTINGS_PATH = join(
  homedir(),
  '.gemini',
  'antigravity-cli',
  'settings.json',
);

export function writeAntigravityModelSelection(
  label: string,
  settingsPath: string = ANTIGRAVITY_SETTINGS_PATH,
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — fall through and rewrite the file from scratch so
      // the next spawn starts from a known-good state.
    }
  }
  existing.model = label;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

// Per-process serialization for write-settings → spawn → agy-reads
// cycles on antigravity. `~/.gemini/antigravity-cli/settings.json` is
// process-global, so two OD runs that both pick concrete (non-default)
// models can race: run A writes model A, spawn A starts, run B writes
// model B before A's agy has read settings.json — A then executes on
// model B. The daemon serialises non-default antigravity spawns
// through this chain: each acquire awaits the previous release, and
// each release fires only after the spawned agy actually emits
// `Propagating selected model override to backend: label="<X>"` in
// its `--log-file` (which is the upstream signal that settings.json
// has been read).
let antigravityLockChain: Promise<void> = Promise.resolve();

export async function acquireAntigravityModelLock(): Promise<() => void> {
  const previous = antigravityLockChain;
  let release: () => void = () => {};
  antigravityLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

// Visible for tests. Resets the module-level lock chain so a test that
// installed a hanging acquirer can release it without leaking state to
// subsequent test cases. Production code never calls this.
export function _resetAntigravityModelLockForTests(): void {
  antigravityLockChain = Promise.resolve();
}

export interface WaitForAgyModelOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  // Override for tests; production reads the daemon-owned log file path.
  readFile?: (path: string) => Promise<string>;
  // Override `Date.now` for tests; production uses the wall clock.
  now?: () => number;
  // Stops polling when fired. Production wires this to `child.once('exit')`
  // so the watcher cancels as soon as agy exits — the lock release is
  // then driven by the exit handler rather than the helper's return
  // value, eliminating the slow-startup race the looper review at
  // 263fd2fe7 flagged: if a cold agy takes >timeoutMs to read its
  // settings.json, we'd otherwise return false, the caller would
  // release the lock, and a concurrent run B could rewrite
  // settings.json before A's agy actually read it.
  abortSignal?: AbortSignal;
}

// Polls agy's `--log-file` for the line
//   `Propagating selected model override to backend: label="<expectedModel>"`
// which `model_config_manager.go` emits once agy has finished reading
// `~/.gemini/antigravity-cli/settings.json` and sent the model
// override to the upstream backend. Returns true on observed signal,
// false on timeout OR abort. Never throws — a missing log file is
// treated as "not yet seen" so the polling loop keeps retrying until
// either the deadline or the abort signal fires.
//
// IMPORTANT: callers MUST NOT use a `false` return as a "go ahead and
// release the settings.json lock" signal — false means "I gave up
// polling," not "agy definitely didn't read this." Release the lock
// only on (a) a `true` return, OR (b) child exit. See server.ts for
// the wiring.
export async function waitForAgyToReadModel(
  logFilePath: string,
  expectedModel: string,
  options: WaitForAgyModelOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readFile =
    options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const abortSignal = options.abortSignal;
  if (abortSignal?.aborted) return false;
  const escaped = expectedModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `Propagating selected model override to backend: label="${escaped}"`,
  );
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (abortSignal?.aborted) return false;
    try {
      const content = await readFile(logFilePath);
      if (pattern.test(content)) return true;
    } catch {
      // Log file may not have appeared yet; keep polling.
    }
    if (now() >= deadline) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  return false;
}

/** `agy models` ids end in the effort they run at: `gemini-4-argon-high` is Gemini 4 Argon (High). */
export function parseAntigravityModelVariant(id: string): ModelVariantParse | null {
  const match = /^(.+)-([a-z]+)$/.exec(id);
  if (!match?.[1] || !isReasoningEffort(match[2])) return null;
  return { family: match[1], reasoning: match[2] };
}

export function foldAntigravityModels(models: RuntimeModelOption[]): RuntimeModelOption[] {
  return foldModelVariants(models, parseAntigravityModelVariant);
}

/** Parses `agy models` (`id<TAB>label`) and folds effort ids into one option per model. */
export function parseAntigravityModels(stdout: string): RuntimeModelOption[] | null {
  const out = [DEFAULT_MODEL_OPTION];
  for (const line of String(stdout || '').split('\n')) {
    const [id, label] = line.trim().split('\t');
    if (id && label) out.push({ id, label });
  }
  return out.length > 1 ? foldAntigravityModels(out) : null;
}

/**
 * The model agy should run for these options: a folded family resolves to the
 * id that encodes the chosen effort; `default` (or no model) is null. The
 * daemon's settings.json lock in server.ts keys off the same value.
 */
export function resolveAntigravityConcreteModel(options: RuntimeBuildOptions = {}): string | null {
  const { model } = resolveVariantModelId(ANTIGRAVITY_MODEL_SOURCE, options);
  return typeof model === 'string' && model.length > 0 && model !== DEFAULT_MODEL_OPTION.id
    ? model
    : null;
}

const ANTIGRAVITY_FALLBACK_MODELS: RuntimeModelOption[] = foldAntigravityModels([
  DEFAULT_MODEL_OPTION,
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
]);

const ANTIGRAVITY_MODEL_SOURCE = { id: 'antigravity', fallbackModels: ANTIGRAVITY_FALLBACK_MODELS };

/** Ids carry no spaces; a value with spaces is a label saved for the settings.json route. */
export function antigravityTakesModelFlag(model: string): boolean {
  return agentCapabilities.get('antigravity')?.modelFlag === true && !/\s/.test(model);
}

export const antigravityAgentDef = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  capabilityFlags: {
    [ANTIGRAVITY_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
    '--model': 'modelFlag',
    '--mode': 'modeFlag',
    '--sandbox': 'sandboxFlag',
    '--add-dir': 'addDir',
  },
  listModels: { args: ['models'], timeoutMs: 8000, parse: parseAntigravityModels },
  // Only for when `agy models` cannot answer (offline, signed out): as listed by 1.4.12.
  fallbackModels: ANTIGRAVITY_FALLBACK_MODELS,
  supportsCustomModel: false,
  // We deliberately do NOT opt into `resumesSessionViaCli` / agy's `-c`
  // resume flag on follow-up turns. Tested both shapes; `-c` activates
  // agy's internal agentic loop (multi-step model retries, tool calls,
  // fallback-to-cached-response on tool errors) which can't be steered
  // from OD's system-prompt OVERRIDE — even with the strongest wording
  // we got an identical byte-for-byte form re-emission on turn 2 when
  // turn 1's tool-call retry path returned the cached form response.
  //
  // Instead we treat agy as a stateless adapter like qwen /
  // deepseek: every spawn gets the full OD-rendered transcript via
  // `buildDaemonTranscript`, and that transcript's prior assistant
  // turns are sanitized to strip `<question-form>` markup + form-schema
  // JSON fences (see `sanitizePriorAssistantTurnForTranscript` in
  // apps/web/src/providers/daemon.ts).
  buildArgs: (
    _prompt,
    _imagePaths,
    extraAllowedDirs = [],
    options = {},
    runtimeContext = {},
  ) => {
    const caps = agentCapabilities.get('antigravity') || {};
    const permission = runtimeContext.executionPermission;
    const restricted =
      permission === 'read-only' || permission === 'workspace-write';
    if (restricted && caps.modeFlag === false) {
      throw new Error(
        'Update Antigravity CLI to use restricted execution permissions.',
      );
    }
    // A folded family (`gemini-4-argon` + effort) becomes the id agy lists.
    const concreteModel = resolveAntigravityConcreteModel(options);
    if (concreteModel && !antigravityTakesModelFlag(concreteModel)) {
      writeAntigravityModelSelection(
        concreteModel,
        runtimeContext.antigravitySettingsPath,
      );
    }
    const args: string[] = [];
    // Always opt into `--log-file` when the daemon supplied a path: the
    // model lock in server.ts waits for agy to log the settings.json model
    // override there, and the connection test folds its tail into auth /
    // quota classification.
    //
    // Flag order is load-bearing on agy: put `--log-file` first so
    // diagnostics (model override / auth / quota) land in the log.
    if (runtimeContext.agentLogFilePath) {
      args.push('--log-file', runtimeContext.agentLogFilePath);
    }
    if (permission === 'read-only') {
      args.push('--mode', 'plan');
      if (caps.sandboxFlag !== false) args.push('--sandbox');
    } else if (permission === 'workspace-write') {
      args.push('--mode', 'accept-edits');
      if (caps.sandboxFlag !== false) args.push('--sandbox');
    } else if (permission === 'danger-full-access') {
      if (caps.skipPermissions !== false) {
        args.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
      }
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && d.length > 0,
      );
      if (dirs.length > 0 && caps.addDir !== false) {
        args.push('--add-dir', ...dirs);
      }
    } else if (caps.skipPermissions) {
      // Daemon-managed headless runs have no interactive approval channel.
      args.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
    }
    if (concreteModel && antigravityTakesModelFlag(concreteModel)) {
      args.push('--model', concreteModel);
    }
    args.push(...ANTIGRAVITY_STREAM_JSON_ARGS);
    return args;
  },
  promptViaStdin: true,
  encodeStdinPrompt: encodeAntigravityStdinPrompt,
  streamFormat: 'json-event-stream',
  eventParser: 'antigravity',
  installUrl: 'https://antigravity.google/cli',
  docsUrl: 'https://antigravity.google/docs/cli-overview',
} satisfies RuntimeAgentDef;
