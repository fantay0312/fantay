import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { optionalTokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import type { AiUsageStore } from '../integrations/usage-store.js';

const current = new AsyncLocalStorage<{ store: AiUsageStore; key: string }>();

/** A local generation is one task. Provider-reported usage is a snapshot, not an estimate. */
export async function withMediaUsage<T>(input: { provider: string; model: string; surface: string; projectId: string }, work: () => Promise<T>): Promise<T> {
  const runtime = optionalTokenToSeaRuntime();
  if (!runtime || input.provider === 'tokentosea' || input.provider === 'hyperframes') return work();
  const key = `media:${randomUUID()}`, store = runtime.usage;
  store.begin('local', key, input.model, `byok:${input.surface}`, { projectId: input.projectId }, input.provider);
  return current.run({ store, key }, async () => {
    try {
      const result = await work();
      const row = result as { providerError?: unknown; usedStubFallback?: boolean; intentionalStub?: boolean };
      store.observe('local', key, { status: row.providerError || row.usedStubFallback || row.intentionalStub ? 'failed' : 'completed' });
      return result;
    } catch (error) { store.finish('local', key, true); throw error; }
  });
}

/** Observe only JSON the renderer already consumes; media bytes remain untouched. */
export async function fetchMedia(...args: Parameters<typeof fetch>): Promise<Response> {
  const response = await fetch(...args), context = current.getStore();
  if (!context) return response;
  const observe = (value: unknown) => context.store.observe('local', context.key, value);
  const json = response.json.bind(response), text = response.text.bind(response);
  Object.defineProperty(response,'json',{value:async () => { const value: unknown = await json(); observe(value); return value; }});
  Object.defineProperty(response,'text',{value:async () => {
    const value = await text();
    if (value.length <= 16 * 1024 * 1024) { try { observe(JSON.parse(value)); } catch { /* Non-JSON error text. */ } }
    return value;
  }});
  return response;
}
