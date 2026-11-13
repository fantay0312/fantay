import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TokenToSeaModel } from './tokentosea-runtime.js';

type Service = (resource: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal) => Promise<Response>;

/** Keep actionable HTTP failures intact even when an intermediary sends a non-JSON body. */
async function nativeRequestError(response: Response, fallback: string): Promise<Error> {
  const value = await response.json().catch(() => null) as { message?: unknown; error?: { message?: unknown; code?: unknown } } | null;
  const message = typeof value?.message === 'string' ? value.message : typeof value?.error?.message === 'string' ? value.error.message : fallback;
  const code = typeof value?.error?.code === 'string' && /^[a-z0-9_]{1,100}$/.test(value.error.code) ? value.error.code : undefined;
  const delay = response.headers.get('retry-after');
  const retryAfter = delay && delay.length <= 128 && (/^\d{1,9}$/.test(delay) || Number.isFinite(Date.parse(delay))) ? delay : undefined;
  return Object.assign(new Error(message), { status: response.status, code, retryAfter });
}

/** Native catalog entries use the delegated prepare/invoke/receipt protocol, not the legacy market API. */
export async function tokenToSeaNativeChat(model: TokenToSeaModel, body: Record<string, unknown>, maximum: string, service: Service, signal: AbortSignal, idempotencyKey: string = randomUUID(), operation: '/v1/chat/completions' | '/v1/messages' = '/v1/chat/completions'): Promise<Response> {
  const live = body.stream === true;
  const mode = live ? 'sse' : 'json';
  if (!model.examples?.some(example => example.path === operation && example.mode === mode)) {
    throw new Error(`This TokenToSea model has no verified ${mode} chat operation`);
  }
  const payload = { input: { ...body, model: model.model, stream: live } };
  let runId: string | undefined;
  let terminal = false;
  let handedOff = false;
  const request = async (resource: string, method: 'GET' | 'POST', data?: unknown, requestSignal = signal) => {
    const response = await service(resource, method, data, requestSignal);
    if (!response.ok) {
      const message = response.status === 404 && resource === 'official/prepare'
        ? 'TokenToSea 服务尚未启用委托模型接口'
        : `TokenToSea request failed (${response.status})`;
      const error = await nativeRequestError(response, message);
      if (response.status === 404 && resource === 'official/prepare') error.message = message;
      throw error;
    }
    return response.json() as Promise<Record<string, any>>;
  };
  let cancelling: Promise<unknown> | undefined;
  const cancel = () => cancelling ??= request(`official/runs/${runId}/cancel`, 'POST', {}, AbortSignal.timeout(5000)).catch(() => undefined);
  try {
    const prepared = await request('official/prepare', 'POST', {
      model: model.model, priceVersion: model.priceVersion, path: operation, mode,
      payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), requestKey: idempotencyKey, maxCostUsd: maximum,
    });
    if (typeof prepared.id !== 'string' || !/^[\w-]+$/.test(prepared.id)) throw new Error('Invalid TokenToSea inference receipt');
    runId = prepared.id;
    if (live) {
      const upstream = await service(`official/runs/${runId}/stream`, 'POST', payload, signal);
      if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
        if (!upstream.ok) {
          const error = await nativeRequestError(upstream, `TokenToSea stream failed (${upstream.status})`);
          if (upstream.status === 404) error.message = 'TokenToSea 服务尚未启用实时流式接口';
          throw error;
        }
        await upstream.body?.cancel();
        throw new Error('TokenToSea did not return a live event stream');
      }
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const receiptWatch = new AbortController();
      let lastByteAt = Date.now();
      let tail = '', done = false, closed = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cleanup = () => { closed = true; receiptWatch.abort(); signal.removeEventListener('abort', abort); };
      const abort = () => {
        if (closed) return;
        cleanup(); void reader.cancel(signal.reason).catch(() => undefined); void cancel();
        controller.error(signal.reason ?? new Error('TokenToSea stream cancelled'));
      };
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); },
        async pull(value) {
          try {
            const chunk = await reader.read();
            if (closed) return;
            if (chunk.done) {
              cleanup();
              if (!done) { await cancel(); value.error(new Error('TokenToSea stream ended before completion')); }
              else value.close();
              return;
            }
            lastByteAt = Date.now();
            tail += decoder.decode(chunk.value, { stream: true });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(tail))) {
              const frame = tail.slice(0, boundary.index); tail = tail.slice(boundary.index + boundary[0].length);
              const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (operation === '/v1/messages' ? data && JSON.parse(data)?.type === 'message_stop' : data === '[DONE]') done = true;
            }
            if (Buffer.byteLength(tail) > 2 * 1024 * 1024) throw new Error('TokenToSea stream frame is too large');
            value.enqueue(chunk.value);
            // A real terminal marker is sufficient. Some relays keep the HTTP connection open afterwards.
            if (done) { cleanup(); value.close(); void reader.cancel().catch(() => undefined); }
          } catch (error) { if (!closed) { cleanup(); await cancel(); value.error(error); } }
        },
        async cancel(reason) { if (!closed) { cleanup(); await reader.cancel(reason).catch(() => undefined); await cancel(); } },
      });
      // A relay can finish generation but withhold the terminal frame while its bill needs review.
      // Read the existing receipt after an idle period; never regenerate, settle or release its hold.
      void (async () => {
        try {
          while (!closed) {
            await delay(2500, undefined, { signal: receiptWatch.signal, ref: false });
            if (closed || done || Date.now() - lastByteAt < 5000) continue;
            let receipt: Record<string, any>;
            try { receipt = await request(`official/runs/${runId}`, 'GET', undefined, AbortSignal.any([signal, receiptWatch.signal, AbortSignal.timeout(5000)])); }
            catch { continue; }
            if (closed || done) return;
            const uncertain = receipt.status === 'needs_review' || receipt.billingStatus === 'needs_review';
            if (!uncertain && !['failed', 'cancelled', 'canceled', 'expired'].includes(receipt.status)) continue;
            const error = Object.assign(new Error(uncertain
              ? 'TokenToSea 已收到供应商结果，但账单仍待核验。预占保持不变，请稍后查看记录或切换通道。'
              : 'TokenToSea 本次模型调用未完成，请检查调用记录或切换通道。'), { status: 422, code: uncertain ? 'tokentosea_billing_pending' : 'tokentosea_run_failed' });
            cleanup(); void reader.cancel(error).catch(() => undefined); controller.error(error); return;
          }
        } catch { /* Normal stream completion or cancellation stops the read-only watch. */ }
      })();
      handedOff = true;
      return new Response(stream, { status: upstream.status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } });
    }
    let run = await request(`official/runs/${runId}/invoke`, 'POST', payload);
    while (true) {
      signal.throwIfAborted();
      if (['failed', 'canceled', 'cancelled', 'expired', 'needs_review'].includes(run.status)) {
        terminal = true;
        throw new Error(typeof run.errorCode === 'string' ? run.errorCode : `TokenToSea inference ${run.status}`);
      }
      if (run.status === 'succeeded' && run.output && typeof run.output === 'object') {
        terminal = true;
        const output = run.output as Record<string, any>;
        if (operation === '/v1/messages' ? !Array.isArray(output.content) || !output.content.length : !Array.isArray(output.choices) || !output.choices.length) throw new Error('TokenToSea inference returned no chat content');
        const receipt = { runId, chargedUsd: run.chargedUsd ?? '0.000000' };
        return Response.json({ ...output, model: model.id, tokentosea: receipt });
      }
      await delay(1000, undefined, { signal });
      run = await request(`official/runs/${runId}`, 'GET');
    }
  } finally {
    if (runId && !terminal && !handedOff) await cancel();
  }
}
