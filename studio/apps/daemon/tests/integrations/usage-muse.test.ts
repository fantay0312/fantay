import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { museUsageParser, museUsagePrices } from '../../src/integrations/usage-muse.js';
import { AiUsageStore } from '../../src/integrations/usage-store.js';
import { LocalAgentUsage } from '../../src/integrations/usage-local-agents.js';
import { estimateUsageUsd } from '../../src/integrations/usage-pricing.js';

const dirs: string[] = [], stores: AiUsageStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const at = Date.parse('2026-11-14T01:00:00Z');
const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 60, reasoning_tokens: 10 };
const record = (id: string, event: unknown, session = 'root') => ({ schema_version: 1, id, stream: { kind: 'session', id: session }, recorded_at: at * 1000,
  payload_type: 'runtime.session', payload: { kind: 'run', run_id: `${session}-run`, event } });
const attribution = (id: string, requester = 'main', session = 'root', u = usage, family = 'provider') => record(id, { kind: 'goal_usage_attribution', record: {
  usage_id: `usage-${id}`, usage_family: family, quantity: { ...u, unit: 'tokens', reported: true }, owner: { requester_kind: requester, owner_id: requester === 'reminder' ? 'child' : 'main-root' },
} }, session);
const completed = (id: string, session = 'root', model = 'muse-wonder-full-1.0') => record(id, { kind: 'model_completed', model, usage: { ...usage, cache_read_tokens: 60, cache_write_tokens: 0 } }, session);

it('pairs attribution with completion, unwraps retained frames, and does not add reasoning or cache twice', () => {
  const issue = vi.fn(), parser = museUsageParser('/sessions/root/session.jsonl', issue);
  parser.parse({ retained_frame: 'session_permission_transaction', children: [{ record_json: JSON.stringify(attribution('a')) }] });
  parser.parse(completed('b'));
  parser.parse(completed('b')); // replayed record
  parser.parse({ ...attribution('a'), id: 'another-envelope' }); // same provider attribution
  parser.parse(record('control', { kind: 'context_projection_checkpoint', resume_state: { records: [completed('replayed')] } }));
  const rows = parser.finish();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sessionId: 'root', model: 'muse-wonder-full-1.0', at, input: 40, output: 20, cacheRead: 60, inputIncludesCache: false });
  expect(issue).not.toHaveBeenCalled();
});

it('recognizes metadata-only sessions without claiming an unsupported format', () => {
  const issue = vi.fn(), parser = museUsageParser('/sessions/empty/session.jsonl', issue);
  parser.parse({ ...record('metadata', null, 'empty'), payload_type: 'runtime.session.metadata', payload: { kind: 'metadata', record: { model_id: 'muse-spark-1.3' } } });
  expect(parser.finish()).toEqual([]);
  expect(issue).not.toHaveBeenCalled();
});

it('retains same-count retries but shares reminder identities across parent forwarding and native child journals', () => {
  const parent = museUsageParser('/sessions/root/session.jsonl', vi.fn());
  parent.parse(attribution('forward-1', 'reminder')); parent.parse(attribution('forward-2', 'reminder'));
  const child = museUsageParser('/sessions/root/subagent/child/session.jsonl', vi.fn());
  child.parse(attribution('native-1', 'reminder', 'child')); child.parse(completed('c1', 'child', 'muse-spark-1.3'));
  child.parse(attribution('native-2', 'reminder', 'child')); child.parse(completed('c2', 'child', 'muse-spark-1.3'));
  expect(child.finish().map(row => row.key)).toEqual(parent.finish().map(row => row.key));
  expect(child.finish()).toHaveLength(2);
  expect(child.finish().every(row => row.sessionId === 'root')).toBe(true);
});

it('keeps compaction once and surfaces unreported tokens without fabricating zero-cost requests', () => {
  const issue = vi.fn(), parser = museUsageParser('/sessions/root/session.jsonl', issue);
  parser.parse(attribution('compaction', 'main', 'root', usage, 'compaction'));
  parser.parse(record('summary', { kind: 'context_compaction_installed', summarizer_usage: usage }));
  parser.parse(record('missing', { kind: 'goal_usage_attribution', record: { usage_family: 'provider', quantity: { unit: 'tokens', reported: false } } }));
  expect(parser.finish()).toHaveLength(1);
  expect(parser.finish()[0]?.model).toBe('unknown');
  expect(issue).toHaveBeenCalledWith('incomplete-usage');
});

it('scans only native journals, deduplicates copies and child forwarding, and prices exact catalog IDs only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'muse-usage-')); dirs.push(dir);
  const roots = path.join(dir, 'sessions'), root = path.join(roots, 'root'), child = path.join(root, 'subagent', 'child');
  await mkdir(child, { recursive: true }); await mkdir(path.join(root, '.msp-view-g6'), { recursive: true });
  await mkdir(path.join(dir, 'model-catalog'));
  const main = [attribution('a'), completed('b'), attribution('forward', 'reminder')].map(row => JSON.stringify(row)).join('\n');
  const file = path.join(root, 'session.jsonl'); await writeFile(file, main);
  await writeFile(path.join(root, '.msp-view-g6', 'session.jsonl'), JSON.stringify(completed('fake-copy')));
  await writeFile(path.join(child, 'session.jsonl'), [attribution('native', 'reminder', 'child'), completed('c', 'child', 'muse-spark-1.3')].map(row => JSON.stringify(row)).join('\n'));
  await utimes(file, at / 1000, at / 1000);
  await utimes(path.join(child, 'session.jsonl'), at / 1000, at / 1000);
  await writeFile(path.join(dir, 'model-catalog', 'meta.json'), JSON.stringify({ schema_version: 3, source: 'provider_catalog', rows: [
    { model_id: 'muse-spark-1.3', cost: { currency: 'USD', input: '1.25', output: '4.25', cached: '0.15' } },
    { model_id: 'muse-wonder-1.0', cost: { currency: 'USD', input: '4', output: '20', cached: '0.2' } },
  ] }));
  const prices = await museUsagePrices([roots]);
  expect(estimateUsageUsd(prices, { model: 'muse-wonder-full-1.0', priceProvider: 'muse', input: 40, output: 20, cacheRead: 60, cacheWrite: 0, inputIncludesCache: false })).toBeUndefined();
  const store = new AiUsageStore(path.join(dir, 'ledger')); stores.push(store);
  const scanner = new LocalAgentUsage(store, dir, [{ provider: 'muse', roots: [roots] }, { provider: 'other', roots: [dir], detectOnly: true }], async () => null);
  const focused = await scanner.sync(at - 1, 'muse');
  expect(focused.sources).toHaveLength(1);
  expect(focused.sources[0]).toMatchObject({ status: 'ready', files: 2, records: 2, pricingSource: 'local-model-catalog' });
  expect((await scanner.sync(at - 1)).sources).toHaveLength(2); // A narrow scan cannot satisfy a later full scan.
  const data = store.summary(null, 30, undefined, undefined, 'UTC', { scope: 'device', now: at });
  expect(data.totals).toMatchObject({ requests: 2, inputTokens: 80, outputTokens: 40, cachedTokens: 120, estimatedRequests: 1, unknown: 2, estimatedUsd: '0.000144' });
  expect(data.sessions).toHaveLength(1);
  expect(data.models.map(row => row.model).sort()).toEqual(['muse-spark-1.3', 'muse-wonder-full-1.0']);
  expect(await readFile(file, 'utf8')).toBe(main);
});
