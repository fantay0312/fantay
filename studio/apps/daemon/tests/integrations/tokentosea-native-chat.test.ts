import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { tokenToSeaNativeChat } from '../../src/integrations/tokentosea-native-chat.js';
const model = { id: 'official:deepseek-flash', model: 'deepseek-flash', priceVersion: 'revision-1', examples: [{ path: '/v1/chat/completions', mode: 'json', body: {} }, { path: '/v1/chat/completions', mode: 'sse', body: { stream: true } }] };

it('delivers live reasoning and text while the upstream remains open, without polling or synthesizing completion', async () => {
  const input = { model: model.id, stream: true, messages: [{ role: 'user', content: 'hello' }], thinking: { type: 'enabled' }, reasoning_effort: 'high' };
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const source = new ReadableStream<Uint8Array>({ start(controller) { producer = controller; } });
  const service = vi.fn(async (resource: string, _method: string, _body?: unknown) => {
    if (resource === 'official/prepare') return Response.json({ id: 'native-run' });
    return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const response = await tokenToSeaNativeChat(model, input, '0.100000', service, new AbortController().signal, 'lease-bound-request');
  const payload = { input: { ...input, model: model.model, stream: true } };
  expect(service.mock.calls[0]?.[2]).toMatchObject({ model: model.model, priceVersion: 'revision-1', path: '/v1/chat/completions', mode: 'sse', maxCostUsd: '0.100000', requestKey: 'lease-bound-request', payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  expect(service.mock.calls[1]?.[0]).toBe('official/runs/native-run/stream');
  expect(service.mock.calls[1]?.[2]).toEqual(payload);
  const reader = response.body!.getReader(), encode = new TextEncoder();
  producer.enqueue(encode.encode('data: {"choices":[{"delta":{"reasoning_content":"First thought"}}]}\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('First thought');
  expect(finished).toBe(false);
  producer.enqueue(encode.encode('data: {"choices":[{"delta":{"content":"First answer"}}]}\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('First answer');
  expect(finished).toBe(false); expect(service).toHaveBeenCalledTimes(2);
  finished = true; producer.enqueue(encode.encode('data: [DONE]\n\n')); producer.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('[DONE]');
  expect((await reader.read()).done).toBe(true);
});

it('reports an undeployed native route without falling back to a different model or API', async () => {
  const service = vi.fn(async () => Response.json({ message: 'Cannot POST /v1/connect/official/prepare' }, { status: 404 }));
  await expect(tokenToSeaNativeChat(model, { stream: true }, '0.100000', service, new AbortController().signal)).rejects.toThrow('委托模型接口');
  expect(service).toHaveBeenCalledTimes(1);
});

it.each([false, true])('preserves a rate refusal and its retry delay even for a non-JSON error (json=%s)', async json => {
  const service = vi.fn(async () => json
    ? Response.json({ message: 'model_rate_limited', error: { code: 'model_rate_limited' } }, { status: 429, headers: { 'Retry-After': '17' } })
    : new Response('temporarily busy', { status: 429, headers: { 'Retry-After': '17' } }));
  await expect(tokenToSeaNativeChat(model, { stream: true }, '0.1', service, new AbortController().signal)).rejects.toMatchObject({ status: 429, retryAfter: '17' });
  expect(service).toHaveBeenCalledTimes(1);
});

it('cancels the prepared remote run if the caller disconnects', async () => {
  const controller = new AbortController();
  const service = vi.fn(async (resource: string) => {
    if (resource === 'official/prepare') return Response.json({ id: 'cancel-run' });
    if (resource.endsWith('/stream')) return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    return Response.json({ status: 'canceled' });
  });
  const response = await tokenToSeaNativeChat(model, { stream: true }, '0.100000', service, controller.signal);
  controller.abort();
  await expect(response.text()).rejects.toThrow();
  expect(service.mock.calls.map(call => call[0])).toContain('official/runs/cancel-run/cancel');
});

it('does not relabel a final JSON response as streaming output', async () => {
  const service = vi.fn(async (resource: string) => Response.json(resource === 'official/prepare' ? { id: 'not-live' } : { status: 'succeeded', output: { choices: [] } }));
  await expect(tokenToSeaNativeChat(model, { stream: true }, '0.100000', service, new AbortController().signal)).rejects.toThrow('live event stream');
  expect(service.mock.calls.some(call => call[0] === 'official/runs/not-live/cancel')).toBe(true);
});

it('reports a truncated stream and never adds a success marker', async () => {
  const service = vi.fn(async (resource: string) => resource === 'official/prepare' ? Response.json({ id: 'truncated' }) : resource.endsWith('/stream') ? new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json({ status: 'running' }));
  const response = await tokenToSeaNativeChat(model, { stream: true }, '0.100000', service, new AbortController().signal);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial');
  await expect(reader.read()).rejects.toThrow('before completion');
});

it('forwards native Messages reasoning/signatures and accepts message_stop instead of inventing DONE', async () => {
  const messages = { ...model, examples: [{ path: '/v1/messages', mode: 'sse', body: {} }] };
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const service = vi.fn(async (resource: string, _method: string, body?: unknown) => resource === 'official/prepare'
    ? Response.json({ id: 'claude-live' }) : new Response(new ReadableStream<Uint8Array>({ start(c) { producer = c; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await tokenToSeaNativeChat(messages, { stream: true, messages: [] }, '0.1', service, new AbortController().signal, 'claude-message-test', '/v1/messages');
  expect(service.mock.calls[0]?.[2]).toMatchObject({ path: '/v1/messages', mode: 'sse' });
  const reader = response.body!.getReader();
  producer.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"live thought"}}\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('live thought');
  producer.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_'));
  await reader.read();producer.enqueue(new TextEncoder().encode('stop"}\n\n'));producer.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('stop');expect((await reader.read()).done).toBe(true);
});

it('keeps explicitly non-streaming connection tests on the JSON receipt path', async () => {
  const service = vi.fn(async (resource: string) => Response.json(resource === 'official/prepare' ? { id: 'json-run' } : { status: 'succeeded', output: { choices: [{ message: { content: 'OK' } }] } }));
  const response = await tokenToSeaNativeChat(model, { stream: false }, '0.100000', service, new AbortController().signal);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect((await response.json() as { choices: unknown[] }).choices).toHaveLength(1);
  expect(service.mock.calls[1]?.[0]).toBe('official/runs/json-run/invoke');
});

it('closes on a real terminal marker even when the supplier keeps HTTP open', async () => {
  let cancelled = false;
  const service = vi.fn(async (resource: string) => resource === 'official/prepare' ? Response.json({ id: 'open-terminal' }) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await tokenToSeaNativeChat(model, { stream: true }, '0.1', service, new AbortController().signal);
  expect(await response.text()).toBe('data: [DONE]\n\n'); expect(cancelled).toBe(true);
  expect(service.mock.calls.map(call => call[0])).toEqual(['official/prepare', 'official/runs/open-terminal/stream']);
});

it('ends an idle stream on an authoritative pending bill without cancelling, settling or retrying inference', async () => {
  vi.useFakeTimers();
  try {
    const service = vi.fn(async (resource: string) => resource === 'official/prepare' ? Response.json({ id: 'pending-bill' }) : resource.endsWith('/stream')
      ? new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ status: 'needs_review', billingStatus: 'needs_review' }));
    const response = await tokenToSeaNativeChat(model, { stream: true }, '0.1', service, new AbortController().signal);
    const rejected = expect(response.text()).rejects.toMatchObject({ code: 'tokentosea_billing_pending', status: 422 });
    await vi.advanceTimersByTimeAsync(7500); await rejected;
    expect(service.mock.calls.map(call => call[0])).toEqual(['official/prepare', 'official/runs/pending-bill/stream', 'official/runs/pending-bill']);
  } finally { vi.useRealTimers(); }
});
