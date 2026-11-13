import { randomUUID } from 'node:crypto';
import type { ConnectionTestResponse } from '@open-design/contracts';
import { tokenToSeaRuntime, tokenToSeaReasoningOptions } from './tokentosea-runtime.js';
import { tokenToSeaNativeChat } from './tokentosea-native-chat.js';
import { applyTokenToSeaReasoning, resolveTokenToSeaReasoning } from './tokentosea-reasoning.js';
import { tokenToSeaNativePath } from './tokentosea-claude.js';

/** Called only by the explicit connection-test action, under the current OAuth grant. */
export async function testTokenToSeaConnection(requestedModel?: string, signal?: AbortSignal): Promise<ConnectionTestResponse> {
  const started = Date.now(), runtime = tokenToSeaRuntime();
  const result = (value: Omit<ConnectionTestResponse, 'latencyMs'>): ConnectionTestResponse => ({ ...value, latencyMs: Date.now() - started, agentName: 'TokenToSea' });
  if (!runtime.current()?.user) return result({ ok: false, kind: 'agent_auth_required' });
  try {
    const models = await runtime.chatModels();
    const model = !requestedModel || requestedModel === 'default' ? models[0] : models.find(model => model.id === requestedModel || model.model === requestedModel);
    if (!model) return result({ ok: false, kind: 'not_found_model' });
    const budget = Math.min(0.01, await runtime.authorizationBudget());
    if (!Number.isFinite(budget) || budget <= 0) return result({ ok: false, kind: 'forbidden', detail: 'TokenToSea authorization budget is exhausted.' });
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
    const input = {
      model: model.id, priceVersion: model.priceVersion, requestKey: randomUUID(), maxCostUsd: budget.toFixed(6),
      messages: [{ role: 'user', content: 'Reply exactly OK.' }], max_tokens: 8, stream: false,
    };
    const options = tokenToSeaReasoningOptions(model);
    const smoke = options.find(option => option.id === 'off') ?? options.find(option => option.id === 'low') ?? options.find(option => option.default);
    const operation = tokenToSeaNativePath(model);
    const stream = !model.examples?.some(example => example.path === operation && example.mode === 'json');
    const nativeBody: Record<string, unknown> = { model: model.id, messages: input.messages, max_tokens: smoke && smoke.id !== 'off' ? 256 : 8, stream };
    applyTokenToSeaReasoning(model, resolveTokenToSeaReasoning(model, smoke?.id), nativeBody);
    let sample: unknown;
    if (model.executionKind === 'official') {
      const response = await tokenToSeaNativeChat(model, nativeBody, budget.toFixed(6), (resource, method, body, requestSignal) => runtime.response(resource, method, body, {}, requestSignal), deadline, undefined, operation);
      if (stream) {
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('Connection sample too large');
        sample = text.split(/\r?\n\r?\n/).flatMap(frame => {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') return [];
          const event = JSON.parse(data);
          return operation === '/v1/messages' ? event.delta?.type === 'text_delta' ? [event.delta.text] : [] : [event.choices?.[0]?.delta?.content ?? ''];
        }).join('');
      } else {
        const value = await response.json() as { content?: Array<{ type: string; text?: string }>; choices?: Array<{ message?: { content?: unknown } }> };
        sample = operation === '/v1/messages' ? value.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') : value.choices?.[0]?.message?.content;
      }
    } else {
      const response = await runtime.json<{ choices?: Array<{ message?: { content?: unknown } }> }>('chat/completions', 'POST', input, {}, deadline);
      sample = response.choices?.[0]?.message?.content;
    }
    if (typeof sample !== 'string' || !sample.trim()) return result({ ok: false, kind: 'upstream_unavailable', model: model.id });
    return result({ ok: true, kind: 'success', model: model.id, sample: sample.slice(0, 120), diagnostics: { phase: 'connection_smoke_test' } });
  } catch (error) {
    const status = (error as { status?: number }).status;
    return result({ ok: false, kind: status === 401 ? 'agent_auth_required' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : signal?.aborted ? 'timeout' : 'upstream_unavailable' });
  }
}
