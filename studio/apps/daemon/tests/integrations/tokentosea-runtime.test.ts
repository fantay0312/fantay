import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TokenToSeaIdentity } from '../../src/integrations/tokentosea.js';
import { TokenToSeaRuntime, isTokenToSeaAgentModel, tokenToSeaCookie,authorizedCallBudget, tokenToSeaAgentOutputLimit, tokenToSeaReasoningOptions } from '../../src/integrations/tokentosea-runtime.js';

const alice = 'a'.repeat(43), bob = 'b'.repeat(43);
it('distinguishes unlimited limits from a zero-cost grant without inventing a budget',()=>{
  expect(authorizedCallBudget({perCallUsd:null,remainingUsd:null},'12.340000')).toBe(12.34);
  expect(authorizedCallBudget({perCallUsd:'0',remainingUsd:null})).toBe(0);
  expect(authorizedCallBudget({perCallUsd:null,remainingUsd:'2.000000'})).toBe(2);
  expect(()=>authorizedCallBudget({perCallUsd:null,remainingUsd:null})).toThrow('unavailable');
});
const servers: Server[] = [];
const runtimes: TokenToSeaRuntime[] = [], folders:string[]=[];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));runtimes.splice(0).forEach(runtime=>runtime.usage.close());folders.splice(0).forEach(folder=>rmSync(folder,{recursive:true,force:true})); });
function fixture() {
  const signed = new Set([alice, bob]);
  const model = { id: 'listing-chat', model: 'deepseek-flash', priceVersion: 'version-1', billingMode: 'token', toolCalling: true };
  const service = vi.fn(async (raw: string, resource: string, method?: string, body?: unknown, query?: unknown, signal?: AbortSignal) => {
    if (!signed.has(raw)) return Response.json({ message: 'expired' }, { status: 401 });
    if (resource === 'models') return Response.json({ data: [model] });
    if (resource === 'grant') return Response.json({ perCallUsd: '2.000000', remainingUsd: '10.000000' });
    if (resource === 'official/prepare') return Response.json({ id: 'native-run' });
    if (resource === 'official/runs/native-run/stream') return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    if (resource === 'official/runs/native-run') return Response.json({ status: 'succeeded', chargedUsd: '0.000001' });
    if (resource === 'chat/completions') return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return Response.json({});
  });
  const identity = { session: vi.fn(async (raw: string) => signed.has(raw) ? { id: raw === alice ? 'issuer|alice' : 'issuer|bob', name: raw === alice ? 'Alice' : 'Bob' } : null), service, close: vi.fn() };
  const directory=mkdtempSync(path.join(tmpdir(),'fantay-runtime-usage-'));folders.push(directory);
  const runtime = new TokenToSeaRuntime(directory, identity as unknown as TokenToSeaIdentity);runtimes.push(runtime);
  const inSession = <T>(raw: string, task: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    runtime.middleware({ headers: { cookie: `fantay_session=${raw}` }, originalUrl: '/api/test' } as never, {} as never, () => { void task().then(resolve, reject); });
  });
  return { runtime, inSession, service, signed, model };
}
async function serve(runtime: TokenToSeaRuntime, protocol: 'openai' | 'anthropic' = 'openai') {
  const app = express(); app.use(express.json());
  const route = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  app.post(route, (req, res) => { void runtime.inference(req, res, protocol); });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`;
}
describe('TokenToSea runtime', () => {
  it('keeps native search requests on the run account and rejects revoked search tokens', async () => {
    const { runtime, inSession, signed } = fixture();
    let revoke = () => {};
    await inSession(alice, async () => { revoke = runtime.bindToolToken('search-run-token', 60_000); });
    await inSession(bob, async () => {});
    const accountForSearch = () => new Promise<string | null>(resolve => {
      runtime.middleware({
        headers: { authorization: 'Bearer search-run-token', host: '127.0.0.1:7456' },
        originalUrl: '/api/search/search', socket: { remoteAddress: '127.0.0.1' },
      } as never, {} as never, () => resolve(runtime.current()?.user?.id ?? null));
    });
    expect(await accountForSearch()).toBe('issuer|alice');
    revoke();
    signed.delete(alice);
    expect(await accountForSearch()).toBeNull();
  });
  it.each(['openai', 'anthropic'] as const)('ends a stalled %s stream with a readable non-retryable billing error', async protocol => {
    vi.useFakeTimers();
    try {
      const { runtime, inSession, service, model } = fixture();
      const path = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
      Object.assign(model, { executionKind: 'official', modality: 'chat', provider: protocol === 'anthropic' ? 'anthropic' : 'deepseek', upstreamModel: protocol === 'anthropic' ? 'claude-opus-4-6' : 'deepseek-flash', examples: [{ path, mode: 'sse', body: {} }], verifiedEndpoints: [path] });
      const original = service.getMockImplementation()!;
      service.mockImplementation(async (...args) => args[1].endsWith('/stream')
        ? new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } })
        : args[1] === 'official/runs/native-run' ? Response.json({ status: 'needs_review', billingStatus: 'needs_review', chargedUsd: '0', reservedUsd: '0.01' }) : original(...args));
      const lease = await inSession(alice, () => runtime.createInferenceLease(model.id, {}, 'off'));
      const response = await fetch(await serve(runtime, protocol), { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'fixture' }], stream: true }) });
      const text = response.text(); await vi.advanceTimersByTimeAsync(7500);
      const body = await text;
      expect(body).toContain('tokentosea_billing_pending'); expect(body).toContain('invalid_request_error'); expect(body).not.toContain('[DONE]');
      expect(service.mock.calls.some(call => call[1].endsWith('/cancel') || call[1].endsWith('/invoke'))).toBe(false);
      lease.release();
    } finally { vi.useRealTimers(); }
  }, 10000);
  it('reports an invalid native Messages lease using the Anthropic error contract', async () => {
    const { runtime, service } = fixture();
    const response = await fetch(await serve(runtime, 'anthropic'), { method: 'POST', headers: { 'x-api-key': 'x'.repeat(43), 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error', message: expect.any(String) } });
    expect(service).not.toHaveBeenCalled();
  });
  it('advertises only catalog-declared reasoning levels and honors the declared default', () => {
    const base = { id: 'chat', model: 'chat', priceVersion: '1' };
    expect(tokenToSeaReasoningOptions(base)).toEqual([]);
    expect(tokenToSeaReasoningOptions({ ...base, reasoning: { efforts: ['off', 'low', 'high', 'max', 'invented'], default: 'high' } })).toEqual([
      { id: 'off', label: '关闭', reasoningControlKind: 'toggle' }, { id: 'low', label: '低', reasoningControlKind: 'effort' }, { id: 'high', label: '高', default: true, reasoningControlKind: 'effort' }, { id: 'max', label: '最高', reasoningControlKind: 'effort' },
    ]);
    expect(tokenToSeaAgentOutputLimit({ ...base, maxOutputTokens: 32768, reasoning: { efforts: ['off', 'low'], maxOutputTokens: 8192 } }, 'low')).toBe(8192);
    const native = { ...base, model: 'deepseek-flash', provider: 'deepseek', executionKind: 'official', maxOutputTokens: 32768, examples: [{ path: '/v1/chat/completions', mode: 'json', body: { thinking: { type: 'enabled' } } }] };
    expect(tokenToSeaReasoningOptions(native).map(option => option.id)).toEqual(['off', 'low', 'high', 'max']);
    expect(tokenToSeaAgentOutputLimit(native, 'high')).toBe(32768);
    expect(tokenToSeaReasoningOptions({ ...native, model: 'unknown-future-model' })).toEqual([]);
  });
  it('binds the selected effort and output ceiling to the lease, ignoring forged CLI choices', async () => {
    const { runtime, inSession, service, model } = fixture();
    Object.assign(model, { reasoning: { efforts: ['off', 'low', 'high', 'max'], default: 'high', maxOutputTokens: 8192 } });
    const lease = await inSession(alice, () => runtime.createInferenceLease('listing-chat', {}, 'low'));
    expect(lease.reasoningEffort).toBe('low');
    const response = await fetch(await serve(runtime), { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'listing-chat', reasoning_effort: 'max', max_tokens: 90000, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(200); await response.text();
    expect(service.mock.calls.find(call => call[1] === 'chat/completions')?.[3]).toMatchObject({ reasoning_effort: 'low', max_tokens: 8192 });
    lease.release();
  });
  it('drops a stale effort when switching to a model without reasoning support', async () => {
    const { runtime, inSession, service } = fixture();
    const lease = await inSession(alice, () => runtime.createInferenceLease('listing-chat', {}, 'high'));
    expect(lease.reasoningEffort).toBe('off');
    const response = await fetch(await serve(runtime), { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'listing-chat', reasoning_effort: 'high', max_tokens: 32768, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(200); await response.text();
    expect(service.mock.calls.find(call => call[1] === 'chat/completions')?.[3]).toMatchObject({ reasoning_effort: 'off', max_tokens: 4096 });
    lease.release();
  });
  it.each([
    { provider: 'qwen', upstreamModel: 'qwen3.8-flash', selected: 'on', expected: { enable_thinking: true, reasoning_effort: 'xhigh', max_completion_tokens: 32768 }, absent: ['thinking', 'max_tokens'] },
    { provider: 'minimax', upstreamModel: 'MiniMax-M3.1-Flash', selected: 'medium', expected: { reasoning_effort: 'medium', max_tokens: 32768 }, absent: ['thinking', 'enable_thinking'] },
    { provider: 'zhipu', upstreamModel: 'glm-5.3-flash', selected: 'off', expected: { thinking: { type: 'enabled' }, reasoning_effort: 'max' }, absent: ['enable_thinking'] },
  ])('projects $provider model controls from the lease into the actual native stream request', async ({ provider, upstreamModel, selected, expected, absent }) => {
    const { runtime, inSession, service, model } = fixture();
    Object.assign(model, { executionKind: 'official', modality: 'chat', provider, model: `fixture/global/${upstreamModel}`, upstreamModel, verifiedEndpoints: ['/v1/chat/completions'], maxOutputTokens: 32768, examples: [{ path: '/v1/chat/completions', mode: 'sse', body: { enable_thinking: false } }] });
    const lease = await inSession(alice, () => runtime.createInferenceLease('listing-chat', {}, selected));
    const response = await fetch(await serve(runtime), { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'listing-chat', messages: [{ role: 'user', content: 'hello' }], stream: true, thinking: { type: 'disabled' }, reasoning_effort: 'max', enable_thinking: false, max_tokens: 999999 }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain('[DONE]');
    const payload = service.mock.calls.find(call => call[1] === 'official/runs/native-run/stream')?.[3] as { input: Record<string, unknown> };
    expect(payload.input).toMatchObject(expected);
    for (const key of absent) expect(payload.input).not.toHaveProperty(key);
    lease.release();
  });
  it('keeps a smaller CLI max_completion_tokens limit when projecting a native OpenAI request', async () => {
    const { runtime, inSession, service, model } = fixture();
    Object.assign(model, { executionKind: 'official', modality: 'chat', provider: 'openai', upstreamModel: 'gpt-5.6-terra', maxOutputTokens: 32768, verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: {} }] });
    const lease = await inSession(alice, () => runtime.createInferenceLease('listing-chat', {}, 'low'));
    const response = await fetch(await serve(runtime), { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'listing-chat', stream: true, max_completion_tokens: 512, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(200); await response.text();
    const payload = service.mock.calls.find(call => call[1] === 'official/runs/native-run/stream')?.[3] as { input: Record<string, unknown> };
    expect(payload.input.max_completion_tokens).toBe(512); expect(payload.input).not.toHaveProperty('max_tokens');
    lease.release();
  });
  it.each([undefined, 1024, 4096, 32768])('bounds agent output to the non-reasoning gateway and catalog limits (%s)', (maxOutputTokens) => {
    expect(tokenToSeaAgentOutputLimit({ id: 'chat', model: 'chat', priceVersion: '1', ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) })).toBe(maxOutputTokens === 1024 ? 1024 : 4096);
  });
  it('requires the live catalog tool-calling field, rejects unsupported and unavailable models', () => {
    const base = { id: 'x', model: 'x', priceVersion: '1', billingMode: 'token', toolCalling: true };
    expect(isTokenToSeaAgentModel(base)).toBe(true);
    expect(isTokenToSeaAgentModel({ ...base, toolCalling: false })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, available: false })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, executionKind: 'official' })).toBe(false);
  });
  it('accepts current-catalog chat models that verify chat completions, without a tool-calling field', () => {
    const chat = { id: 'official:deepseek-flash', model: 'deepseek-flash', priceVersion: '1', billingMode: 'token', modality: 'chat', executionKind: 'official', status: 'active', verifiedEndpoints: ['/v1/chat/completions', '/v1/messages'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: {} }] };
    expect(isTokenToSeaAgentModel(chat)).toBe(true);
    expect(isTokenToSeaAgentModel({ ...chat, verifiedEndpoints: ['/v1/messages'], protocols: ['anthropic-messages'] })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...chat, modality: 'video' })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...chat, status: 'disabled' })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...chat, toolCalling: false })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...chat, executionKind: 'system_one', modality: 'system_one' })).toBe(false);
  });
  it.each(['image', 'video', 'speech', 'asr', 'audio', 'music', 'realtime', 'system_one'])('rejects %s even when a legacy row claims tool calling', modality => {
    expect(isTokenToSeaAgentModel({ id: 'media', model: 'media', priceVersion: '1', billingMode: 'token', toolCalling: true, modality })).toBe(false);
  });
  it('does not revive disabled legacy or non-chat execution kinds through the tools fallback', () => {
    const base = { id: 'legacy', model: 'legacy', priceVersion: '1', billingMode: 'token', toolCalling: true };
    expect(isTokenToSeaAgentModel({ ...base, status: 'disabled' })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, executionKind: 'system_one', modality: 'chat', verifiedEndpoints: ['/v1/chat/completions'] })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, category: 'audio' })).toBe(false);
  });
  it('requires an executable text stream and does not treat audio-only chat endpoints as the text agent', () => {
    const base = { id: 'native', model: 'native', priceVersion: '1', billingMode: 'token', modality: 'chat', executionKind: 'official', verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: {} }] };
    const { examples: _examples, ...withoutExample } = base;
    expect(isTokenToSeaAgentModel(withoutExample)).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, examples: [] })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, verifiedModes: { '/v1/chat/completions': { sse: false } } })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, verifiedInputs: { '/v1/chat/completions': { sse: ['audio'] } } })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, examples: [{ path: '/v1/chat/completions', mode: 'sse', body: { modalities: ['audio'] } }] })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, examples: [{ path: '/v1/chat/completions', mode: 'json', body: {} }] })).toBe(false);
    expect(isTokenToSeaAgentModel({ ...base, verifiedInputs: { '/v1/chat/completions': { sse: ['text', 'image'] } } })).toBe(true);
    expect(isTokenToSeaAgentModel({ ...base, provider: 'anthropic', verifiedEndpoints: ['/v1/messages'], examples: [{ path: '/v1/messages', mode: 'sse', body: {} }] })).toBe(true);
  });
  it('migrates the cookie without confusing old and new sessions', () => {
    expect(tokenToSeaCookie({ headers: { cookie: `fantay_identity=${bob}; fantay_session=${alice}` } })).toBe(alice);
    expect(tokenToSeaCookie({ headers: { cookie: `fantay_identity=${bob}` } })).toBe(bob);
    expect(tokenToSeaCookie({ headers: { cookie: 'fantay_session=invalid' } })).toBe('');
  });
  it.each(['qwen-mt-flash', 'qwen-mt-plus', 'qwen-mt-lite', 'qwen-long', 'qwen-flash-character-2026-02-26', 'qwen-vl-ocr', 'qwen3.5-ocr'])('keeps the dedicated %s service out of the tool agent', upstreamModel => {
    const model = { id: 'native', model: 'fixture/group/'+upstreamModel, upstreamModel, provider: 'qwen', priceVersion: '1', billingMode: 'token', modality: 'chat', executionKind: 'official', toolCalling: true, verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: {} }] };
    expect(isTokenToSeaAgentModel(model)).toBe(false);
    expect(isTokenToSeaAgentModel({ ...model, upstreamModel: 'qwen3-coder-flash' })).toBe(true);
  });
  it('rejects a Chat-only supplier account that requires unavailable Responses for tools', () => {
    const model = { id: 'native', model: 'lingzhigongfang/global/gpt-6.1-sol', provider: 'openai', priceVersion: '1', billingMode: 'token', modality: 'chat', executionKind: 'official', verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: {} }] };
    expect(isTokenToSeaAgentModel(model)).toBe(false);
    expect(isTokenToSeaAgentModel({ ...model, model: 'tokentide/gpt/gpt-6.1-sol' })).toBe(true);
  });
  it('keeps the native GLM voice service out of the text/tool agent', () => {
    const model = { id: 'native', model: 'glm-4-voice', provider: 'zhipu', priceVersion: '1', billingMode: 'token', modality: 'chat', executionKind: 'official', verifiedEndpoints: ['/v1/chat/completions'], examples: [{ path: '/v1/chat/completions', mode: 'sse', body: {} }] };
    expect(isTokenToSeaAgentModel(model)).toBe(false);
    expect(isTokenToSeaAgentModel({ ...model, model: 'glm-4.7' })).toBe(true);
  });
  it('keeps concurrent identity contexts separate and refuses ambiguous background account selection', async () => {
    const { runtime, inSession } = fixture();
    await Promise.all([alice, bob].map(raw => inSession(raw, async () => { await Promise.resolve(); runtime.rememberWorkspace('team'); expect(runtime.current()?.raw).toBe(raw); })));
    await expect(runtime.inWorkspace('team', async () => true)).rejects.toThrow('唯一账号');
    expect(runtime.current()).toBeNull();
  });
  it('never borrows a remembered account for an explicitly signed-out request', async () => {
    const { runtime, inSession } = fixture();
    await inSession(alice, async () => { runtime.rememberWorkspace('team'); });
    await expect(inSession('unknown', () => runtime.inWorkspace('team', async () => true))).rejects.toThrow('登录');
    expect(await runtime.backgroundInWorkspace('team', async () => runtime.current()?.user?.name)).toBe('Alice');
    expect(await inSession('unknown',()=>runtime.backgroundInWorkspace('',async()=>runtime.current()?.user?.name))).toBe('Alice');
  });
  it('proxies a tool-capable model using its listing ID, price revision and authorized budget', async () => {
    const { runtime, inSession, service } = fixture();
    const lease = await inSession(alice, () => runtime.createInferenceLease('listing-chat'));
    const url = await serve(runtime);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'listing-chat', messages: [{ role: 'user', content: 'hello' }], stream: true }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain('[DONE]');
    const call = service.mock.calls.find(item => item[1] === 'chat/completions')!;
    expect(call[0]).toBe(alice);
    expect(call[3]).toMatchObject({ model: 'listing-chat', priceVersion: 'version-1', maxCostUsd: '2.000000', requestKey: expect.any(String) });
    expect(call[5]).toBeInstanceOf(AbortSignal);
    expect(lease.token).not.toBe(alice);
    lease.release();
    expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('denies an unsigned request and a lease used for a different model before any upstream call', async () => {
    const { runtime, inSession, service } = fixture();
    await expect(runtime.createInferenceLease('listing-chat')).rejects.toThrow('登录');
    const lease = await inSession(alice, () => runtime.createInferenceLease('listing-chat'));
    const url = await serve(runtime);
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'other', messages: [] }) })).status).toBe(400);
    expect(service.mock.calls.filter(item => item[1] === 'chat/completions')).toHaveLength(0);
    lease.release();
  });
});
