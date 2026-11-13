import { CURSOR_AGENT_MODELS_SNAPSHOT_LINES } from './cursor-agent-models-snapshot.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import { agentCapabilities } from '../capabilities.js';
import {
  foldModelVariants,
  normalizeModelLabel,
  resolveVariantModelId,
  type ModelVariantParse,
} from '../model-variants.js';
import type { RuntimeAgentDef } from '../types.js';
import type { RuntimeModelOption } from '../types.js';

const CURSOR_EFFORT_TOKENS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * `cursor-agent models` lists every effort / speed pairing as its own id:
 * `<family>[-<effort>][-fast]`, with `extra-high` for xhigh and, on a few
 * Claude ids, the effort before a trailing `-thinking`
 * (`claude-4.6-opus-high-thinking` belongs to `claude-4.6-opus-thinking`).
 */
export function parseCursorAgentModelVariant(id: string): ModelVariantParse | null {
  if (!id || id === 'auto') return null;
  const tokens = id.split('-');
  let fast = false;
  if (tokens.length > 1 && tokens[tokens.length - 1] === 'fast') {
    tokens.pop();
    fast = true;
  }
  let reasoning: string | undefined;
  const last = tokens[tokens.length - 1] ?? '';
  const beforeLast = tokens[tokens.length - 2] ?? '';
  if (tokens.length > 2 && last === 'high' && beforeLast === 'extra') {
    tokens.splice(-2, 2);
    reasoning = 'xhigh';
  } else if (tokens.length > 1 && CURSOR_EFFORT_TOKENS.has(last)) {
    tokens.pop();
    reasoning = last;
  } else if (tokens.length > 2 && last === 'thinking' && CURSOR_EFFORT_TOKENS.has(beforeLast)) {
    tokens.splice(-2, 1);
    reasoning = beforeLast;
  }
  if (tokens.length === 0) return null;
  return {
    family: tokens.join('-'),
    ...(reasoning ? { reasoning } : {}),
    ...(fast ? { fast: true } : {}),
  };
}

/** Parses `cursor-agent models` and folds effort / speed ids into one option per model. */
export function parseCursorAgentModels(stdout: string): RuntimeModelOption[] | null {
  const parsed = parseCursorAgentModelLines(stdout);
  return parsed ? foldModelVariants(parsed, parseCursorAgentModelVariant) : null;
}

function parseCursorAgentModelLines(stdout: string): RuntimeModelOption[] | null {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return null;

  const out = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const line of lines) {
    if (/^(available models|models)$/i.test(line)) continue;

    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/:@-]*)(?:\s+-\s+(.+))?$/);
    if (!match) continue;
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label = normalizeModelLabel(match[2]) || id;
    out.push({ id, label });
  }

  return out.length > 1 ? out : null;
}

// Everything cursor-agent 2026.11.05 listed, folded. Known-model lookups use
// it when the live cache lacks an id, so a saved family plus effort / fast
// (`claude-opus-4-7` + xhigh) still reaches the CLI as the real id
// (`claude-opus-4-7-xhigh`) before the first `cursor-agent models` succeeds.
const CURSOR_AGENT_MODEL_CATALOG: RuntimeModelOption[] =
  parseCursorAgentModels(CURSOR_AGENT_MODELS_SNAPSHOT_LINES.join('\n')) ?? [DEFAULT_MODEL_OPTION];

// The picker list for when `cursor-agent models` cannot answer (offline,
// signed out): a few current families from the same snapshot.
const CURSOR_AGENT_FALLBACK_MODEL_IDS = new Set([
  DEFAULT_MODEL_OPTION.id,
  'auto',
  'composer-2.5',
  'gpt-5.6-sol',
  'grok-4.7',
  'claude-opus-5-5',
  'gpt-5.5',
  'claude-fable-5-1',
  'gemini-3.8-flash',
  'claude-sonnet-5-5',
]);

const CURSOR_AGENT_FALLBACK_MODELS: RuntimeModelOption[] = CURSOR_AGENT_MODEL_CATALOG.filter((model) =>
  CURSOR_AGENT_FALLBACK_MODEL_IDS.has(model.id),
);

const CURSOR_AGENT_MODEL_SOURCE = {
  id: 'cursor-agent',
  fallbackModels: CURSOR_AGENT_FALLBACK_MODELS,
  modelCatalog: CURSOR_AGENT_MODEL_CATALOG,
};

export const cursorAgentDef = {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    bin: 'cursor-agent',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    capabilityFlags: {
      // Flag string -> capability key. After probing `--help`, detection sets
      // `agentCapabilities['cursor-agent'][key] = true` for each substring it
      // finds. `--trust` is only honored in `-p`/headless mode and only exists
      // on newer cursor-agent builds; older installs reject it with
      // "unknown option '--trust'" and exit 1, which kills Test and task
      // execution (issue #4461). Gate on the probe like claude/codebuddy do.
      '--trust': 'trust',
      '--mode': 'mode',
      '--sandbox': 'sandbox',
    },
    // `cursor-agent models` prints account-bound model ids per line. When
    // the user isn't authed it prints "No models available for this
    // account." — that's not a model list, so we detect it and fall back.
    // The command takes ~2 s warm and detection probes every CLI at once, so a
    // 5 s budget timed out under load and surfaced the static list instead.
    listModels: {
      args: ['models'],
      timeoutMs: 20_000,
      parse: (stdout) => {
        const trimmed = String(stdout || '').trim();
        if (!trimmed || /no models available/i.test(trimmed)) return null;
        return parseCursorAgentModels(trimmed);
      },
    },
    fallbackModels: CURSOR_AGENT_FALLBACK_MODELS,
    modelCatalog: CURSOR_AGENT_MODEL_CATALOG,
    // Cursor Agent does not use `-` as a "read prompt from stdin" sentinel.
    // Passing it makes the CLI treat the dash as the literal user prompt,
    // which then surfaces as "your message only contains '-'". Keep stdin
    // piped for prompt delivery, but do not append a fake prompt arg.
    buildArgs: (
      _prompt,
      _imagePaths,
      _extra,
      options = {},
      runtimeContext = {},
    ) => {
      const caps = agentCapabilities.get('cursor-agent') || {};
      const permission = runtimeContext.executionPermission;
      if (
        (permission === 'read-only' || permission === 'workspace-write') &&
        caps.mode === false &&
        caps.sandbox === false
      ) {
        throw new Error(
          'Update Cursor Agent CLI to use restricted execution permissions.',
        );
      }
      const args = [
        '--print',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ];
      if (permission === 'read-only') {
        if (caps.mode !== false) args.push('--mode', 'ask');
        if (caps.sandbox !== false) args.push('--sandbox', 'enabled');
      } else if (permission === 'workspace-write') {
        args.push('--force');
        if (caps.sandbox !== false) args.push('--sandbox', 'enabled');
      } else if (permission === 'danger-full-access') {
        args.push('--force');
        if (caps.sandbox !== false) args.push('--sandbox', 'disabled');
      } else {
        args.push('--force');
      }
      // `--trust` grants workspace trust in headless runs, but only newer
      // cursor-agent builds accept it; older ones exit 1 with "unknown option"
      // (issue #4461). Pass it only when the `--help` probe saw it.
      if (caps.trust) {
        args.push('--trust');
      }
      if (runtimeContext.cwd) {
        args.push('--workspace', runtimeContext.cwd);
      }
      // Effort and speed live in Cursor's model id, so a folded family choice
      // resolves to the one concrete id that encodes them.
      const { model } = resolveVariantModelId(CURSOR_AGENT_MODEL_SOURCE, options);
      if (model && model !== 'default') {
        args.push('--model', model);
      }
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'json-event-stream',
    eventParser: 'cursor-agent',
    // `cursor-agent status` is a cheap, side-effect-free auth check. Declaring
    // it here is what makes detection surface an "auth required" badge for
    // Cursor Agent (the generalized probe only runs for adapters that opt in).
    authProbe: { args: ['status'], timeoutMs: 5000 },
} satisfies RuntimeAgentDef;
