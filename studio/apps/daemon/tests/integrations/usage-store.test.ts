import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiUsageStore, UsageReceiptObserver, usdMicros } from '../../src/integrations/usage-store.js';
import { syncLocalUsageMessages } from '../../src/integrations/usage-local-messages.js';

const stores:AiUsageStore[]=[],dirs:string[]=[];
const store=()=>{const dir=mkdtempSync(path.join(tmpdir(),'fantay-usage-'));dirs.push(dir);const value=new AiUsageStore(dir);stores.push(value);return value;};
afterEach(()=>{stores.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});

it('stores exact microdollars and distinguishes zero from unknown',()=>{
  expect(usdMicros('0.000001')).toBe(1);expect(usdMicros('0')).toBe(0);expect(usdMicros(undefined)).toBeNull();expect(usdMicros('-1')).toBeNull();
  const ledger=store();ledger.begin('a','free','m','chat');ledger.observe('a','free',{tokentosea:{runId:'free-id',chargedUsd:'0.000000'},usage:{prompt_tokens:2,completion_tokens:3}});
  ledger.begin('a','unknown','m','chat');ledger.finish('a','unknown');
  expect(ledger.summary('a').totals).toMatchObject({requests:2,unknown:1,inputTokens:2,outputTokens:3,chargedUsd:'0.000000'});
});
it('keeps native estimates separate from reported and charged money in every scope',()=>{
  const ledger=store();
  ledger.recordLocal({key:'app',provider:'claude',model:'m',context:{},usage:{input_tokens:5},reportedUsd:'0.100000',at:Date.now()});
  ledger.recordLocal({key:'native',provider:'codex',model:'m',context:{},origin:'external',sessionId:'s',usage:{input_tokens:10},estimatedUsd:'0.200000',at:Date.now()});
  expect(ledger.summary(null).totals).toMatchObject({requests:1,estimatedUsd:'0.000000'});
  const device=ledger.summary(null,30,undefined,undefined,'UTC',{scope:'device'});
  expect(device.totals).toMatchObject({requests:2,reportedUsd:'0.100000',chargedUsd:'0.000000',estimatedUsd:'0.200000',estimatedRequests:1,unknown:1});
  expect(device.series[0]?.costUsd).toBe('0.100000');
  expect(ledger.summary(null,30,undefined,undefined,'UTC',{scope:'device',fantaySessions:new Set(['codex:s'])}).totals.requests).toBe(1);
});
it('upserts repeated final receipts and polling without multiplying usage or fees',()=>{
  const ledger=store();ledger.begin('a','key','model','chat',{projectId:'project-a'});
  const receipt={tokentosea:{runId:'run',chargedUsd:'0.123456'},usage:{prompt_tokens:100,completion_tokens:20}};
  ledger.observe('a','key',receipt);ledger.observe('a','key',receipt);ledger.finish('a','key');
  ledger.begin('a','retry','model','chat',{projectId:'project-b'});ledger.observe('a','retry',receipt);
  expect(ledger.summary('a').totals).toMatchObject({requests:1,inputTokens:100,outputTokens:20,chargedUsd:'0.123456'});
  expect(ledger.summary('a',30,'project-b').totals.requests).toBe(0);
});
it('keeps accounts isolated and retains billed generation when local delivery fails',()=>{
  const ledger=store();ledger.begin('a','media','video','official',{projectId:'film'});ledger.observe('a','media',{id:'video-run',status:'succeeded',chargedUsd:'1.250000'});ledger.finish('a','media',true);
  expect(ledger.summary('a',30,'film').totals.chargedUsd).toBe('1.250000');expect(ledger.summary('b').totals.requests).toBe(0);
  ledger.observe('a','media',{id:'video-run',status:'succeeded',chargedUsd:'1.250000',refundedUsd:'0.500000'});ledger.observe('a','media',{refundedUsd:'0.500000'},'video-run');
  expect(ledger.summary('a').totals.refundedUsd).toBe('0.500000');
});
it('observes split SSE frames while preserving cumulative receipt semantics',()=>{
  const ledger=store();ledger.begin('a','stream','m','chat');
  const observer=new UsageReceiptObserver(true,payload=>ledger.observe('a','stream',payload));
  const text='data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"usage":{"prompt_tokens":40,"completion_tokens":8},"tokentosea":{"runId":"stream-id","chargedUsd":"0.010000"}}\n\ndata: [DONE]\n';
  const bytes=new TextEncoder().encode(text);for(let i=0;i<bytes.length;i+=3)observer.push(bytes.subarray(i,i+3));observer.finish();
  expect(ledger.summary('a').totals).toMatchObject({requests:1,inputTokens:40,outputTokens:8,chargedUsd:'0.010000'});
});
it('imports only persisted usage events and deduplicates request ids across message batches',()=>{
  const db=new Database(':memory:'),ledger=store();
  db.exec('CREATE TABLE conversations(id TEXT,project_id TEXT); CREATE TABLE messages(id TEXT,conversation_id TEXT,role TEXT,agent_id TEXT,run_id TEXT,run_status TEXT,created_at INTEGER,events_json TEXT); CREATE TABLE message_event_batches(id INTEGER,message_id TEXT,events_json TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?)').run('conversation','film');
  const event={kind:'request_usage',requestId:'request-1',inputTokens:10,outputTokens:2,cacheReadInputTokens:4};
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)').run('message','conversation','assistant','claude','run','completed',Date.now(),JSON.stringify([event]));
  db.prepare('INSERT INTO message_event_batches VALUES (?,?,?)').run(1,'message',JSON.stringify([event,{kind:'request_usage',requestId:'request-2',usage:{input_tokens:5,output_tokens:3}}]));
  syncLocalUsageMessages(db,ledger,Date.now()-1000,'film');syncLocalUsageMessages(db,ledger,Date.now()-1000,'film');db.close();
  expect(ledger.summary(null).totals).toMatchObject({requests:1,inputTokens:15,outputTokens:5,cachedTokens:4});
});
it('rotates failed reconciliation attempts so later receipts are not starved',()=>{
  const ledger=store();
  for(let i=0;i<21;i++){ledger.begin('a',`key-${i}`,'m','chat');ledger.observe('a',`key-${i}`,{},`run-${i}`);}
  const queued=ledger.pending('a');
  const first=queued.slice(0,20);
  for(const row of first)ledger.markReconciled('a',row.requestKey);
  expect(ledger.pending('a')[0]?.requestKey).toBe(queued[20]?.requestKey);
});
it('buckets a custom local range by hour or day, filters by provider and reports activity',()=>{
  const ledger=store(),now=Date.parse('2026-11-02T12:00:00Z');
  // Asia/Taipei is UTC+8: 2026-11-01T17:30Z is 01:30 on 11-02, 2026-11-01T03:00Z is 11:00 on 11-01.
  ledger.recordLocal({key:'a',provider:'claude',model:'opus',context:{projectId:'film'},usage:{input_tokens:100,output_tokens:10,cache_read_input_tokens:50},reportedUsd:'0.200000',at:Date.parse('2026-11-01T17:30:00Z')});
  ledger.recordLocal({key:'b',provider:'codex',model:'gpt',context:{},usage:{input_tokens:5,output_tokens:5},status:'failed',at:Date.parse('2026-11-01T03:00:00Z')});
  ledger.recordLocal({key:'old',provider:'claude',model:'opus',context:{},usage:{input_tokens:1},at:Date.parse('2026-01-10T03:00:00Z')});
  const day=ledger.summary(null,30,undefined,undefined,'Asia/Taipei',{from:'2026-11-02',to:'2026-11-02',now});
  expect(day).toMatchObject({from:'2026-11-02',to:'2026-11-02',days:1,bucket:'hour'});
  expect(day.series.map(b=>b.start)).toEqual(['2026-11-02T01']);
  expect(day.series[0]).toMatchObject({requests:1,tokens:110,costUsd:'0.200000',groups:{model:{opus:{requests:1}},project:{film:{tokens:110}}}});
  expect(day.hours[1]).toEqual({requests:1,tokens:110,costUsd:'0.200000'});
  const week=ledger.summary(null,7,undefined,undefined,'Asia/Taipei',{now,activity:true});
  expect(week).toMatchObject({from:'2026-10-27',to:'2026-11-02',bucket:'day'});
  expect(week.totals).toMatchObject({requests:2,failed:1,withTokens:2,cachedTokens:50});
  expect(week.availableProviders).toEqual([{provider:'claude',requests:1},{provider:'codex',requests:1}]);
  expect(week.series.map(b=>[b.start,b.failed])).toEqual([['2026-11-01',1],['2026-11-02',0]]);
  expect(week.activity?.days.map(d=>d.day)).toEqual(['2026-01-10','2026-11-01','2026-11-02']);
  const codex=ledger.summary(null,7,undefined,undefined,'Asia/Taipei',{now,provider:'codex',limit:0});
  expect(codex).toMatchObject({provider:'codex',totals:{requests:1},recent:[]});
  expect(codex.availableProviders).toHaveLength(2);
  expect(ledger.summary(null,7,undefined,undefined,'Asia/Taipei',{now}).activity).toBeUndefined();
});
