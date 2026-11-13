/**
 * TokenToSea through the pi FantayDesign ships, end to end on one machine:
 * the real pinned pi binary, the daemon's run home / argv builders, its
 * lease-guarded inference proxy and its pi RPC adapter. Upstream TokenToSea
 * is a local fake, so nothing is billed.
 */
import { expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { TokenToSeaRuntime, tokenToSeaAgentOutputLimit, tokenToSeaInterleavedReasoning } from '../../apps/daemon/src/integrations/tokentosea-runtime.js';
import { tokenToSeaNativeProtocol } from '../../apps/daemon/src/integrations/tokentosea-claude.js';
import { buildBundledPiArgs, buildTokenToSeaPiProvider, prepareBundledPiRunHome } from '../../apps/daemon/src/runtimes/bundled-pi.js';
import { attachPiRpcSession } from '../../apps/daemon/src/agent-protocol/index.js';
import { resolveStandalonePi } from '../../tools/pack/src/resources/pi.js';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Lease = Awaited<ReturnType<TokenToSeaRuntime['createInferenceLease']>>;
type AgentEvent = Record<string, unknown> & { type?: string };

async function pinnedPi(): Promise<string> {
  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const binary = await resolveStandalonePi({ platform, workspaceRoot, requireBundled: true });
  return binary!;
}

function proxyServer(runtime: TokenToSeaRuntime, protocol: 'openai' | 'anthropic', seen: Array<{ path: string; auth: string }> = []) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ path: req.url ?? '', auth: String(req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '') ?? '') });
    const request = Object.assign(req, { body: JSON.parse(Buffer.concat(chunks).toString()) });
    const response = Object.assign(res, {
      status(code: number) { res.statusCode = code; return response; },
      json(value: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return response; },
    });
    await runtime.inference(request as never, response as never, protocol);
  }).listen(0, '127.0.0.1');
}

function leaseFor(runtime: TokenToSeaRuntime, raw: string, modelId: string, reasoning: string): Promise<Lease> {
  return new Promise((resolve, reject) => {
    runtime.middleware({ headers: { cookie: `fantay_session=${raw}` }, originalUrl: '/api/test' } as never, {} as never, () => {
      void runtime.createInferenceLease(modelId, {}, reasoning).then(resolve, reject);
    });
  });
}

/** Spawn the pinned pi exactly as the daemon does and drive it through the daemon's RPC adapter. */
async function runPinnedPi(input: { folder: string; port: number; lease: Lease; prompt: string; onEvent: (event: AgentEvent) => void }) {
  const provider = buildTokenToSeaPiProvider({
    daemonOrigin: `http://127.0.0.1:${input.port}`,
    token: input.lease.token,
    protocol: tokenToSeaNativeProtocol(input.lease.model),
    modelId: input.lease.model.id,
    modelName: input.lease.model.name ?? input.lease.model.model,
    reasoningEffort: input.lease.reasoningEffort,
    maxOutputTokens: tokenToSeaAgentOutputLimit(input.lease.model, input.lease.reasoningEffort),
    interleavedReasoning: tokenToSeaInterleavedReasoning(input.lease.model),
  });
  const home = await prepareBundledPiRunHome({
    runtimeDataDir: input.folder, agentId: 'tokentosea', accountKey: 'e2e', runId: randomUUID(), provider, mcp: null,
  });
  const args = buildBundledPiArgs({
    bundledPi: { agentDir: home.agentDir, sessionDir: home.sessionDir, extensionPath: home.extensionPath, modelId: provider.modelId, thinking: provider.thinking },
  });
  const child = spawn(await pinnedPi(), args, { cwd: input.folder, env: { ...process.env, ...home.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const errors: string[] = [];
  const session = attachPiRpcSession({
    child, prompt: input.prompt, cwd: input.folder, model: provider.modelId,
    send: (channel, payload) => {
      if (channel === 'error') errors.push(String((payload as { message?: unknown }).message));
      else input.onEvent(payload as AgentEvent);
    },
  });
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pi did not finish\n${stderr}`)), 35_000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  return { child, session, exited, errors, stderr: () => stderr, home };
}

const deltaText = (events: AgentEvent[], type: string) =>
  events.filter(event => event.type === type).map(event => event.delta).join('');

it.each([
  { reasoning: 'off', native: false },
  { reasoning: 'low', native: false },
  { reasoning: 'off', native: true },
  { reasoning: 'low', native: true },
] as const)('runs the pinned pi with $reasoning reasoning (native: $native) without provider credentials', async ({ reasoning, native }) => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tts-pi-')));
  const payloads: Record<string, unknown>[] = [], preparations: Record<string, unknown>[] = [], rawSession = 'a'.repeat(43);
  let requestedWrite = false;
  const runtime = new TokenToSeaRuntime(folder, {
    session: async (raw: string) => raw === rawSession ? { id: 'issuer|alice', name: 'Alice' } : null,
    service: async (_raw: string, resource: string, _method: string, body: Record<string, unknown>) => {
      if (resource === 'models') return Response.json({ data: [{ id: 'test-chat', model: 'deepseek-flash', provider: 'deepseek', name: 'Test', priceVersion: 'test-price', billingMode: 'token', toolCalling: true, maxOutputTokens: 8192, reasoning: { efforts: ['off', 'low'], maxOutputTokens: 8192 }, ...(native ? { executionKind: 'official', modality: 'chat', verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: { stream: true } }] } : {}) }] });
      if (resource === 'grant') return Response.json({ perCallUsd: '1.000000', remainingUsd: '2.000000' });
      if (resource === 'official/prepare') { preparations.push(body); return Response.json({ id: `native-${preparations.length}`, status: 'prepared' }); }
      if (native) body = body.input as Record<string, unknown>;
      if (body.reasoning_effort !== (native && reasoning === 'off' ? undefined : reasoning) || !Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1 || Number(body.max_tokens) > (!native && reasoning === 'off' ? 4096 : 8192)) {
        return Response.json({ message: `model_invalid_controls ${JSON.stringify({ reasoning_effort: body.reasoning_effort, max_tokens: body.max_tokens })}` }, { status: 400 });
      }
      if (reasoning !== 'off' && (body.messages as Array<{ role?: string }>).some(message => message.role === 'tool')) {
        const assistant = (body.messages as Array<Record<string, unknown>>).find(message => message.role === 'assistant' && Array.isArray(message.tool_calls));
        if (assistant?.reasoning_content !== 'I will write the proof file.') return Response.json({ message: 'reasoning_history_missing' }, { status: 400 });
      }
      payloads.push(body);
      const tools = Array.isArray(body.tools) ? body.tools as Array<{ function?: { name?: string } }> : [];
      const toolCall = tools.some(tool => tool.function?.name === 'write') && !requestedWrite;
      if (toolCall) requestedWrite = true;
      const delta = toolCall
        ? { ...(reasoning === 'off' ? {} : { reasoning_content: 'I will write the proof file.' }), tool_calls: [{ index: 0, id: 'call_write_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: path.join(folder, 'proof.txt'), content: 'READY' }) } }] }
        : { role: 'assistant', content: 'READY' };
      return new Response([
        `data: ${JSON.stringify({ id: 'test-reply', object: 'chat.completion.chunk', created: 1, model: 'test-chat', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'test-reply', choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    }, close: () => {},
  } as never);
  const server = proxyServer(runtime, 'openai');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const lease = await leaseFor(runtime, rawSession, 'test-chat', reasoning);
    const events: AgentEvent[] = [];
    const run = await runPinnedPi({ folder, port: (server.address() as AddressInfo).port, lease, prompt: 'Write READY to proof.txt, then reply READY.', onEvent: event => events.push(event) });
    await run.exited;
    expect(run.errors, run.stderr()).toEqual([]);
    expect(run.session.completedSuccessfully()).toBe(true);
    expect(await readFile(path.join(folder, 'proof.txt'), 'utf8')).toBe('READY');
    expect(deltaText(events, 'text_delta')).toContain('READY');
    expect(events.some(event => event.type === 'tool_use' && event.name === 'write')).toBe(true);
    if (reasoning !== 'off') expect(deltaText(events, 'thinking_delta')).toBe('I will write the proof file.');
    expect(payloads.length).toBe(2);
    if (native) {
      expect(preparations[0]).toMatchObject({ model: 'deepseek-flash', priceVersion: 'test-price', maxCostUsd: '1.000000', path: '/v1/chat/completions', mode: 'sse' });
      expect(payloads[0]).toMatchObject({ model: 'deepseek-flash', thinking: { type: reasoning === 'off' ? 'disabled' : 'enabled' } });
    } else expect(payloads[0]).toMatchObject({ model: 'test-chat', priceVersion: 'test-price', maxCostUsd: '1.000000' });
    expect(JSON.stringify(payloads)).not.toContain(rawSession);
    expect(run.session.getLastSessionPath()).toMatch(new RegExp(`^${run.home.sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    lease.release();
    await run.home.cleanup();
  } finally {
    runtime.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
}, 45_000);

it('streams native thinking and text before upstream completion', async () => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tts-pi-live-')));
  let sourceFinished = false, release!: () => void, observed!: () => void, child: ChildProcess | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstDeltas = new Promise<void>(resolve => { observed = resolve; });
  const events: AgentEvent[] = [];
  let sequence = 0;
  const runtime = new TokenToSeaRuntime(folder, {
    session: async (raw: string) => raw === 's'.repeat(43) ? { id: 'live-user' } : null,
    close: () => {},
    service: async (_raw: string, resource: string, _method: string, body: Record<string, unknown>) => {
      if (resource === 'models') return Response.json({ data: [{ id: 'official:deepseek-flash', model: 'deepseek-flash', provider: 'deepseek', modality: 'chat', executionKind: 'official', priceVersion: 'live-price', billingMode: 'token', maxOutputTokens: 8192, verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: { thinking: { type: 'enabled' } } }] }] });
      if (resource === 'grant') return Response.json({ perCallUsd: '1.000000', remainingUsd: '2.000000' });
      if (resource === 'official/prepare') { expect(body.mode).toBe('sse'); return Response.json({ id: `live-${++sequence}` }); }
      expect(resource).toMatch(/official\/runs\/live-\d+\/stream$/);
      const input = body.input as Record<string, unknown>;
      expect(input.stream).toBe(true);
      expect(input.reasoning_effort).toBe('low');
      const encoder = new TextEncoder();
      const frame = (delta: object, finish: string | null = null) => encoder.encode(`data: ${JSON.stringify({ id: 'live-response', model: 'deepseek-flash', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame({ reasoning_content: 'First thought. ' }));
          controller.enqueue(frame({ reasoning_content: 'Second thought.' }));
          controller.enqueue(frame({ content: 'First ' }));
          controller.enqueue(frame({ content: 'answer.' }));
          void gate.then(() => { sourceFinished = true; controller.enqueue(frame({}, 'stop')); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); });
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  } as never);
  const server = proxyServer(runtime, 'openai');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const lease = await leaseFor(runtime, 's'.repeat(43), 'official:deepseek-flash', 'low');
    const run = await runPinnedPi({
      folder, port: (server.address() as AddressInfo).port, lease, prompt: 'Reply with text and stop.',
      onEvent: event => {
        events.push(event);
        if (events.some(item => item.type === 'thinking_delta') && deltaText(events, 'text_delta') === 'First answer.') observed();
      },
    });
    child = run.child;
    // Only observed live deltas unlock the producer, so completion cannot release itself.
    await Promise.race([firstDeltas, run.exited.then(() => { throw new Error(`pi completed without live deltas\n${run.stderr()}`); })]);
    expect(sourceFinished).toBe(false);
    expect(events.filter(event => event.type === 'thinking_delta').length).toBeGreaterThanOrEqual(2);
    expect(deltaText(events, 'thinking_delta')).toBe('First thought. Second thought.');
    release();
    await run.exited;
    expect(run.errors, run.stderr()).toEqual([]);
    expect(deltaText(events, 'text_delta')).toBe('First answer.');
    lease.release();
  } finally {
    release();
    if (child && child.exitCode === null) child.kill();
    runtime.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
}, 40_000);

it('runs TokenToSea Claude through native Messages with live thinking, effort and signed tool history', async () => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tts-pi-claude-'))), target = path.join(folder, 'proof.txt');
  const model = { id: 'supplier:fixture/global/claude-opus-4-7', model: 'fixture/global/claude-opus-4-7', upstreamModel: 'claude-opus-4-7', provider: 'anthropic', modality: 'chat', executionKind: 'official', billingMode: 'token', priceVersion: 'fixture-price', maxOutputTokens: 8192, verifiedEndpoints: ['/v1/messages'], examples: [{ path: '/v1/messages', mode: 'sse', body: {} }, { path: '/v1/messages', mode: 'json', body: {} }] };
  const signature = 'opaque-SwiftAPI-signature', thought = 'I will write the proof file.';
  let release!: () => void, observed!: () => void, child: ChildProcess | undefined, sentTool = false, secondTurn = false, producerFinished = false, sequence = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), firstDeltas = new Promise<void>(resolve => { observed = resolve; });
  const events: AgentEvent[] = [], incoming: Array<{ path: string; auth: string }> = [];
  const message = (content: unknown[] = []) => ({ id: `msg_${sequence}`, type: 'message', role: 'assistant', model: model.model, content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } });
  const runtime = new TokenToSeaRuntime(folder, {
    session: async (raw: string) => raw === 's'.repeat(43) ? { id: 'claude-test-user' } : null, close() {},
    service: async (_raw: string, resource: string, _method: string, body: Record<string, unknown>) => {
      if (resource === 'models') return Response.json({ data: [model] });
      if (resource === 'grant') return Response.json({ perCallUsd: '1', remainingUsd: '2' });
      if (resource === 'official/prepare') { expect(body.path).toBe('/v1/messages'); return Response.json({ id: `claude-${++sequence}` }); }
      const input = body.input as Record<string, unknown>;
      expect(input.model).toBe(model.model);
      expect(input.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(input.output_config).toMatchObject({ effort: 'medium' });
      expect(input).not.toHaveProperty('reasoning_effort');
      expect(Number(input.max_tokens)).toBeLessThanOrEqual(8192);
      const write = !sentTool;
      if (write) sentTool = true;
      else {
        const blocks = (input.messages as Array<{ content: unknown }>).flatMap(m => Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []);
        expect(blocks).toContainEqual(expect.objectContaining({ type: 'thinking', thinking: thought, signature }));
        expect(blocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_proof')).toBe(true);
        secondTurn = true;
      }
      const encode = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const send = (value: Record<string, unknown>) => controller.enqueue(encode.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`));
        const close = (reason: string) => { send({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 40 } }); send({ type: 'message_stop' }); controller.close(); };
        send({ type: 'message_start', message: message() });
        if (!write) {
          send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'READY' } }); send({ type: 'content_block_stop', index: 0 }); close('end_turn'); return;
        }
        send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } }); send({ type: 'content_block_stop', index: 0 });
        send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }); send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Starting. ' } }); send({ type: 'content_block_stop', index: 1 });
        void gate.then(() => {
          send({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_proof', name: 'write', input: {} } });
          send({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: target, content: 'READY' }) } });
          send({ type: 'content_block_stop', index: 2 }); producerFinished = true; close('tool_use');
        });
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  } as never);
  const server = proxyServer(runtime, 'anthropic', incoming);
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const lease = await leaseFor(runtime, 's'.repeat(43), model.id, 'medium');
    const run = await runPinnedPi({
      folder, port: (server.address() as AddressInfo).port, lease, prompt: `Write READY to ${target}, then reply READY.`,
      onEvent: event => {
        events.push(event);
        if (events.some(e => e.type === 'thinking_delta') && deltaText(events, 'text_delta') === 'Starting. ') observed();
      },
    });
    child = run.child;
    await Promise.race([firstDeltas, run.exited.then(() => { throw new Error(`Native Claude completed before live UI deltas\n${run.stderr()}`); })]);
    expect(producerFinished).toBe(false);
    release();
    await run.exited;
    expect(run.errors, run.stderr()).toEqual([]);
    expect(secondTurn).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('READY');
    expect(incoming.length).toBeGreaterThan(0);
    // The daemon serves this proxy at /api/tokentosea/agent/v1/messages; the key rides x-api-key.
    // (pi's Anthropic client calls the beta endpoint, `?beta=true`; Express routes ignore the query.)
    expect(incoming.map(req => [req.path.split('?')[0], req.auth === lease.token])).toEqual(incoming.map(() => ['/api/tokentosea/agent/v1/messages', true]));
    expect(deltaText(events, 'thinking_delta')).toBe(thought);
    expect(deltaText(events, 'text_delta')).toBe('Starting. READY');
    // The write target is announced from the streamed arguments, before the call runs.
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_input_target', name: 'write', path: target }));
    lease.release();
  } finally {
    release();
    if (child && child.exitCode === null) child.kill();
    runtime.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
}, 45_000);
