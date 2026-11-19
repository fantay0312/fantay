import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { usageObject as obj, usageIdentity as hash, type NativeUsage } from './usage-local-parsers.js';
import type { UsagePrice, UsagePriceSnapshot } from './usage-pricing.js';

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;
const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
type Issue = 'invalid-record' | 'incomplete-usage' | 'unsupported-format';

/** Muse 1.4 session journals contain both provider usage and repeated attribution/control events.
 *  Only explicit usage carriers are read; prompt bodies and checkpoint projections are never traversed. */
export function museUsageParser(file: string, onPartial: (issue: Issue) => void) {
  const parts = file.split(path.sep), childIndex = parts.lastIndexOf('subagent');
  const parent = childIndex > 0 ? parts[childIndex - 1] : undefined;
  let session = path.basename(path.dirname(file)), model = 'unknown', recognized = false;
  const rows = new Map<string, NativeUsage>();
  const seen = new Set<string>();
  const seenUsage = new Set<string>();
  const occurrences = new Map<string, number>();
  const pending = new Map<string, NativeUsage[]>();
  const signature = (u: Record<string, unknown>) => JSON.stringify([n(u.input_tokens), n(u.output_tokens), n(u.cache_read_tokens ?? u.cached_tokens), n(u.cache_write_tokens), n(u.reasoning_tokens)]);
  const counts = (u: Record<string, unknown>) => {
    if (!Number.isSafeInteger(u.input_tokens) || Number(u.input_tokens) < 0 || !Number.isSafeInteger(u.output_tokens) || Number(u.output_tokens) < 0) { onPartial('incomplete-usage'); return null; }
    const input = n(u.input_tokens), cacheRead = n(u.cache_read_tokens ?? u.cached_tokens), cacheWrite = n(u.cache_write_tokens);
    if (cacheRead + cacheWrite > input || n(u.reasoning_tokens) > n(u.output_tokens)) { onPartial('unsupported-format'); return null; }
    // Muse input/output include cached/reasoning subsets. The ledger's input excludes separately shown cache.
    return { input: input - cacheRead - cacheWrite, output: n(u.output_tokens), cacheRead, cacheWrite, inputIncludesCache: false };
  };
  const parseRecord = (value: unknown, depth = 0): void => {
    if (depth > 8) { onPartial('invalid-record'); return; }
    const row = obj(value), payload = obj(row.payload);
    if (typeof row.retained_frame === 'string') {
      const children = payload.children ?? row.children;
      if (!Array.isArray(children)) { onPartial('unsupported-format'); return; }
      if (children.length > 4096) { onPartial('invalid-record'); return; }
      for (const child of children) {
        const json = obj(child).record_json;
        if (typeof json !== 'string') continue;
        try { parseRecord(JSON.parse(json), depth + 1); } catch { onPartial('invalid-record'); }
      }
      return;
    }
    if (row.schema_version !== 1 || typeof row.payload_type !== 'string' || !row.payload_type.startsWith('runtime.session')) return;
    recognized = true;
    const stream = obj(row.stream);
    if (stream.kind !== 'session' || !str(stream.id)) return;
    session = String(stream.id);
    if (payload.kind === 'metadata') model = str(obj(payload.record).model_id) ?? model;
    if (payload.kind === 'model_reconfigure') model = str(obj(obj(payload.record).effective).model_id) ?? model;
    if (payload.kind !== 'run') return;
    const event = obj(payload.event), kind = event.kind;
    if (kind !== 'goal_usage_attribution' && kind !== 'model_completed') return;
    const recordId = str(row.id);
    if (!recordId || seen.has(recordId)) return;
    seen.add(recordId);
    const at = typeof row.recorded_at === 'number' ? Math.floor(row.recorded_at / 1000) : NaN;
    if (!Number.isFinite(at)) { onPartial('invalid-record'); return; }
    const root = parent ?? session, run = str(payload.run_id) ?? session;
    if (kind === 'goal_usage_attribution') {
      const record = obj(event.record), owner = obj(record.owner), u = obj(record.quantity);
      if (!['provider', 'compaction'].includes(String(record.usage_family)) || u.unit !== 'tokens') return;
      if (u.reported !== true) { onPartial('incomplete-usage'); return; }
      const usage = counts(u); if (!usage) return;
      const usageId = str(record.usage_id);
      if (usageId && seenUsage.has(`${session}:${usageId}`)) return;
      if (usageId) seenUsage.add(`${session}:${usageId}`);
      const sig = signature(u), reminder = owner.requester_kind === 'reminder';
      let identity = usageId ?? recordId;
      if (reminder && str(owner.owner_id)) {
        // Parent forwarding assigns a different usage_id. Owner + per-signature occurrence preserves retries.
        const base = `${root}:reminder:${String(owner.owner_id)}:${sig}`;
        const occurrence = (occurrences.get(base) ?? 0) + 1; occurrences.set(base, occurrence);
        identity = `${base}:${occurrence}`;
      } else identity = `${root}:${session}:${identity}`;
      const local = !reminder || owner.owner_id === session;
      const result: NativeUsage = { key: hash(`muse:${identity}`), provider: 'muse', sessionId: root,
        model: record.usage_family === 'compaction' || !local ? 'unknown' : model, priceProvider: 'muse', at, ...usage };
      rows.set(result.key, result);
      if (local && record.usage_family === 'provider') {
        const key = `${run}:${sig}`, list = pending.get(key) ?? []; list.push(result); pending.set(key, list);
      }
      return;
    }
    const u = obj(event.usage), usage = counts(u); if (!usage) return;
    const paired = pending.get(`${run}:${signature(u)}`)?.pop();
    if (paired) { paired.model = str(event.model) ?? paired.model; return; }
    const result: NativeUsage = { key: hash(`muse:${root}:${session}:${recordId}`), provider: 'muse', sessionId: root,
      model: str(event.model) ?? model, priceProvider: 'muse', at, ...usage };
    rows.set(result.key, result);
  };
  return {
    parse(value: unknown): NativeUsage[] { parseRecord(value); return []; },
    finish(): NativeUsage[] { if (!recognized) onPartial('unsupported-format'); return [...rows.values()]; },
  };
}

/** Local provider catalog prices are USD per 1M tokens. Exact model IDs only; no Wonder/full aliases. */
export async function museUsagePrices(roots: string[]): Promise<UsagePriceSnapshot> {
  const prices: Record<string, UsagePrice> = {}, conflicts = new Set<string>();
  const rate = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
  for (const dir of new Set(roots.map(root => path.join(path.dirname(root), 'model-catalog')))) {
    for (const file of (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json')).slice(0, 100)) {
      try {
        const target = path.join(dir, file);
        if ((await stat(target)).size > 4 * 1024 * 1024) continue;
        const catalog = obj(JSON.parse(await readFile(target, 'utf8')));
        if (catalog.schema_version !== 3 || catalog.source !== 'provider_catalog' || !Array.isArray(catalog.rows)) continue;
        for (const value of catalog.rows) {
          const row = obj(value), cost = obj(row.cost), id = str(row.model_id);
          const input = rate(cost.input), output = rate(cost.output), cacheRead = rate(cost.cached);
          if (!id || cost.currency !== 'USD' || input === undefined || output === undefined) continue;
          const key = `muse/${id}`, next = { input, output, cacheRead };
          if (prices[key] && JSON.stringify(prices[key]) !== JSON.stringify(next)) conflicts.add(key);
          prices[key] = next;
        }
      } catch { /* Missing or corrupt prices never prevent token accounting. */ }
    }
  }
  for (const key of conflicts) delete prices[key];
  return { fetchedAt: Date.now(), prices };
}
