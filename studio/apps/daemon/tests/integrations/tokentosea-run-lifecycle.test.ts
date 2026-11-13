import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../../src/server.js';
import { TokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';

let started: { url: string; server: Server; shutdown: () => Promise<void> } | undefined;
let folder: string | undefined;

afterEach(async () => {
  await started?.shutdown();
  if (started?.server.listening) await new Promise<void>(resolve => started!.server.close(() => resolve()));
  started = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

it('starts TokenToSea through the bundled pi on the bound daemon port and revokes its lease when the run ends', async () => {
  vi.stubEnv('OD_NEXT_STRATEGY_ROLLOUT', 'off');
  vi.stubEnv('OD_PORT', '1');
  folder = await mkdtemp(path.join(tmpdir(), 'fantay-tts-lifecycle-'));
  const marker = path.join(folder, 'launched');
  const binary = path.join(folder, 'pi-fixture');
  await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.5.0'); process.exit(0); }
const fs = require('node:fs'), path = require('node:path');
const agentDir = process.env.PI_CODING_AGENT_DIR;
const modelsText = fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8');
const provider = JSON.parse(modelsText).providers.fantay;
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  agentDir,
  baseUrl: provider.baseUrl,
  api: provider.api,
  apiKey: provider.apiKey,
  maxTokens: provider.models[0].maxTokens,
  modelsJsonHoldsToken: modelsText.includes(process.env.FANTAY_PI_API_KEY),
  leaseInEnv: process.env.FANTAY_PI_API_KEY,
  mode: arg('--mode'),
  provider: arg('--provider'),
  model: arg('--model'),
  sessionDirIsSibling: path.dirname(arg('--session-dir')) === path.dirname(path.dirname(path.dirname(agentDir))),
  extensionLoaded: fs.existsSync(path.join(agentDir, 'fantaydesign-tools.js')) && process.argv.includes(path.join(agentDir, 'fantaydesign-tools.js')),
  noContextFiles: process.argv.includes('--no-context-files'),
}));
process.stderr.write('Intentional lifecycle fixture failure');
process.exit(1);
`);
  await chmod(binary, 0o755);
  vi.stubEnv('FANTAY_PI_BIN', binary);
  const release = vi.fn();
  const authorize = vi.spyOn(TokenToSeaRuntime.prototype, 'createInferenceLease').mockResolvedValue({
    token: 'l'.repeat(43), userKey: 'lifecycle-user', release, reasoningEffort: 'off',
    model: { id: 'lifecycle-model', model: 'lifecycle-model', priceVersion: 'test', billingMode: 'token', toolCalling: true, maxOutputTokens: 32768 },
  });
  started = await startServer({ port: 0, returnServer: true }) as typeof started;
  const base = started!.url;
  const config = await fetch(`${base}/api/app-config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentCliEnv: { tokentosea: { FANTAY_PI_BIN: binary } } }),
  });
  expect(config.status).toBe(200);
  const projectId = randomUUID();
  const project = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: 'TokenToSea lifecycle', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
  });
  expect(project.status).toBe(200);
  const { conversationId } = await project.json() as { conversationId: string };
  const assistantMessageId = randomUUID();
  const response = await fetch(`${base}/api/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, conversationId, assistantMessageId, agentId: 'tokentosea', model: 'lifecycle-model', sessionMode: 'chat', message: 'Say hello', currentPrompt: 'Say hello' }),
  });
  expect(response.status, response.status === 202 ? undefined : await response.text()).toBe(202);
  const { runId } = await response.json() as { runId: string };
  await expect.poll(async () => {
    const run = await (await fetch(`${base}/api/runs/${runId}`)).json() as { status: string };
    return run.status;
  }, { timeout: 10_000 }).toBe('failed');
  expect(authorize).toHaveBeenCalledWith('lifecycle-model', expect.objectContaining({ projectId, conversationId, localRunId: runId }), undefined);
  const messages = await (await fetch(`${base}/api/projects/${projectId}/conversations/${conversationId}/messages`)).json() as { messages: Array<{ id: string; events?: Array<{ kind: string; label?: string }> }> };
  const errors = messages.messages?.find(message => message.id === assistantMessageId)?.events?.filter(event => event.kind === 'status' && event.label === 'error');
  const launched = await readFile(marker, 'utf8').catch(() => null);
  expect(launched, `the authorized run must reach the configured CLI: ${JSON.stringify(errors)}`).not.toBeNull();
  const seen = JSON.parse(launched!);
  expect(seen).toMatchObject({
    baseUrl: `${base}/api/tokentosea/agent/v1`,
    api: 'openai-completions',
    apiKey: '$FANTAY_PI_API_KEY',
    maxTokens: 4096,
    modelsJsonHoldsToken: false,
    leaseInEnv: 'l'.repeat(43),
    mode: 'rpc',
    provider: 'fantay',
    model: 'lifecycle-model',
    sessionDirIsSibling: true,
    extensionLoaded: true,
    noContextFiles: true,
  });
  expect(release).toHaveBeenCalledTimes(1);
  // The run-scoped agent directory (models.json, extension) is removed once the run ends.
  await expect.poll(async () => (await readFile(path.join(seen.agentDir, 'models.json'), 'utf8').then(() => true, () => false)), { timeout: 5_000 }).toBe(false);
});
