import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_PI_AGENT_IDS,
  isBundledPiAgentId,
  resolveEffectiveChatRuntimeAgentId,
  supportsConfigExecutionPermission,
} from '@open-design/contracts';
import {
  BUNDLED_PI_API_KEY_ENV,
  BUNDLED_PI_FIRST_OUTPUT_TIMEOUT_MS,
  BUNDLED_PI_INACTIVITY_TIMEOUT_MS,
  BUNDLED_PI_PROVIDER_ID,
  buildBundledPiArgs,
  buildByokPiProvider,
  buildTokenToSeaPiProvider,
  byokAzureResponsesEndpoint,
  FANTAY_PI_EXTENSION_FILE,
  piThinkingLevel,
  prepareBundledPiRunHome,
} from '../../src/runtimes/bundled-pi.js';
import { buildPiMcpConfig } from '../../src/mcp-config.js';
import { spawnEnvForAgent } from '../../src/runtimes/env.js';
import { inspectAgentExecutableResolution, resolveBundledPiExecutable } from '../../src/runtimes/executables.js';
import { tokenToSeaAgentDef } from '../../src/runtimes/defs/tokentosea.js';
import { byokAgentDef } from '../../src/runtimes/defs/byok.js';

type ProviderJson = {
  baseUrl: string;
  api: string;
  apiKey: string;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models: Array<{ id: string; reasoning: boolean; maxTokens: number; contextWindow: number; input: string[] }>;
};
const providerOf = (json: Record<string, unknown> | undefined): ProviderJson =>
  (json as { providers: Record<string, ProviderJson> }).providers[BUNDLED_PI_PROVIDER_ID]!;

const temps: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TokenToSea through the bundled pi', () => {
  it('points pi at the lease proxy without writing the lease into models.json', () => {
    const token = 't'.repeat(43);
    const out = buildTokenToSeaPiProvider({
      daemonOrigin: 'http://127.0.0.1:7456/',
      token,
      protocol: 'openai',
      modelId: 'lingzhigongfang/cn-stable/deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      reasoningEffort: 'high',
      maxOutputTokens: 32_768,
      interleavedReasoning: true,
    });
    const provider = providerOf(out.modelsJson);
    expect(provider).toMatchObject({
      baseUrl: 'http://127.0.0.1:7456/api/tokentosea/agent/v1',
      api: 'openai-completions',
      apiKey: `$${BUNDLED_PI_API_KEY_ENV}`,
      authHeader: true,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
      },
    });
    expect(provider.models[0]).toMatchObject({
      id: 'lingzhigongfang/cn-stable/deepseek-v4-flash',
      reasoning: true,
      maxTokens: 32_768,
      input: ['text', 'image'],
    });
    expect(JSON.stringify(out.modelsJson)).not.toContain(token);
    expect(out.env).toEqual({ [BUNDLED_PI_API_KEY_ENV]: token });
    expect(out.thinking).toBe('high');
  });

  it('uses the Messages route for Claude and leaves reasoning to the proxy when it is off', () => {
    const out = buildTokenToSeaPiProvider({
      daemonOrigin: 'http://127.0.0.1:7456',
      token: 'k'.repeat(43),
      protocol: 'anthropic',
      modelId: 'tokentide/aws/claude-sonnet-5-5',
      modelName: 'Claude Sonnet 5.5',
      reasoningEffort: 'off',
      maxOutputTokens: 4096,
      interleavedReasoning: false,
    });
    const provider = providerOf(out.modelsJson);
    // The Anthropic client appends `/v1/messages` itself.
    expect(provider.baseUrl).toBe('http://127.0.0.1:7456/api/tokentosea/agent');
    expect(provider.api).toBe('anthropic-messages');
    expect(provider.models[0]!.reasoning).toBe(false);
    expect(out.thinking).toBe('off');
  });

  it.each([
    ['off', 'off'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
    ['xhigh', 'xhigh'], ['max', 'max'], ['on', 'medium'], ['default', 'medium'],
    ['between_tools_high', 'high'], ['unknown', null],
  ])('maps the TokenToSea effort %s to pi thinking %s', (effort, level) => {
    expect(piThinkingLevel(effort)).toBe(level);
  });
});

describe('BYOK through the bundled pi', () => {
  it('routes native OpenAI to Responses and other OpenAI-protocol hosts to Chat Completions', () => {
    const native = buildByokPiProvider({ protocol: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com' }, 'gpt-5.6');
    expect(providerOf(native?.modelsJson)).toMatchObject({ api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
    const compatible = buildByokPiProvider({ protocol: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1/' }, 'deepseek-chat');
    expect(providerOf(compatible?.modelsJson)).toMatchObject({ api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', authHeader: true });
    expect(compatible?.modelId).toBe('deepseek-chat');
    expect(compatible?.env).toEqual({ [BUNDLED_PI_API_KEY_ENV]: 'sk-test' });
    expect(JSON.stringify(compatible?.modelsJson)).not.toContain('sk-test');
  });

  it('asks for replayable reasoning only from Responses reasoning models', () => {
    // pi sends `store: false` on Responses; a reasoning model's items are only
    // replayable when pi requests encrypted reasoning, which needs a level.
    for (const model of ['gpt-5.6-sol', 'gpt-5', 'gpt-6.1-terra', 'gpt-6-astra', 'o4-mini', 'codex-mini-latest', 'openai/gpt-5.5', 'gpt-5.5-pro']) {
      const out = buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://api.openai.com/v1' }, model);
      expect(out?.thinking, model).toBe('medium');
      expect(providerOf(out?.modelsJson).models[0]!.reasoning, model).toBe(true);
    }
    // gpt-5-pro accepts only `high`.
    for (const model of ['gpt-5-pro', 'gpt-5-pro-2025-10-06']) {
      expect(buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://api.openai.com/v1' }, model)?.thinking, model).toBe('high');
    }
    // Non-reasoning models, including the gpt-5 chat aliases, get no reasoning parameters.
    for (const model of ['gpt-4.1', 'gpt-4o-2024-05-13', 'gpt-5-chat-latest', 'gpt-5-chat']) {
      const out = buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://api.openai.com/v1' }, model);
      expect(out?.thinking, model).toBeNull();
      expect(providerOf(out?.modelsJson).models[0]!.reasoning, model).toBe(false);
    }
    expect(buildByokPiProvider({ protocol: 'azure', apiKey: 'az', baseUrl: 'https://res.openai.azure.com' }, 'gpt-5-chat')?.thinking).toBeNull();
  });

  it('lets an explicit reasoning flag override the Azure deployment name', () => {
    // Deployment names only follow the model name by convention.
    const declared = buildByokPiProvider({ protocol: 'azure', apiKey: 'az', baseUrl: 'https://res.openai.azure.com', reasoningModel: true }, 'prod-chat');
    expect(declared?.thinking).toBe('medium');
    expect(providerOf(declared?.modelsJson).models[0]!.reasoning).toBe(true);
    expect(declared?.modelId).toBe('prod-chat');
    const denied = buildByokPiProvider({ protocol: 'azure', apiKey: 'az', baseUrl: 'https://res.openai.azure.com', reasoningModel: false }, 'gpt-5.5');
    expect(denied?.thinking).toBeNull();
    expect(providerOf(denied?.modelsJson).models[0]!.reasoning).toBe(false);
    // Chat Completions hosts have no Responses reasoning replay to configure.
    expect(buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://gateway.example/v1', reasoningModel: true }, 'm')?.thinking).toBeNull();
    // Chat Completions hosts keep their own reasoning handling.
    const compatible = buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://gateway.example/v1' }, 'gpt-5.6');
    expect(compatible?.thinking).toBeNull();
  });

  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com'],
    ['https://api.minimax.io/anthropic', 'https://api.minimax.io/anthropic'],
    ['https://api.deepseek.com/anthropic/v1/', 'https://api.deepseek.com/anthropic'],
  ])('gives the Anthropic client a base URL without the version segment (%s)', (baseUrl, expected) => {
    const out = buildByokPiProvider({ protocol: 'anthropic', apiKey: 'sk-ant', baseUrl }, 'claude-sonnet-5-5');
    expect(providerOf(out?.modelsJson)).toMatchObject({ api: 'anthropic-messages', baseUrl: expected });
  });

  it('normalizes Google and Ollama endpoints', () => {
    expect(providerOf(buildByokPiProvider({ protocol: 'google', apiKey: 'AIza', baseUrl: 'https://generativelanguage.googleapis.com/' }, 'gemini-3.8-flash')?.modelsJson))
      .toMatchObject({ api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
    expect(providerOf(buildByokPiProvider({ protocol: 'ollama', apiKey: 'k', baseUrl: 'https://ollama.com' }, 'gpt-oss:20b')?.modelsJson).baseUrl)
      .toBe('https://ollama.com/v1');
    expect(providerOf(buildByokPiProvider({ protocol: 'ollama', apiKey: 'k', baseUrl: 'https://ollama.example.com/api' }, 'llama3.1')?.modelsJson).baseUrl)
      .toBe('https://ollama.example.com/v1');
  });

  it.each([
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1'],
    ['http://[::1]:11434/api', 'http://[::1]:11434/v1'],
    ['http://[::1]:11434/v1', 'http://[::1]:11434/v1'],
  ])('allows keyless local Ollama at %s', (baseUrl, expected) => {
    const out = buildByokPiProvider({ protocol: 'ollama', apiKey: '', baseUrl }, 'llama3.2');
    expect(out?.env).toEqual({});
    expect(providerOf(out?.modelsJson)).toMatchObject({ baseUrl: expected, apiKey: 'local' });
  });

  it('requires a key for remote endpoints unless the preset says otherwise', () => {
    expect(buildByokPiProvider({ protocol: 'ollama', apiKey: '', baseUrl: 'https://ollama.com' }, 'gpt-oss:20b')).toBeNull();
    const vllm = buildByokPiProvider({ protocol: 'openai', apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', requiresApiKey: false }, 'model');
    expect(vllm?.env).toEqual({});
    expect(providerOf(vllm?.modelsJson).apiKey).toBe('local');
  });

  it('rejects incomplete configurations', () => {
    expect(buildByokPiProvider(null, 'model')).toBeNull();
    expect(buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://x.example/v1' }, 'default')).toBeNull();
    expect(buildByokPiProvider({ protocol: 'azure', apiKey: 'sk', baseUrl: '' }, 'gpt')).toBeNull();
  });

  it('pins the Azure /openai/v1 endpoint and its api-version in the child env', () => {
    const out = buildByokPiProvider({ protocol: 'azure', apiKey: 'az', baseUrl: 'https://res.openai.azure.com', apiVersion: '2025-04-01-preview' }, 'deploy');
    expect(providerOf(out?.modelsJson)).toMatchObject({ api: 'azure-openai-responses', baseUrl: 'https://res.openai.azure.com/openai/v1' });
    // The /openai/v1 route rejects the dated versions of the deployments route.
    expect(out?.env).toEqual({
      AZURE_OPENAI_BASE_URL: 'https://res.openai.azure.com/openai/v1',
      AZURE_OPENAI_API_VERSION: 'v1',
      [BUNDLED_PI_API_KEY_ENV]: 'az',
    });
    expect(buildByokPiProvider({ protocol: 'azure', apiKey: 'az', baseUrl: 'https://res.openai.azure.com', apiVersion: 'preview' }, 'gpt-5.6')?.env)
      .toMatchObject({ AZURE_OPENAI_API_VERSION: 'preview' });
    expect(buildByokPiProvider({ protocol: 'azure', apiKey: 'az', baseUrl: 'not a url' }, 'deploy')).toBeNull();
  });

  it.each([
    ['https://res.openai.azure.com', undefined, 'https://res.openai.azure.com/openai/v1', 'v1'],
    ['https://res.cognitiveservices.azure.com/openai/', '', 'https://res.cognitiveservices.azure.com/openai/v1', 'v1'],
    ['https://res.openai.azure.com/openai/v1/responses', 'PREVIEW', 'https://res.openai.azure.com/openai/v1', 'preview'],
    ['https://r.services.ai.azure.com/api/projects/p/openai/v1?api-version=2024-10-21', '', 'https://r.services.ai.azure.com/api/projects/p/openai/v1', 'v1'],
    ['https://r.services.ai.azure.com/api/projects/p/openai/v1?api-version=preview', '', 'https://r.services.ai.azure.com/api/projects/p/openai/v1', 'preview'],
    ['https://azure-gateway.example/openai/v1', 'v1', 'https://azure-gateway.example/openai/v1', 'v1'],
  ])('resolves the Azure Responses endpoint for %s (api-version %s)', (baseUrl, apiVersion, expectedBase, expectedVersion) => {
    expect(byokAzureResponsesEndpoint(baseUrl, apiVersion)).toEqual({ baseUrl: expectedBase, apiVersion: expectedVersion });
  });

  it('keeps inherited Azure and pi session variables away from the bundled pi', () => {
    const env = spawnEnvForAgent('byok', {
      PATH: '/usr/bin',
      AZURE_OPENAI_BASE_URL: 'https://other.openai.azure.com',
      AZURE_OPENAI_RESOURCE_NAME: 'other',
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'deploy=other',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
      AZURE_OPENAI_API_KEY: 'inherited',
      PI_SESSION_FILE: '/elsewhere.jsonl',
    }, {}, {});
    for (const key of ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_API_KEY', 'PI_SESSION_FILE']) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env).toMatchObject({ PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
  });
});

describe('pi MCP config', () => {
  it('declares enabled servers directly and keeps every env/header value off disk', () => {
    const mcp = buildPiMcpConfig([
      { id: 'files', label: 'Files', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { A: '1', B: '!echo not-a-command' } },
      { id: 'docs.remote', label: 'Docs', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp', authMode: 'oauth' },
      { id: 'legacy', label: 'Legacy', enabled: true, transport: 'sse', url: 'https://mcp.example.com/sse' },
      { id: 'off', label: 'Off', enabled: false, transport: 'stdio', command: 'nope' },
    ] as never, { 'docs.remote': 'bearer-token' });
    // pi resolves `${NAME}` from the child env and would run a literal
    // leading `!` as a shell command, so values travel only as references.
    expect(mcp.config).toEqual({
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'server'], env: { A: '${FANTAY_PI_MCP_1}', B: '${FANTAY_PI_MCP_2}' }, exposure: 'direct' },
        docs_remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: '${FANTAY_PI_MCP_3}' }, exposure: 'direct' },
      },
    });
    expect(mcp.env).toEqual({
      FANTAY_PI_MCP_1: '1',
      FANTAY_PI_MCP_2: '!echo not-a-command',
      FANTAY_PI_MCP_3: 'Bearer bearer-token',
    });
    expect(JSON.stringify(mcp.config)).not.toContain('bearer-token');
    // pi's MCP client has no SSE transport; the caller reports these.
    expect(mcp.unsupported).toEqual(['legacy']);
    expect(buildPiMcpConfig([], {})).toEqual({ config: null, env: {}, unsupported: [] });
  });
});

describe('run home and argv', () => {
  it('writes a run-scoped agent directory, keeps sessions per account, and cleans up', async () => {
    const dataDir = tempDir('od-pi-home-');
    const provider = buildTokenToSeaPiProvider({
      daemonOrigin: 'http://127.0.0.1:1', token: 'z'.repeat(43), protocol: 'openai', modelId: 'm', modelName: 'M',
      reasoningEffort: 'low', maxOutputTokens: 4096, interleavedReasoning: false,
    });
    const home = await prepareBundledPiRunHome({
      runtimeDataDir: dataDir, agentId: 'tokentosea', accountKey: 'acct', runId: 'run-1', provider,
      mcp: {
        config: { mcpServers: { a: { command: 'x', args: [], env: { K: '${FANTAY_PI_MCP_1}' }, exposure: 'direct' } } },
        env: { FANTAY_PI_MCP_1: 'mcp-secret' },
        unsupported: [],
      },
    });
    expect(home.sessionDir).toBe(path.join(dataDir, 'agent-runtime', 'tokentosea', 'acct', 'sessions'));
    expect(home.agentDir).toBe(path.join(dataDir, 'agent-runtime', 'tokentosea', 'acct', 'runs', 'run-1', 'agent'));
    expect(JSON.parse(readFileSync(path.join(home.agentDir, 'settings.json'), 'utf8'))).toMatchObject({ defaultProjectTrust: 'never' });
    expect(readFileSync(path.join(home.agentDir, 'mcp.json'), 'utf8')).not.toContain('mcp-secret');
    expect(readFileSync(home.extensionPath, 'utf8')).toContain("name: 'todowrite'");
    expect(path.basename(home.extensionPath)).toBe(FANTAY_PI_EXTENSION_FILE);
    expect(readFileSync(path.join(home.agentDir, 'models.json'), 'utf8')).not.toContain('z'.repeat(43));
    expect(home.env).toMatchObject({
      PI_CODING_AGENT_DIR: home.agentDir,
      PI_CODING_AGENT_SESSION_DIR: home.sessionDir,
      PI_OFFLINE: '1',
      FANTAY_PI_MCP_1: 'mcp-secret',
      [BUNDLED_PI_API_KEY_ENV]: 'z'.repeat(43),
    });
    await home.cleanup();
    expect(existsSync(home.agentDir)).toBe(false);
    expect(existsSync(home.sessionDir)).toBe(true);
  });

  it('sweeps run homes a crashed daemon left behind, but not recent ones', async () => {
    const dataDir = tempDir('od-pi-sweep-');
    const runs = path.join(dataDir, 'agent-runtime', 'byok', 'acct', 'runs');
    const stale = path.join(runs, 'crashed-run');
    const recent = path.join(runs, 'other-live-run');
    mkdirSync(path.join(stale, 'agent'), { recursive: true });
    mkdirSync(path.join(recent, 'agent'), { recursive: true });
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const provider = buildByokPiProvider({ protocol: 'openai', apiKey: 'sk', baseUrl: 'https://gateway.example/v1' }, 'm')!;
    const home = await prepareBundledPiRunHome({
      runtimeDataDir: dataDir, agentId: 'byok', accountKey: 'acct', runId: 'run-2', provider, mcp: null,
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(path.join(home.agentDir, 'mcp.json'))).toBe(false);
    await home.cleanup();
  });

  it('builds RPC argv that loads only MCP and the Fantay extension', () => {
    const args = buildBundledPiArgs({
      bundledPi: { agentDir: '/a', sessionDir: '/s', extensionPath: '/a/ext.js', modelId: 'org/model:x', thinking: 'high' },
    });
    expect(args).toEqual([
      '--mode', 'rpc', '--no-extensions', '-e', 'builtin:mcp', '-e', '/a/ext.js',
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline',
      '--session-dir', '/s', '--provider', 'fantay', '--model', 'org/model:x', '--thinking', 'high',
    ]);
    expect(() => buildBundledPiArgs({})).toThrow(/run configuration/);
    expect(tokenToSeaAgentDef.buildArgs('', [], [], {}, { bundledPi: { agentDir: '/a', sessionDir: '/s', extensionPath: '/e', modelId: 'm', thinking: null } }))
      .not.toContain('--thinking');
  });

  it('runs both built-in agents on the shared homologous bundled-pi runtime definition', () => {
    expect(BUNDLED_PI_AGENT_IDS).toEqual(['tokentosea', 'amr', 'byok', 'byok-opencode']);
    for (const id of BUNDLED_PI_AGENT_IDS) {
      expect(isBundledPiAgentId(id)).toBe(true);
    }
    expect(resolveEffectiveChatRuntimeAgentId({ mode: 'daemon', agentId: 'tokentosea' })).toBe('tokentosea');
    expect(resolveEffectiveChatRuntimeAgentId({ mode: 'daemon', agentId: 'amr' })).toBe('tokentosea');
    expect(resolveEffectiveChatRuntimeAgentId({ mode: 'daemon', agentId: 'byok-opencode' })).toBe('byok');
    expect(resolveEffectiveChatRuntimeAgentId({ mode: 'api', apiProtocol: 'openai' })).toBe('byok');
    expect(resolveEffectiveChatRuntimeAgentId({ mode: 'api', apiProtocol: 'bedrock' })).toBeNull();
    expect(supportsConfigExecutionPermission({ mode: 'api', apiProtocol: 'anthropic' })).toBe(true);
    expect(supportsConfigExecutionPermission({ mode: 'api', apiProtocol: 'bedrock' })).toBe(false);

    for (const def of [tokenToSeaAgentDef, byokAgentDef]) {
      expect(def).toMatchObject({
        bin: 'pi',
        streamFormat: 'pi-rpc',
        externalMcpInjection: 'pi-mcp-json',
        promptViaStdin: true,
        supportsImagePaths: true,
        versionProbeTimeoutMs: 15_000,
        inactivityTimeoutMs: BUNDLED_PI_INACTIVITY_TIMEOUT_MS,
        firstOutputTimeoutMs: BUNDLED_PI_FIRST_OUTPUT_TIMEOUT_MS,
      });
    }
    expect(byokAgentDef.name).toBe('BYOK');

    const bundledPi = {
      agentDir: '/a',
      sessionDir: '/s',
      extensionPath: '/a/ext.js',
      modelId: 'org/model',
      thinking: 'medium' as const,
    };
    for (const executionPermission of [null, 'read-only', 'workspace-write', 'danger-full-access'] as const) {
      expect(
        byokAgentDef.buildArgs('', [], [], {}, { bundledPi, executionPermission }),
      ).toEqual(
        tokenToSeaAgentDef.buildArgs('', [], [], {}, { bundledPi, executionPermission }),
      );
    }
  });
});

describe('bundled pi executable', () => {
  const writeExe = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\necho 1.5.0\n');
    chmodSync(file, 0o755);
    return file;
  };

  it('prefers FANTAY_PI_BIN, then the packaged copy, and never a PATH pi', () => {
    const root = tempDir('od-pi-exe-');
    const packaged = writeExe(path.join(root, 'resources', 'bin', 'libexec', 'pi', 'pi'));
    const explicit = writeExe(path.join(root, 'explicit', 'pi'));
    writeExe(path.join(root, 'path-bin', 'pi'));
    expect(resolveBundledPiExecutable({ OD_RESOURCE_ROOT: path.join(root, 'resources') })).toBe(packaged);
    expect(resolveBundledPiExecutable({ OD_RESOURCE_ROOT: path.join(root, 'resources'), FANTAY_PI_BIN: explicit })).toBe(explicit);
    const previousPath = process.env.PATH;
    const previousRoot = process.env.OD_RESOURCE_ROOT;
    const previousBin = process.env.FANTAY_PI_BIN;
    try {
      process.env.PATH = path.join(root, 'path-bin');
      delete process.env.OD_RESOURCE_ROOT;
      delete process.env.FANTAY_PI_BIN;
      expect(inspectAgentExecutableResolution(tokenToSeaAgentDef).selectedPath).toBeNull();
      expect(inspectAgentExecutableResolution(tokenToSeaAgentDef, { FANTAY_PI_BIN: explicit }).selectedPath).toBe(explicit);
    } finally {
      process.env.PATH = previousPath;
      if (previousRoot === undefined) delete process.env.OD_RESOURCE_ROOT; else process.env.OD_RESOURCE_ROOT = previousRoot;
      if (previousBin === undefined) delete process.env.FANTAY_PI_BIN; else process.env.FANTAY_PI_BIN = previousBin;
    }
  });
});

describe('legacy BYOK id', () => {
  it('resolves the OpenCode-era id to the pi-based BYOK agent', async () => {
    const { getAgentDef } = await import('../../src/runtimes/registry.js');
    expect(getAgentDef('byok')?.id).toBe('byok');
    expect(getAgentDef('byok-opencode')?.id).toBe('byok');
    expect(getAgentDef('byok-opencode')?.streamFormat).toBe('pi-rpc');
  });

  it('reads saved settings that still use the legacy id under the new one', async () => {
    const { readAppConfig } = await import('../../src/app-config.js');
    const dataDir = tempDir('od-byok-legacy-config-');
    writeFileSync(path.join(dataDir, 'app-config.json'), JSON.stringify({
      agentId: 'byok-opencode',
      agentModels: { 'byok-opencode': { model: 'gpt-5.6', reasoning: 'default' } },
    }));
    const config = await readAppConfig(dataDir);
    expect(config.agentId).toBe('byok');
    expect(config.agentModels).toEqual({ byok: { model: 'gpt-5.6', reasoning: 'default' } });
  });

  it('moves a saved retired AMR selection to TokenToSea', async () => {
    const { readAppConfig } = await import('../../src/app-config.js');
    const dataDir = tempDir('od-amr-legacy-config-');
    writeFileSync(path.join(dataDir, 'app-config.json'), JSON.stringify({
      agentId: 'amr',
      agentModels: { amr: { model: 'deepseek-v4-flash', reasoning: 'default' } },
    }));
    const config = await readAppConfig(dataDir);
    expect(config.agentId).toBe('tokentosea');
    expect(config.agentModels).toEqual({ tokentosea: { model: 'deepseek-v4-flash', reasoning: 'default' } });
  });
});
