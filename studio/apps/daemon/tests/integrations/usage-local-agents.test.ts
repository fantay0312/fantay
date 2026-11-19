import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, copyFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AiUsageStore } from '../../src/integrations/usage-store.js';
import { LocalAgentUsage, localUsageSources } from '../../src/integrations/usage-local-agents.js';
import { createUsageLineParser, parseGeminiUsage } from '../../src/integrations/usage-local-parsers.js';
import { estimateUsageUsd, parseUsagePrices } from '../../src/integrations/usage-pricing.js';

const dirs: string[] = [], stores: AiUsageStore[] = [];
afterEach(async () => { stores.splice(0).forEach(s => s.close()); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); vi.useRealTimers(); });
const time = Date.parse('2026-11-14T01:00:00Z');
const token = (input: number, output: number, totalInput = input, totalOutput = output) => ({ type: 'event_msg', timestamp: new Date(time).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput }, last_token_usage: { input_tokens: input, output_tokens: output } } } });

it('counts Codex calls once and prefers last usage across cumulative lane jumps', () => {
  const parse = createUsageLineParser('codex', 's');
  parse({ type: 'turn_context', payload: { model: 'gpt-5' } });
  expect(parse(token(10, 2))?.input).toBe(10);
  expect(parse(token(10, 2))).toBeNull();
  expect(parse(token(3, 1, 300, 30))?.input).toBe(3);
  expect(parse(token(1, 1, 1, 1))?.input).toBe(1);
  expect(parse(token(0, 0, 1, 1))).toBeNull();
  parse({ type: 'token_usage_record', timestamp: new Date(time).toISOString(), payload: { usage: { input_tokens: 7, output_tokens: 3 } } });
  expect(parse(token(0, 0, 1, 1))?.input).toBe(7);
});

it('keeps an unpaired Codex tail identity when its count snapshot arrives later', () => {
  const record={type:'token_usage_record',ordinal:10,timestamp:new Date(time).toISOString(),payload:{usage:{input_tokens:100,output_tokens:20}}};
  const first=createUsageLineParser('codex','s'); first(record);
  const tail=first.finish();
  const second=createUsageLineParser('codex','s'); second(record);
  const paired=second({...token(100,20),ordinal:11});
  expect(paired?.key).toBe(tail?.key);
  expect(paired?.input).toBe(100);
});

it('reads recent OpenCode WAL messages even when the main database mtime is old', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'native-wal-'));dirs.push(dir);
  const file=path.join(dir,'opencode.db'),db=new Database(file);
  db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');
  db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m','s',time,JSON.stringify({role:'assistant',modelID:'test',tokens:{input:10,output:2},cost:0.5}));
  await utimes(file,(time-86400000)/1000,(time-86400000)/1000);
  const store=new AiUsageStore(dir);stores.push(store);
  try {
    const result=await new LocalAgentUsage(store,dir,[{provider:'opencode',roots:[file]}],async()=>null).sync(time-1000);
    expect(result.sources[0]).toMatchObject({status:'ready',records:1});
    expect(store.summary(null,30,undefined,undefined,'UTC',{scope:'device',now:time}).totals.reportedUsd).toBe('0.500000');
  } finally {db.close();}
});

it('defers unproven fork history and marks missing continuation baselines partial', () => {
  const partial = vi.fn(), parse = createUsageLineParser('codex', 's', partial);
  parse({ type: 'session_meta', payload: { id: 'child', forked_from_id: 'parent', history_base: { thread_id: 'parent' } } });
  expect(parse(token(100, 5))).toBeNull(); expect(partial).toHaveBeenCalled();
  const next = createUsageLineParser('codex', 's', partial);
  next({ type: 'session_meta', payload: { id: 's', history_mode: 'paginated' } });
  expect(next({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000 } } } })).toBeNull();
});

it('uses cache-aware exact prices and leaves unknown or complex pricing unavailable', () => {
  const prices = parseUsagePrices({ openai: { models: { 'gpt-5': { cost: { input: 2, output: 10, cache_read: 0.2 } } } } }, time);
  const usage = { model: 'gpt-5', input: 1_000_000, output: 10, cacheRead: 500_000, cacheWrite: 0, inputIncludesCache: true };
  expect(estimateUsageUsd(prices, usage)).toBeCloseTo(1.1001);
  expect(estimateUsageUsd(prices, { ...usage, model: 'unknown' })).toBeUndefined();
  expect(estimateUsageUsd(prices, { ...usage, cacheWrite1h: 1 })).toBeUndefined();
  expect(parseUsagePrices({ openai: { models: { tiered: { cost: { input: 1, output: 2, context_over_200k: {} } } } } }).prices).toEqual({});
});

it('merges Claude snapshots and archive copies, isolates scope, and never saves chat content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'native-usage-')); dirs.push(dir);
  const logs = path.join(dir, 'logs'); await mkdir(logs);
  const file = path.join(logs, 'session.jsonl');
  const message = (output: number) => ({ type: 'assistant', sessionId: 's', requestId: 'r', timestamp: new Date(time).toISOString(), message: { id: 'm', model: 'claude-test', content: 'PRIVATE PROMPT', usage: { input_tokens: 10, output_tokens: output } } });
  await writeFile(file, [message(1), message(4), message(2)].map(v => JSON.stringify(v)).join('\n') + '\n');
  await copyFile(file, path.join(logs, 'archive.jsonl'));
  await utimes(file, time/1000, time/1000); await utimes(path.join(logs,'archive.jsonl'),time/1000,time/1000);
  const store = new AiUsageStore(dir); stores.push(store);
  const scanner = new LocalAgentUsage(store, dir, [{ provider: 'claude', roots: [logs] }], async () => null);
  const scan = await scanner.sync(time - 1000);
  expect(scan.sources[0]).toMatchObject({ status: 'ready', files: 2, records: 1 });
  expect(store.summary(null).totals.requests).toBe(0);
  const device = store.summary(null, 30, undefined, undefined, 'UTC', { scope: 'device', now: time });
  expect(device.totals).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 4, unknown: 1 });
  expect(JSON.stringify(device)).not.toContain('PRIVATE PROMPT');
  expect(store.summary(null, 30, undefined, undefined, 'UTC', { scope: 'device', now: time, fantaySessions: new Set(['claude:s']) }).totals.requests).toBe(0);
  await scanner.sync(time - 1000);
  expect(store.summary(null, 30, undefined, undefined, 'UTC', { scope: 'device', now: time }).totals.requests).toBe(1);
});

it('honors configured homes and includes Gemini thought tokens in output', () => {
  expect(localUsageSources('/home/user', { CODEX_HOME: '/custom/codex', CLAUDE_CONFIG_DIR: '/custom/claude' })[0]?.roots).toContain('/custom/codex/sessions');
  expect(parseGeminiUsage({ sessionId: 's', messages: [{ id: 'm', type: 'gemini', model: 'gemini-test', timestamp: new Date(time).toISOString(), tokens: { input: 10, output: 3, thoughts: 5, cached: 4 } }] }, 's')[0]).toMatchObject({ input: 10, output: 8, cacheRead: 4 });
});
