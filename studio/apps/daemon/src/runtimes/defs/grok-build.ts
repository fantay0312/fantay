import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import {
  FAST_SERVICE_TIER,
  foldModelVariants,
  isReasoningEffort,
  normalizeModelLabel,
  reasoningEffortOptions,
  resolveVariantModelId,
} from '../model-variants.js';
import { findKnownModel } from '../models.js';
import type { RuntimeModelOption } from '../types.js';
import type { RuntimeAgentDef } from '../types.js';

const GROK_MODEL_ID_RE = /^\*?\s*-?\s*(grok-[a-z0-9][a-z0-9._-]*)(?:\s+\(default\))?\s*$/i;

/** What `~/.grok/models_cache.json` says about one model id. */
export type GrokModelCacheEntry = {
  name?: string;
  /** The cache's one-line copy (`Fast variant. 2x the price.` on a fast id). */
  description?: string;
  reasoningOptions?: RuntimeModelOption[];
};

export type GrokModelsCache = Map<string, GrokModelCacheEntry>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads the per-model details `grok models` caches next to its auth
 * (`$GROK_HOME` or `~/.grok`, file `models_cache.json`): display names and the
 * reasoning efforts each model accepts. Any error means "no extra details".
 */
export function readGrokModelsCache(env: NodeJS.ProcessEnv = process.env): GrokModelsCache | null {
  try {
    const home = env.GROK_HOME?.trim() || join(homedir(), '.grok');
    return parseGrokModelsCache(JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')));
  } catch {
    return null;
  }
}

export function parseGrokModelsCache(raw: unknown): GrokModelsCache | null {
  const models = asRecord(asRecord(raw)?.models);
  if (!models) return null;
  const out: GrokModelsCache = new Map();
  for (const [key, value] of Object.entries(models)) {
    const info = asRecord(asRecord(value)?.info);
    if (!info) continue;
    const id = typeof info.id === 'string' && info.id ? info.id : key;
    const entry: GrokModelCacheEntry = {};
    const name = normalizeModelLabel(typeof info.name === 'string' ? info.name : '');
    if (name) entry.name = name;
    const description = typeof info.description === 'string' ? info.description.trim() : '';
    if (description) entry.description = description;
    const listed = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : [];
    if (info.supports_reasoning_effort !== false && listed.length > 0) {
      const efforts: string[] = [];
      let markedDefault: string | undefined;
      for (const item of listed) {
        const record = asRecord(item);
        const effort = record?.id ?? record?.value;
        if (!isReasoningEffort(effort)) continue;
        efforts.push(effort);
        if (record?.default === true && !markedDefault) markedDefault = effort;
      }
      const preferred = [info.reasoning_effort, markedDefault, 'medium'].find(
        (effort): effort is string => isReasoningEffort(effort) && efforts.includes(effort),
      );
      const options = reasoningEffortOptions(efforts, preferred);
      if (options.length > 0) {
        if (!options.some((option) => option.default)) options[0] = { ...options[0]!, default: true };
        entry.reasoningOptions = options;
      }
    }
    out.set(id, entry);
  }
  return out;
}

/**
 * `grok models` lists the fast tier as its own id (`grok-4.7-build-fast` beside
 * `grok-4.7`); fold it into the base model's `fast` service tier. Effort is a
 * CLI flag on grok, not part of the id.
 */
export function foldGrokBuildModels(models: RuntimeModelOption[]): RuntimeModelOption[] {
  const ids = new Set(models.map((model) => model.id));
  return foldModelVariants(models, (id) => {
    if (!id.endsWith('-fast')) return { family: id };
    const stripped = id.slice(0, -'-fast'.length);
    const withoutBuild = stripped.endsWith('-build') ? stripped.slice(0, -'-build'.length) : null;
    const base = ids.has(stripped) ? stripped : withoutBuild && ids.has(withoutBuild) ? withoutBuild : null;
    return base ? { family: base, fast: true } : null;
  });
}

export function parseGrokBuildModels(
  stdout: string,
  cache: GrokModelsCache | null = readGrokModelsCache(),
): RuntimeModelOption[] {
  const seen = new Set<string>();
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  for (const rawLine of String(stdout || '').split('\n')) {
    const match = rawLine.trim().match(GROK_MODEL_ID_RE);
    const id = match?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cached = cache?.get(id);
    out.push({
      id,
      label: cached?.name || id,
      ...(cached?.reasoningOptions ? { reasoningOptions: cached.reasoningOptions.map((option) => ({ ...option })) } : {}),
    });
  }
  return describeFastTiers(foldGrokBuildModels(out), cache);
}

/**
 * A folded family's fast tier carries the fast id's own cache copy
 * (`Fast variant. 2x the price.`), so the speed menu can say what it costs.
 */
function describeFastTiers(models: RuntimeModelOption[], cache: GrokModelsCache | null): RuntimeModelOption[] {
  if (!cache) return models;
  return models.map((model) => {
    const fastId = model.variants?.find((variant) => variant.serviceTier === FAST_SERVICE_TIER)?.id;
    const description = fastId ? cache.get(fastId)?.description : undefined;
    if (!description || !model.serviceTierOptions?.some((tier) => tier.id === FAST_SERVICE_TIER)) return model;
    return {
      ...model,
      serviceTierOptions: model.serviceTierOptions.map((tier) =>
        tier.id === FAST_SERVICE_TIER ? { ...tier, description } : tier,
      ),
    };
  });
}

const GROK_BUILD_FALLBACK_MODELS: RuntimeModelOption[] = [
  DEFAULT_MODEL_OPTION,
  { id: 'grok-build', label: 'grok-build (xAI · default)' },
  { id: 'grok-4.3', label: 'grok-4.3 (xAI)' },
  { id: 'grok-4.20-reasoning', label: 'grok-4.20-reasoning (xAI · deep)' },
  {
    id: 'grok-4.20-non-reasoning',
    label: 'grok-4.20-non-reasoning (xAI · fast)',
  },
  {
    id: 'grok-4.20-multi-agent',
    label: 'grok-4.20-multi-agent (xAI · orchestration)',
  },
];

// What grok 1.0.77 listed on 2026-11-09 (`grok models` plus its
// models_cache.json), folded. Known-model lookups use it when the live cache
// lacks an id, so a saved `grok-4.7` + fast still spawns `grok-4.7-build-fast`
// (and keeps its effort) before the first `grok models` succeeds.
const GROK_EFFORTS_TO_XHIGH = ['low', 'medium', 'high', 'xhigh'];
const GROK_BUILD_MODEL_CATALOG: RuntimeModelOption[] = parseGrokBuildModels(
  ['  - grok-4.7', '  * grok-4.7-build-fast (default)', '  - grok-4.6', '  - grok-4.5'].join('\n'),
  new Map([
    ['grok-4.7', { name: 'Grok 4.7', reasoningOptions: reasoningEffortOptions(GROK_EFFORTS_TO_XHIGH, 'high') }],
    [
      'grok-4.7-build-fast',
      {
        name: 'Grok 4.7 Fast',
        description: 'Fast variant. 2x the price.',
        reasoningOptions: reasoningEffortOptions(GROK_EFFORTS_TO_XHIGH, 'high'),
      },
    ],
    ['grok-4.6', { name: 'Grok 4.6', reasoningOptions: reasoningEffortOptions(GROK_EFFORTS_TO_XHIGH, 'high') }],
    ['grok-4.5', { name: 'Grok 4.5', reasoningOptions: reasoningEffortOptions(['low', 'medium', 'high'], 'high') }],
  ]),
);

const GROK_BUILD_MODEL_SOURCE = {
  id: 'grok-build',
  fallbackModels: GROK_BUILD_FALLBACK_MODELS,
  modelCatalog: GROK_BUILD_MODEL_CATALOG,
};

// `--effort` goes to models that list the effort (models_cache.json), legacy
// `*-reasoning` ids, and the CLI default model (grok 1.0.77 accepts
// `--effort low` without `-m`). `grok-build` never takes it.
function grokAcceptsReasoningEffort(model: string | null | undefined, effort: string): boolean {
  if (!model || model === DEFAULT_MODEL_OPTION.id) return true;
  if (model === 'grok-build') return false;
  const known = findKnownModel(GROK_BUILD_MODEL_SOURCE, model);
  if (known?.reasoningOptions?.some((option) => option.id === effort)) return true;
  return /reasoning/i.test(model);
}

// xAI's first-party CLI agent — https://x.ai/cli — distributed as the
// `grok` binary. Installed via `curl -fsSL https://x.ai/cli/install.sh | bash`,
// which symlinks `~/.grok/bin/grok` into PATH.
//
// `grok` ships its own SuperGrok OAuth dance (same `auth.x.ai` issuer +
// loopback-redirect shape OpenDesign's xAI Settings panel uses), so it's
// already authenticated by the time OD detects the binary; OD does not
// need to inject credentials. Users authenticate once with `grok login
// --oauth` and the resulting `~/.grok/auth.json` is what every spawned
// invocation reads.
//
// Headless mode uses `--prompt-file <PATH>` because recent Grok CLI builds
// require `-p/--single` to receive the prompt as an argv value and no longer
// read piped stdin. OD's composed prompts often exceed safe argv limits, so
// the daemon stages the prompt in a temp file and passes that path here. The
// CLI also exposes `--output-format streaming-json`, but
// the streaming-json schema is xAI-specific and we do not yet have a
// daemon-side parser for it. To ship the runtime now and let users at
// least chat with grok inside OD, this defaults to `plain` streamFormat
// (single-turn text reply, no tool_use streaming). Upgrading to a
// `grok-stream-json` event parser is follow-up work once the format is
// stable enough to lock in.
export const grokBuildAgentDef = {
  id: 'grok-build',
  name: 'Grok Build',
  bin: 'grok',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  // `grok models` prints status/header lines plus bullet-prefixed model ids.
  // Keep only concrete `grok-*` ids so UI pickers don't show prose such as
  // "You are logged in with grok.com" as selectable model names.
  // Labels and per-model efforts come from the cache `grok models` refreshes.
  listModels: {
    args: ['models'],
    timeoutMs: 10_000,
    parse: (stdout) => parseGrokBuildModels(stdout),
  },
  fallbackModels: GROK_BUILD_FALLBACK_MODELS,
  modelCatalog: GROK_BUILD_MODEL_CATALOG,
  // Grok Build CLI v0.1.212+ enforces `-p, --single <PROMPT>` as value-
  // required, while normal OD composed prompts exceed safe argv budgets.
  // Use the CLI's explicit prompt-file transport instead. Headless runs also
  // need plan mode disabled and tool calls auto-approved: otherwise a write
  // request is permission-cancelled while the CLI still exits successfully.
  buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}, runtimeContext = {}) => {
    if (!runtimeContext.promptFilePath) {
      throw new Error('grok-build requires runtimeContext.promptFilePath');
    }
    const permission = runtimeContext.executionPermission;
    const args = ['--prompt-file', runtimeContext.promptFilePath];
    if (permission === 'read-only') {
      args.push(
        '--permission-mode',
        'dontAsk',
        '--deny',
        'Bash',
        '--deny',
        'Edit',
        '--deny',
        'MCPTool',
        '--disallowed-tools',
        'Bash,Edit,Write,MultiEdit,NotebookEdit',
        '--disable-web-search',
        '--no-subagents',
      );
    } else if (permission === 'workspace-write') {
      args.push(
        '--no-plan',
        '--permission-mode',
        'acceptEdits',
        '--deny',
        'Bash',
        '--deny',
        'MCPTool',
        '--disallowed-tools',
        'Bash',
        '--disable-web-search',
        '--no-subagents',
      );
    } else if (permission === 'danger-full-access') {
      args.push('--no-plan', '--always-approve', '--permission-mode', 'bypassPermissions');
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && d.length > 0,
      );
      for (const dir of dirs) args.push('--add-dir', dir);
    } else {
      args.push('--no-plan', '--always-approve');
    }
    // The fast tier is its own id (`grok-4.7` + fast → `grok-4.7-build-fast`).
    const { model } = resolveVariantModelId(GROK_BUILD_MODEL_SOURCE, options);
    if (model && model !== DEFAULT_MODEL_OPTION.id) {
      args.push('--model', model);
    }
    if (options.reasoning && grokAcceptsReasoningEffort(options.model, options.reasoning)) {
      args.push('--effort', options.reasoning);
    }
    return args;
  },
  // Every grok model in models_cache.json (1.0.77) lists at most low..xhigh.
  reasoningOptions: [
    { id: 'low', label: 'low' },
    { id: 'medium', label: 'medium' },
    { id: 'high', label: 'high' },
    { id: 'xhigh', label: 'xhigh' },
  ],
  promptViaFile: true,
  promptViaStdin: false,
  streamFormat: 'plain',
  installUrl: 'https://x.ai/cli',
  docsUrl: 'https://x.ai/cli',
} satisfies RuntimeAgentDef;
