/**
 * The pi runtime Fantay ships for its built-in agents (TokenToSea and
 * BYOK). Third-party CLIs, including a user-installed `pi`, are separate
 * runtime definitions and never read anything from this module.
 *
 * Every run gets its own pi agent directory holding a run-scoped `models.json`
 * (one provider, one model), `settings.json`, optional `mcp.json`, and the
 * Fantay tool extension. Secrets never touch disk: `models.json` names
 * the key as `$FANTAY_PI_API_KEY` and `mcp.json` names every MCP env/header
 * value as `${FANTAY_PI_MCP_n}`; only the child's env carries the values.
 * Sessions live beside the run directories so a conversation can resume the
 * same native session on its next turn.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUNDLED_PI_AGENT_IDS as CONTRACT_BUNDLED_PI_AGENT_IDS,
  BYOK_AGENT_ID,
  TOKENTOSEA_AGENT_ID,
  isBundledPiAgentId,
  type ByokChatProviderConfig,
  type ChatExecutionPermission,
} from '@open-design/contracts';
import type { RuntimeAgentDef, RuntimeContext } from './types.js';

export { BYOK_AGENT_ID, TOKENTOSEA_AGENT_ID };
export const BUNDLED_PI_AGENT_IDS: ReadonlySet<string> = new Set(CONTRACT_BUNDLED_PI_AGENT_IDS);
export const BUNDLED_PI_BIN_ENV = 'FANTAY_PI_BIN';
export const BUNDLED_PI_VERSION = '1.5.0';
export const BUNDLED_PI_PROVIDER_ID = 'fantay';
export const BUNDLED_PI_API_KEY_ENV = 'FANTAY_PI_API_KEY';
export const BUNDLED_PI_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
export const BUNDLED_PI_FIRST_OUTPUT_TIMEOUT_MS = 2 * 60_000;
export const BYOK_PROVIDER_REQUIRED_MESSAGE =
  'BYOK requires a complete provider configuration for this run.';

export function isBundledPiAgent(agentId: string | null | undefined): boolean {
  return isBundledPiAgentId(agentId);
}

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const PI_THINKING_LEVELS = new Set<string>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** TokenToSea's effort vocabulary projected onto pi's `--thinking` levels. */
export function piThinkingLevel(effort: string | null | undefined): PiThinkingLevel | null {
  if (typeof effort !== 'string' || !effort) return null;
  if (effort === 'on' || effort === 'default') return 'medium';
  const level = effort.replace(/^between_tools_/, '');
  return PI_THINKING_LEVELS.has(level) ? (level as PiThinkingLevel) : null;
}

type PiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'azure-openai-responses';

/** What one run needs from pi: its single model, the CLI selection and the child-only env. */
export interface BundledPiProvider {
  /** Model id inside the `fantay` provider; also the id pi sends upstream. */
  modelId: string;
  thinking: PiThinkingLevel | null;
  /** Child-only variables. The API key lives here and nowhere on disk. */
  env: Record<string, string>;
  modelsJson: Record<string, unknown>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_OUTPUT_TOKENS = 16_384;

function providerModelsJson(input: {
  api: PiApi;
  baseUrl: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  maxTokens: number;
  contextWindow?: number;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  apiKeyRequired: boolean;
}): Record<string, unknown> {
  return {
    providers: {
      [BUNDLED_PI_PROVIDER_ID]: {
        name: 'Fantay',
        baseUrl: input.baseUrl,
        api: input.api,
        // A keyless local endpoint still needs a value for pi to treat the
        // provider as configured; it is never a credential.
        apiKey: input.apiKeyRequired ? `$${BUNDLED_PI_API_KEY_ENV}` : 'local',
        ...(input.authHeader ? { authHeader: true } : {}),
        ...(input.compat ? { compat: input.compat } : {}),
        models: [{
          id: input.modelId,
          name: input.name,
          reasoning: input.reasoning,
          // Capability is the endpoint's to judge; let pi forward images
          // (including later read-tool results) instead of dropping them.
          input: ['text', 'image'],
          contextWindow: input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: input.maxTokens,
          // Billing belongs to the provider; pi must not invent prices.
          cost: ZERO_COST,
        }],
      },
    },
  };
}

/**
 * TokenToSea runs talk only to the daemon's lease-guarded inference proxy.
 * The proxy owns reasoning controls and output ceilings, so pi is told not to
 * send its own reasoning parameters; it still parses and replays reasoning.
 */
export function buildTokenToSeaPiProvider(input: {
  daemonOrigin: string;
  token: string;
  protocol: 'openai' | 'anthropic';
  modelId: string;
  modelName: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  interleavedReasoning: boolean;
  contextWindow?: number;
}): BundledPiProvider {
  const origin = input.daemonOrigin.replace(/\/+$/, '');
  const reasoning = input.reasoningEffort !== 'off';
  const modelsJson = input.protocol === 'anthropic'
    ? providerModelsJson({
        api: 'anthropic-messages',
        // The Anthropic SDK appends `/v1/messages` itself.
        baseUrl: `${origin}/api/tokentosea/agent`,
        modelId: input.modelId,
        name: input.modelName,
        reasoning,
        maxTokens: input.maxOutputTokens,
        ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
        // The proxy re-encodes the body for the official route; keep the wire
        // to fields every Claude endpoint accepts.
        compat: { supportsEagerToolInputStreaming: false, supportsStrictTools: false },
        apiKeyRequired: true,
      })
    : providerModelsJson({
        api: 'openai-completions',
        baseUrl: `${origin}/api/tokentosea/agent/v1`,
        modelId: input.modelId,
        name: input.modelName,
        reasoning,
        maxTokens: input.maxOutputTokens,
        ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
        authHeader: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
          ...(input.interleavedReasoning && reasoning
            ? { requiresReasoningContentOnAssistantMessages: true }
            : {}),
        },
        apiKeyRequired: true,
      });
  return {
    modelId: input.modelId,
    thinking: reasoning ? piThinkingLevel(input.reasoningEffort) : 'off',
    env: { [BUNDLED_PI_API_KEY_ENV]: input.token },
    modelsJson,
  };
}

const DEFAULT_BASE_URL_BY_PROTOCOL: Record<ByokChatProviderConfig['protocol'], string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  azure: '',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'https://ollama.com',
  senseaudio: 'https://api.senseaudio.cn',
  aihubmix: 'https://aihubmix.com/v1',
};

/** A user-supplied endpoint and key; `null` means the configuration is incomplete. */
export function buildByokPiProvider(
  provider: ByokChatProviderConfig | null | undefined,
  model: string | null | undefined,
): BundledPiProvider | null {
  if (!provider || typeof provider !== 'object') return null;
  const protocol = provider.protocol;
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_BASE_URL_BY_PROTOCOL, protocol)) return null;
  const rawModel = typeof model === 'string' ? model.trim() : '';
  if (!rawModel || rawModel.toLowerCase() === 'default') return null;
  const configuredBase = typeof provider.baseUrl === 'string' && provider.baseUrl.trim()
    ? provider.baseUrl.trim()
    : DEFAULT_BASE_URL_BY_PROTOCOL[protocol];
  const baseUrl = normalizeByokBaseUrl(protocol, configuredBase);
  if (!baseUrl) return null;
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  const needsApiKey = provider.requiresApiKey !== false
    && !(protocol === 'ollama' && isLoopbackUrl(baseUrl));
  if (needsApiKey && !apiKey) return null;
  const api: PiApi = protocol === 'anthropic'
    ? 'anthropic-messages'
    : protocol === 'google'
      ? 'google-generative-ai'
      : protocol === 'azure'
        ? 'azure-openai-responses'
        : protocol === 'openai' && isExactHost(baseUrl, 'api.openai.com')
          ? 'openai-responses'
          : 'openai-completions';
  const env: Record<string, string> = needsApiKey ? { [BUNDLED_PI_API_KEY_ENV]: apiKey } : {};
  const azure = protocol === 'azure' ? byokAzureResponsesEndpoint(baseUrl, provider.apiVersion) : null;
  if (protocol === 'azure' && !azure) return null;
  if (azure) {
    // pi resolves Azure endpoints from AZURE_OPENAI_* before models.json, so
    // pin the configured endpoint (inherited AZURE_* values are stripped in
    // env.ts).
    env.AZURE_OPENAI_BASE_URL = azure.baseUrl;
    env.AZURE_OPENAI_API_VERSION = azure.apiVersion;
  }
  // On the Responses API pi sends `store: false` and replays reasoning items;
  // a reasoning model only returns them replayable when pi asks for encrypted
  // reasoning, which it does for models declared as reasoning-capable.
  const declaredReasoning = typeof provider.reasoningModel === 'boolean' ? provider.reasoningModel : null;
  const responsesReasoning = (api === 'openai-responses' || api === 'azure-openai-responses')
    && (declaredReasoning ?? isResponsesReasoningModel(rawModel));
  return {
    modelId: rawModel,
    thinking: responsesReasoning ? responsesThinkingLevel(rawModel) : null,
    env,
    modelsJson: providerModelsJson({
      api,
      baseUrl: azure ? azure.baseUrl : baseUrl,
      modelId: rawModel,
      name: rawModel,
      reasoning: responsesReasoning,
      maxTokens: DEFAULT_OUTPUT_TOKENS,
      ...(api === 'openai-completions' ? { authHeader: true } : {}),
      apiKeyRequired: needsApiKey,
    }),
  };
}

/**
 * The endpoint the bundled pi calls for a BYOK Azure provider. pi 1.5.0's
 * `azure-openai-responses` client posts `<baseUrl>/responses?api-version=<v>`
 * with `api-key` auth and the deployment name as `model`; it gives a bare
 * Azure host (or `/openai`) the `/openai/v1` base path. That route takes
 * `v1`/`preview`, not the dated versions of the deployments route, and the
 * SDK appends paths to the base verbatim, so a copied query string is dropped.
 * The Settings connection test calls this same endpoint.
 */
export function byokAzureResponsesEndpoint(
  baseUrl: string,
  apiVersion: unknown,
): { baseUrl: string; apiVersion: string } | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  const pickVersion = (value: unknown): string | null => {
    const version = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return version === 'v1' || version === 'preview' ? version : null;
  };
  const version = pickVersion(apiVersion) ?? pickVersion(url.searchParams.get('api-version')) ?? 'v1';
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/responses$/, '');
  const host = url.hostname.toLowerCase();
  const azureHost = ['.openai.azure.com', '.cognitiveservices.azure.com', '.ai.azure.com'].some((suffix) => host.endsWith(suffix));
  if (azureHost && (pathname === '' || pathname === '/openai')) pathname = '/openai/v1';
  return { baseUrl: `${url.origin}${pathname}`, apiVersion: version };
}

/**
 * OpenAI reasoning families served over the Responses API: gpt-5 and later,
 * the o-series and codex. The `-chat` aliases (gpt-5-chat-latest) are not
 * reasoning models and reject reasoning parameters. For Azure this reads the
 * deployment name, which names the model only by convention.
 */
export function isResponsesReasoningModel(model: string): boolean {
  const id = responsesModelId(model);
  if (/-chat(?:-|$)/.test(id)) return false;
  return /^(?:gpt-(?:[5-9]|[1-9]\d)|o\d|codex)/.test(id);
}

/** gpt-5-pro accepts only reasoning effort `high`; the others take `medium`. */
function responsesThinkingLevel(model: string): 'medium' | 'high' {
  return /^gpt-5-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(responsesModelId(model)) ? 'high' : 'medium';
}

function responsesModelId(model: string): string {
  return model.trim().toLowerCase().split('/').at(-1) ?? '';
}

function normalizeByokBaseUrl(protocol: ByokChatProviderConfig['protocol'], value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (protocol === 'anthropic') {
    // pi's Anthropic client appends `/v1/messages`; accept either spelling.
    return trimmed.replace(/\/v1$/, '');
  }
  if (protocol === 'openai' && isExactOrigin(trimmed, 'https://api.openai.com')) return 'https://api.openai.com/v1';
  if (protocol === 'google' && isExactOrigin(trimmed, 'https://generativelanguage.googleapis.com')) {
    return 'https://generativelanguage.googleapis.com/v1beta';
  }
  if (protocol === 'ollama') {
    if (isExactOrigin(trimmed, 'https://ollama.com')) return 'https://ollama.com/v1';
    if (isLoopbackUrl(trimmed) && /^https?:\/\/[^/]+$/.test(trimmed)) return `${trimmed}/v1`;
    if (trimmed.endsWith('/api')) return `${trimmed.slice(0, -4)}/v1`;
  }
  return trimmed;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function isExactOrigin(value: string, origin: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === origin && (parsed.pathname === '' || parsed.pathname === '/');
  } catch {
    return value === origin;
  }
}

function isExactHost(value: string, host: string): boolean {
  try {
    return new URL(value).hostname === host;
  } catch {
    return false;
  }
}

/** pi names a server's tools `mcp__<server>__<tool>`; names allow `[A-Za-z0-9_-]` only. */
function piMcpServerName(id: string, taken: Set<string>): string {
  const base = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '') || 'server';
  let name = base;
  for (let suffix = 2; taken.has(name.replace(/-/g, '_').toLowerCase()); suffix += 1) name = `${base}_${suffix}`;
  taken.add(name.replace(/-/g, '_').toLowerCase());
  return name;
}

export interface PiMcpServerInput {
  id: string;
  enabled?: boolean;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** What the bundled pi receives for the run's external MCP servers. */
export interface PiMcpConfig {
  /** `mcp.json` content, or null when no server applies. */
  config: Record<string, unknown> | null;
  /**
   * Child-only variables holding every env/header value. `mcp.json` refers
   * to them as `${NAME}`, so secrets (OAuth bearer tokens, API keys) never
   * reach disk and pi never reinterprets a value: pi treats a leading `!` as
   * a shell command and `$NAME` as interpolation in literal values.
   */
  env: Record<string, string>;
  /** Server ids left out because pi cannot speak their transport (legacy SSE). */
  unsupported: string[];
}

export const PI_MCP_VALUE_ENV_PREFIX = 'FANTAY_PI_MCP_';

/**
 * The daemon's enabled external MCP servers in pi's `mcp.json` shape. Tools
 * are declared to the model directly, matching how other runtimes expose them,
 * instead of pi's default script-only `codemode` exposure. pi supports stdio
 * and streamable HTTP only; legacy SSE servers are reported as unsupported.
 */
export function buildPiMcpConfig(
  servers: PiMcpServerInput[],
  headersFor: (server: PiMcpServerInput) => Record<string, string> | undefined,
): PiMcpConfig {
  const taken = new Set<string>();
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const env: Record<string, string> = {};
  const unsupported: string[] = [];
  const reference = (value: string): string => {
    const name = `${PI_MCP_VALUE_ENV_PREFIX}${Object.keys(env).length + 1}`;
    env[name] = value;
    return `\${${name}}`;
  };
  const references = (values: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!values) return undefined;
    const entries = Object.entries(values).filter(([, value]) => typeof value === 'string');
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries.map(([key, value]) => [key, reference(value)]));
  };
  for (const server of servers) {
    if (!server || server.enabled === false) continue;
    if (server.transport === 'stdio') {
      const command = typeof server.command === 'string' ? server.command.trim() : '';
      if (!command) continue;
      const serverEnv = references(server.env);
      mcpServers[piMcpServerName(server.id, taken)] = {
        command,
        args: Array.isArray(server.args) ? [...server.args] : [],
        ...(serverEnv ? { env: serverEnv } : {}),
        exposure: 'direct',
      };
      continue;
    }
    if (server.transport === 'sse') {
      unsupported.push(server.id);
      continue;
    }
    const url = typeof server.url === 'string' ? server.url.trim() : '';
    if (!url) continue;
    const headers = references(headersFor(server));
    mcpServers[piMcpServerName(server.id, taken)] = {
      url,
      ...(headers ? { headers } : {}),
      exposure: 'direct',
    };
  }
  return {
    config: Object.keys(mcpServers).length > 0 ? { mcpServers } : null,
    env,
    unsupported,
  };
}

/**
 * Fantay's pi extension. `todowrite` is the plan tool the host renders
 * as the execution plan (same name and `{ todos }` shape the chat already
 * recognises); pi has no plan tool of its own.
 */
export const FANTAY_PI_EXTENSION_SOURCE = `// Generated by Fantay for one run. Do not edit.
const STATUS = ['pending', 'in_progress', 'completed', 'cancelled'];
export default function fantaydesign(pi) {
  const nativeSearchTools = [
    { name: 'web_search', label: 'Web search', path: 'search', description: 'Search the web using the search services configured in Fantay. Returns source links and evidence.',
      properties: { query: { type: 'string' }, provider: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
    { name: 'web_fetch', label: 'Read webpage', path: 'fetch', description: 'Read a webpage into Markdown using Fantay search services.',
      properties: { url: { type: 'string' }, provider: { type: 'string' } }, required: ['url'] },
    { name: 'smart_search', label: 'Search and research', path: 'execute', description: 'Run the complete Smart Search engine in Fantay. Use research for multi-round investigation, deep for planning, or a provider-specific command. Obtain commands and parameters from smart_search_catalog.',
      properties: { command: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' } } }, required: ['command'] },
    { name: 'smart_search_catalog', label: 'Search capabilities', path: 'catalog', description: 'List all Smart Search commands and their input parameters available inside Fantay.',
      properties: {}, required: [] },
  ];
  for (const tool of nativeSearchTools) {
    pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description,
      parameters: { type: 'object', properties: tool.properties, required: tool.required },
      async execute(_toolCallId, params, signal) {
        if (!process.env.OD_DAEMON_URL) throw new Error('Fantay daemon URL is unavailable.');
        const response = await fetch(new URL('/api/search/' + tool.path, process.env.OD_DAEMON_URL), {
          method: tool.path === 'catalog' ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', ...(process.env.OD_TOOL_TOKEN ? { authorization: 'Bearer ' + process.env.OD_TOOL_TOKEN } : {}) },
          ...(tool.path === 'catalog' ? {} : { body: JSON.stringify(params) }), signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || 'Search request failed.');
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { nativeTool: tool.name } };
      },
    });
  }
  pi.registerTool({
    name: 'todowrite',
    label: 'Plan',
    description: 'Replace the task plan shown to the user. Send the complete list every time; mark one item in_progress while you work on it and completed as soon as it is done.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete, ordered plan.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short imperative step.' },
              status: { type: 'string', enum: STATUS },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(_toolCallId, params) {
      const todos = Array.isArray(params?.todos) ? params.todos : [];
      const done = todos.filter((item) => item && item.status === 'completed').length;
      return { content: [{ type: 'text', text: 'Plan updated: ' + done + '/' + todos.length + ' completed.' }], details: {} };
    },
  });
}
`;

export const FANTAY_PI_EXTENSION_FILE = 'fantaydesign-tools.js';

// Wrap Pi's file tools under separate names so an extension load failure
// cannot expose the built-in write/edit tools.
const PI_WORKSPACE_GUARD = `
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

async function workspaceWritePath(cwd, file) {
  if (typeof file !== 'string' || !file || /^(?:@|~|file:)/u.test(file)) return null;
  const root = await realpath(cwd);
  const destination = path.resolve(root, file);
  if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u.test(destination)) return null;
  const relative = path.relative(root, destination);
  if (!relative || path.isAbsolute(relative) || relative === '..' ||
      relative.startsWith('..' + path.sep) || (process.platform === 'win32' && relative.includes(':'))) return null;
  let candidate = destination;
  let target = true;
  while (candidate !== root) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) return null;
      if (target ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
    candidate = path.dirname(candidate);
    target = false;
  }
  return destination;
}

export default function restrictedWorkspace(pi) {
  const cwd = process.cwd();
  for (const tool of [createEditToolDefinition(cwd), createWriteToolDefinition(cwd)]) {
    pi.registerTool({
      ...tool,
      name: 'fantay_workspace_' + tool.name,
      async execute(toolCallId, input, ...args) {
        const destination = await workspaceWritePath(cwd, input?.path);
        if (!destination) throw new Error('Writes are limited to regular files in this workspace.');
        return tool.execute(toolCallId, { ...input, path: destination }, ...args);
      },
    });
  }
}
`;

const PI_WORKSPACE_GUARD_FILE = 'fantaydesign-workspace-guard.js';

export interface BundledPiRunHome {
  agentDir: string;
  sessionDir: string;
  extensionPath: string;
  /** Child env that points pi at this run's directory. */
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

/** Directory names under the daemon data root; never derived from user input. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 96) || '_';
}

/** Run directories older than this are leftovers of a daemon that stopped mid-run. */
const STALE_RUN_HOME_MS = 12 * 60 * 60 * 1000;

async function sweepStaleRunHomes(runsRoot: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_RUN_HOME_MS;
  await Promise.all(entries.map(async (entry) => {
    const dir = path.join(runsRoot, entry);
    if (dir === keep) return;
    try {
      if ((await stat(dir)).mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    } catch {
      // A concurrent cleanup already removed it.
    }
  }));
}

export async function prepareBundledPiRunHome(input: {
  runtimeDataDir: string;
  agentId: string;
  accountKey: string;
  runId: string;
  provider: BundledPiProvider;
  mcp: PiMcpConfig | null;
  executionPermission?: ChatExecutionPermission | null;
}): Promise<BundledPiRunHome> {
  const accountRoot = path.join(
    input.runtimeDataDir,
    'agent-runtime',
    safeSegment(input.agentId),
    safeSegment(input.accountKey),
  );
  const sessionDir = path.join(accountRoot, 'sessions');
  const runRoot = path.join(accountRoot, 'runs', safeSegment(input.runId));
  const agentDir = path.join(runRoot, 'agent');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await rm(runRoot, { recursive: true, force: true });
  await sweepStaleRunHomes(path.dirname(runRoot), runRoot);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const write = (name: string, content: string) =>
    writeFile(path.join(agentDir, name), content, { encoding: 'utf8', mode: 0o600 });
  await write('models.json', `${JSON.stringify(input.provider.modelsJson, null, 2)}\n`);
  // Project folders are user content: never load extensions, skills or
  // settings from them, and never ask (RPC mode cannot answer a prompt).
  await write('settings.json', `${JSON.stringify({ defaultProjectTrust: 'never', quietStartup: true }, null, 2)}\n`);
  if (input.mcp?.config) await write('mcp.json', `${JSON.stringify(input.mcp.config, null, 2)}\n`);
  await write(FANTAY_PI_EXTENSION_FILE, FANTAY_PI_EXTENSION_SOURCE);
  if (input.executionPermission === 'workspace-write') await write(PI_WORKSPACE_GUARD_FILE, PI_WORKSPACE_GUARD);
  return {
    agentDir,
    sessionDir,
    extensionPath: path.join(agentDir, FANTAY_PI_EXTENSION_FILE),
    env: {
      ...(input.mcp?.env ?? {}),
      ...input.provider.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
    cleanup: () => rm(runRoot, { recursive: true, force: true }).catch(() => undefined),
  };
}

export type BundledPiRuntimeContext = NonNullable<RuntimeContext['bundledPi']>;

/** argv for a built-in agent run; the prompt itself goes through the RPC `prompt` command. */
export function buildBundledPiArgs(context: RuntimeContext = {}): string[] {
  const pi = context.bundledPi;
  if (!pi) throw new Error('The built-in pi runtime was started without its run configuration.');
  const permission = context.executionPermission;
  const restricted = permission === 'read-only' || permission === 'workspace-write';
  const args = [
    '--mode', 'rpc',
    // Only the built-in MCP support and Fantay's own extension load.
    '--no-extensions', ...(restricted ? ['--no-mcp'] : ['-e', 'builtin:mcp']), '-e', pi.extensionPath,
    '--no-skills', '--no-prompt-templates', '--no-themes',
    // The daemon composes instructions itself. Project folders can sit inside
    // a repository whose AGENTS.md/CLAUDE.md are not instructions for this run.
    '--no-context-files',
    '--no-approve',
    '--offline',
    '--session-dir', pi.sessionDir,
    '--provider', BUNDLED_PI_PROVIDER_ID,
    '--model', pi.modelId,
  ];
  if (restricted) {
    if (permission === 'workspace-write') {
      args.push('-e', path.join(pi.agentDir, PI_WORKSPACE_GUARD_FILE));
      args.push('--tools', 'read,grep,find,ls,todowrite,fantay_workspace_edit,fantay_workspace_write');
    } else {
      args.push('--tools', 'read,grep,find,ls,todowrite');
    }
  }
  if (pi.thinking) args.push('--thinking', pi.thinking);
  return args;
}

export type BundledPiAgentDefInit = Pick<
  RuntimeAgentDef,
  'id' | 'name' | 'fallbackModels' | 'supportsCustomModel'
> &
  Partial<Pick<RuntimeAgentDef, 'fetchModels'>>;

/**
 * Shared runtime definition factory for built-in bundled-pi agents
 * (`TokenToSea` and `BYOK`), keeping argv generation, RPC streaming,
 * MCP injection, execution-permission guards, and watchdog timeouts identical.
 */
export function createBundledPiAgentDef(init: BundledPiAgentDefInit): RuntimeAgentDef {
  return {
    ...init,
    bin: 'pi',
    versionArgs: ['--version'],
    versionProbeTimeoutMs: 15_000,
    buildArgs: (_prompt, _images, _extra, _options = {}, context = {}) =>
      buildBundledPiArgs(context),
    promptViaStdin: true,
    streamFormat: 'pi-rpc',
    supportsImagePaths: true,
    externalMcpInjection: 'pi-mcp-json',
    inactivityTimeoutMs: BUNDLED_PI_INACTIVITY_TIMEOUT_MS,
    firstOutputTimeoutMs: BUNDLED_PI_FIRST_OUTPUT_TIMEOUT_MS,
  };
}
