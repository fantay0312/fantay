import { createHash } from 'node:crypto';
import type { UsagePriceInput } from './usage-pricing.js';

type Value = Record<string, unknown>;
export const usageObject = (v: unknown): Value => v && typeof v === 'object' && !Array.isArray(v) ? v as Value : {};
const str = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const n = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const at = (v: unknown): number => typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
export const usageIdentity = (v: string): string => createHash('sha256').update(v).digest('hex');

export interface NativeUsage extends UsagePriceInput {
  key: string;
  provider: string;
  sessionId: string;
  at: number;
  reportedUsd?: number;
  status?: string;
  granularity?: 'request' | 'session';
  requestCount?: number;
  /** Native step identity used only to resolve historical model metadata. */
  sourceStep?: number;
}

/** Each parser discards prompts, completions, paths and tool payloads immediately. */
export function createUsageLineParser(provider: 'codex' | 'claude', fallbackSession: string, onPartial = () => {}) {
  let session = fallbackSession, model = 'unknown';
  let previous: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
  let signature = '', epoch = 0, deferred = false, continuation = false, rootSeen = false;
  let pending: NativeUsage | null = null;
  const countsOf = (v: Value) => ({ input: n(v.input_tokens), output: n(v.output_tokens), cacheRead: n(v.cached_input_tokens), cacheWrite: n(v.cache_write_input_tokens) });
  const parse = (value: unknown): NativeUsage | null => {
    const row = usageObject(value), payload = usageObject(row.payload);
    if (provider === 'codex') {
      if (row.type === 'session_meta' && !rootSeen) {
        rootSeen = true;
        session = str(payload.id ?? payload.thread_id ?? payload.threadId) ?? session;
        const parent = payload.forked_from_id ?? usageObject(usageObject(usageObject(payload.source).subagent).thread_spawn).parent_thread_id;
        continuation = usageObject(payload.history_base).thread_id === session || (payload.history_mode === 'paginated' && !parent);
        // A fork may replay parent usage. Without a proven replay boundary, leave it explicitly partial.
        deferred = !!parent && !continuation && !(typeof row.ordinal === 'number' && row.ordinal === payload.forked_from_ordinal_exclusive);
        if (deferred) onPartial();
      }
      if (deferred) return null;
      if (row.type === 'turn_context' || payload.type === 'thread_settings_applied') model = str(payload.model) ?? model;
      if ((row.type === 'turn_context' || payload.type === 'task_started') && pending) {
        const completed = pending; pending = null; return completed;
      }
      if (row.type === 'token_usage_record') {
        const usage = usageObject(payload.usage);
        const completed = pending;
        pending = { provider, sessionId: session, key: usageIdentity(`${session}:record:${String(row.ordinal ?? row.timestamp)}`), model, ...countsOf(usage), inputIncludesCache: true, at: at(row.timestamp) };
        return completed;
      }
      if (row.type !== 'event_msg' || payload.type !== 'token_count') return null;
      const info = usageObject(payload.info), total = usageObject(info.total_token_usage), last = usageObject(info.last_token_usage);
      if (!Object.keys(total).length && !Object.keys(last).length) return null;
      const cumulative = Object.keys(total).length > 0;
      const current = countsOf(total);
      const nextSignature = JSON.stringify([total, last]);
      if (cumulative && signature === nextSignature) {
        const saved = pending; pending = null;
        return Object.keys(last).length && Object.values(countsOf(last)).every(v => v === 0) ? saved : null;
      }
      signature = nextSignature;
      if (previous && current.input < previous.input) epoch++;
      const identity = typeof row.ordinal === 'number' ? `${session}:ordinal:${row.ordinal}` : `${session}:${epoch}:${nextSignature}:${cumulative ? '' : String(row.timestamp)}`;
      // Cumulative snapshots include previous calls. After compaction/reset the new counters start from zero.
      const base = cumulative && previous && current.input >= previous.input && current.output >= previous.output && current.cacheRead >= previous.cacheRead && current.cacheWrite >= previous.cacheWrite ? previous : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const hasLast = Object.keys(last).length > 0;
      if (!hasLast && continuation && !previous) { previous = current; onPartial(); pending = null; return null; }
      if (cumulative) previous = current;
      const delta = hasLast ? countsOf(last) : { input: current.input - base.input, output: current.output - base.output, cacheRead: current.cacheRead - base.cacheRead, cacheWrite: current.cacheWrite - base.cacheWrite };
      const recorded = pending; pending = null;
      if (!delta.input && !delta.output && !delta.cacheRead) return recorded;
      const paired = recorded && recorded.input === delta.input && recorded.output === delta.output && recorded.cacheRead === delta.cacheRead && recorded.cacheWrite === delta.cacheWrite;
      // Keep the same identity if a previous scan ended between the usage record and its count snapshot.
      return { provider, sessionId: session, key: paired ? recorded.key : usageIdentity(identity), model, ...delta, inputIncludesCache: true, at: paired ? recorded.at : at(row.timestamp) };
    }
    if (row.type !== 'assistant' || row.isSidechain === true && !row.sessionId) return null;
    const message = usageObject(row.message), usage = usageObject(message.usage);
    const messageId = str(message.id) ?? str(row.uuid);
    if (!messageId || !Object.keys(usage).length) return null;
    session = str(row.sessionId) ?? session;
    model = str(message.model) ?? model;
    if (model.startsWith('<') && model.endsWith('>')) return null;
    return {
      provider, sessionId: session, key: usageIdentity(`${session}:${messageId}`), model,
      input: n(usage.input_tokens), output: n(usage.output_tokens), cacheRead: n(usage.cache_read_input_tokens), cacheWrite: n(usage.cache_creation_input_tokens),
      cacheWrite1h: n(usageObject(usage.cache_creation).ephemeral_1h_input_tokens), inputIncludesCache: false, at: at(row.timestamp),
    };
  };
  return Object.assign(parse, { finish: () => { const saved = pending; pending = null; return saved; } });
}

export function parseGeminiUsage(value: unknown, fallbackSession: string): NativeUsage[] {
  const root = usageObject(value), session = str(root.sessionId) ?? fallbackSession;
  if (!Array.isArray(root.messages)) return [];
  return root.messages.flatMap((v): NativeUsage[] => {
    const message = usageObject(v), counts = usageObject(message.tokens);
    if (message.type !== 'gemini' || !str(message.id) || !Object.keys(counts).length) return [];
    if(n(counts.input)+n(counts.output)+n(counts.thoughts)+n(counts.cached)===0)return [];
    return [{ provider: 'gemini', sessionId: session, key: usageIdentity(`${session}:${String(message.id)}`), model: str(message.model) ?? 'unknown',
      input: n(counts.input), output: n(counts.output) + n(counts.thoughts), cacheRead: n(counts.cached), cacheWrite: 0,
      inputIncludesCache: true, at: at(message.timestamp) }];
  });
}

export function parseOpenCodeUsage(value: unknown, fallbackId: string): NativeUsage | null {
  const row = usageObject(value), counts = usageObject(row.tokens), cache = usageObject(counts.cache), time = usageObject(row.time);
  if (row.role !== 'assistant' || !Object.keys(counts).length || !str(row.sessionID)) return null;
  const model = usageObject(row.model);
  return { provider: 'opencode', sessionId: String(row.sessionID), key: usageIdentity(`${String(row.sessionID)}:${str(row.id) ?? fallbackId}`),
    model: str(row.modelID) ?? str(row.model) ?? str(model.id) ?? 'unknown', priceProvider: str(row.providerID) ?? str(model.providerID), input: n(counts.input), output: n(counts.output) + n(counts.reasoning),
    cacheRead: n(cache.read), cacheWrite: n(cache.write), inputIncludesCache: false, at: at(time.created),
    ...(typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0 ? { reportedUsd: row.cost } : {}) };
}
