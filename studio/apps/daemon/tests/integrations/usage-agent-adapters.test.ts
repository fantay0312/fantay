import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { localUsageParser, localUsageDocument } from '../../src/integrations/usage-agent-parsers.js';
import { readLocalUsageDatabase } from '../../src/integrations/usage-agent-databases.js';
import { localUsageSources, LocalAgentUsage } from '../../src/integrations/usage-local-agents.js';
import { discoverUsageSources } from '../../src/integrations/usage-source-discovery.js';
import { AiUsageStore } from '../../src/integrations/usage-store.js';

const at=Date.parse('2026-11-14T00:00:00Z'),iso=new Date(at).toISOString(),dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function directory(){const p=await mkdtemp(path.join(tmpdir(),'agent-adapters-'));dirs.push(p);return p;}
function parse(format:string,values:unknown[],file='/fixture/s/log.jsonl'){
  const parser=localUsageParser(format,'s',()=>{},file,at);
  return [...values.flatMap(value=>parser.parse(value)),...parser.finish()];
}

it('counts independent Grok turns and model splits without adding the top-level total',()=>{
  const event=(id:string)=>({timestamp:at,method:'_x.ai/session/update',params:{update:{sessionUpdate:'turn_completed',prompt_id:id,usage:{inputTokens:999,modelUsage:{'grok-test':{inputTokens:100,outputTokens:20,cachedReadTokens:40,costUsdTicks:1e8}}}}}});
  const rows=parse('grok',[event('p1'),event('p2')]);
  expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({input:100,output:20,cacheRead:40,reportedUsd:0.01,inputIncludesCache:true});expect(rows[0]?.key).not.toBe(rows[1]?.key);
});

it('uses global Pi entry identities across forked sessions and reads OMP model_usage',()=>{
  const entry={type:'message',id:'m1',timestamp:iso,message:{role:'assistant',provider:'anthropic',model:'m',usage:{input:10,output:20,cacheRead:30,cacheWrite:40,cost:{total:0.01}}}};
  const first=parse('pi',[{type:'session',id:'one'},entry]),fork=parse('pi',[{type:'session',id:'two'},entry]);
  expect(first[0]?.key).toBe(fork[0]?.key);expect(first[0]).toMatchObject({input:10,inputIncludesCache:false,reportedUsd:0.01});
  expect(parse('omp',[{type:'model_usage',id:'judge',timestamp:at,model:'judge',usage:{input:3,output:1}}])[0]?.model).toBe('judge');
});

it('reads DSH usage and Kimi request-to-message model attribution',()=>{
  expect(parse('dsh',[{type:'assistant/message',time:at,data:{message:{id:'m',source:{provider:'deepseek-account',model:'global:deepseek-test'}},usage:{inputTokens:10,outputTokens:20,cacheReadTokens:30,cacheWriteTokens:40}}}])[0]).toMatchObject({input:10,output:20,priceProvider:'deepseek'});
  const rows=parse('kimi',[
    {type:'context.append_loop_event',event:{type:'step.begin',uuid:'step1',turnId:'0',step:1}},
    {type:'llm.request',kind:'loop',turnStep:'0.1',model:'kimi-test',time:at},
    {type:'agent.message.appended',time:at+20,message:{message:{role:'assistant'},meta:{messageId:'m',model:{provider:'agent-loop',model:'agent-loop'},usage:{inputOther:10,output:20,inputCacheRead:30,inputCacheCreation:40}}}},
    {type:'context.append_loop_event',event:{type:'step.end',uuid:'step1',messageId:'m'}},
  ],'/fixture/s/agents/main/wire.jsonl');
  expect(rows[0]).toMatchObject({model:'kimi-test',at,input:10,cacheRead:30});
});

it('keeps Copilot input semantics and does not turn WorkBuddy credits into USD',()=>{
  expect(parse('copilot',[{type:'session.usage_record',id:'e',timestamp:iso,data:{usage:{model:'m',inputTokens:120,outputTokens:20,cacheReadTokens:100}}}])[0]).toMatchObject({input:120,cacheRead:100,inputIncludesCache:true});
  expect(parse('copilot',[{type:'session.usage_record',id:'e',timestamp:iso,data:{usage:{model:'m',copilotUsage:{tokenDetails:[{tokenType:'input',tokenCount:20},{tokenType:'cache_read',tokenCount:100}]}}}}])[0]).toMatchObject({input:20,cacheRead:100,inputIncludesCache:false});
  const row=parse('workbuddy',[{id:'e',sessionId:'s',timestamp:at,type:'function_call',providerData:{model:'custom-provider:m',messageId:'r',rawUsage:{prompt_tokens:120,completion_tokens:20,prompt_cache_hit_tokens:100,credit:0.5}}}])[0];
  expect(row).toMatchObject({model:'m',input:120,output:20,cacheRead:100});expect(row?.reportedUsd).toBeUndefined();
  const anthropic=parse('workbuddy',[{id:'a',timestamp:at,providerData:{model:'claude-test',rawUsage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:20}}}])[0];
  expect(anthropic).toMatchObject({input:10,cacheRead:100,cacheWrite:20,inputIncludesCache:false});
});

it('reads Gemini JSONL snapshots once and preserves already-spent usage after a rewind',()=>{
  const m={id:'m',type:'gemini',model:'gemini-test',timestamp:iso,tokens:{input:100,output:10,cached:40,thoughts:5}};
  const rows=parse('gemini',[{sessionId:'s'},m,{...m,tokens:{...m.tokens,output:20}},{$rewindTo:'m'},{$patch:{removeIds:['m']}}]);
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({input:100,output:25,cacheRead:40});
});

it('reads agy and Devin metadata without needing content, and marks Droid as a session summary',()=>{
  expect(parse('agy',[{step_index:1,type:'PLANNER_RESPONSE',status:'DONE',created_at:iso,input_tokens:20,output_tokens:10,cache_read_tokens:100}],'/brain/s/.system_generated/logs/transcript_full.jsonl')[0]).toMatchObject({sessionId:'s',model:'unknown',input:20,cacheRead:100});
  expect(parse('devin',[{kind:'node',node:{message:{role:'assistant',metadata:{request_id:'r',generation_model:'m',created_at:iso,metrics:{input_tokens:10,output_tokens:20}}}}}])[0]).toMatchObject({model:'m',input:10});
  expect(localUsageDocument('droid',{model:'m',tokenUsage:{inputTokens:100,outputTokens:20}},'s',()=>{},'',at)[0]).toMatchObject({granularity:'session',at,input:100});
  const cline=localUsageDocument('cline',{__forkCutoff:iso,messages:[{role:'assistant',ts:at-1000,modelInfo:{id:'m'},metrics:{inputTokens:900}},{role:'assistant',ts:at+1000,modelInfo:{id:'m'},metrics:{inputTokens:10}}]},'s',()=>{});
  expect(cline).toHaveLength(1);expect(cline[0]?.input).toBe(10);
});

it('discovers alternate homes, CC Switch overrides and supported families without reading credentials',async()=>{
  const home=await directory();
  for(const p of ['.claude/projects','.claude-profiles/work/projects','.codex-profiles/work/sessions','.cc-switch','.pi/agent'])await mkdir(path.join(home,p),{recursive:true});
  const extra=path.join(home,'custom');await mkdir(path.join(extra,'projects'),{recursive:true});
  await writeFile(path.join(home,'.cc-switch/settings.json'),JSON.stringify({claudeConfigDir:extra}));
  const sources=await discoverUsageSources(localUsageSources(home,{}),home,{});
  expect(sources.find(s=>s.provider==='claude')?.roots).toEqual(expect.arrayContaining([await realpath(path.join(extra,'projects')),await realpath(path.join(home,'.claude-profiles/work/projects'))]));
  expect(sources.map(s=>s.provider)).toEqual(expect.arrayContaining(['grok','pi','omp','mcode','deepseek-harness','kimi','copilot','antigravity','antigravity-ide','devin','hermes','droid','cline','cursor-agent']));
  expect(sources.find(s=>s.provider==='cursor-agent')?.detectOnly).toBe(true);
});

it('marks detected Cursor as unsupported rather than inventing a zero-cost log',async()=>{
  const home=await directory(),cursor=path.join(home,'cursor');await mkdir(cursor);
  const store=new AiUsageStore(home);
  try {const scan=await new LocalAgentUsage(store,home,[{provider:'cursor-agent',roots:[cursor],detectOnly:true}],async()=>null).sync(0);expect(scan.sources[0]).toMatchObject({status:'unsupported',records:0});}finally{store.close();}
});

it('reads OpenCode V2 compaction and MCode zero reported cost',async()=>{
  const dir=await directory(),file=path.join(dir,'test.db'),db=new Database(file);
  db.exec('CREATE TABLE session_v2(id TEXT); CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE local_runtime_token_usage(id INTEGER,session_id TEXT,model TEXT,ts INTEGER,input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,cost_usd REAL)');
  const insert=db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)');
  insert.run('m','s','assistant',1,at,JSON.stringify({model:{id:'m'},time:{completed:at},tokens:{input:10,output:20,reasoning:3}}));
  insert.run('c','s','compaction',2,at,JSON.stringify({status:'failed',model:{id:'m'},tokens:{input:2,output:1}}));
  insert.run('p','s','compaction',3,at,JSON.stringify({status:'pending',tokens:{input:999}}));
  db.prepare('INSERT INTO local_runtime_token_usage VALUES(?,?,?,?,?,?,?,?,?,?)').run(1,'s','custom/vendor/model',at,10,20,3,30,40,0);db.close();
  expect(readLocalUsageDatabase(file,'opencode',0,()=>{})).toHaveLength(2);
  expect(readLocalUsageDatabase(file,'mcode',0,()=>{})[0]).toMatchObject({model:'vendor/model',output:23,reportedUsd:0});
});

it('keeps session-only totals visible without inventing request counts',async()=>{
  const dir=await directory(),store=new AiUsageStore(dir);
  try{store.recordLocal({key:'s',provider:'droid',model:'m',origin:'external',granularity:'session',context:{},usage:{input_tokens:100},at});
    expect(store.summary(null,30,undefined,undefined,'UTC',{now:at,scope:'device'}).totals).toMatchObject({requests:0,sessionRecords:1,inputTokens:100});
  }finally{store.close();}
});

it('reads Antigravity plaintext usage protobuf and deduplicates vendor response IDs',async()=>{
  const dir=await directory(),file=path.join(dir,'session.db'),db=new Database(file);
  const integer=(n:number)=>{const bytes:number[]=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes);};
  const field=(id:number,value:number|Buffer|string):Buffer=>typeof value==='number'?Buffer.concat([integer(id*8),integer(value)]):Buffer.concat([integer(id*8+2),integer(Buffer.byteLength(value)),Buffer.from(value)]);
  db.exec('CREATE TABLE steps(idx INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');
  db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0,field(1,field(19,'gemini-test')));
  const metadata=(output:number)=>Buffer.concat([field(1,field(1,at/1000)),field(9,Buffer.concat([field(2,10),field(3,output),field(4,3),field(5,5),field(11,'response')])),field(20,field(3,0))]);
  db.prepare('INSERT INTO steps VALUES(?,?)').run(1,metadata(10));db.prepare('INSERT INTO steps VALUES(?,?)').run(2,metadata(20));db.close();
  const rows=readLocalUsageDatabase(file,'antigravity-db',0,()=>{});
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({input:10,output:20,cacheRead:5,cacheWrite:3,model:'gemini-test',at});
});

it('excludes Alma incognito and scheduled chats from local imports',async()=>{
  const dir=await directory(),file=path.join(dir,'alma.db'),db=new Database(file);
  db.exec('CREATE TABLE chat_threads(id TEXT,is_incognito INTEGER,metadata TEXT,title TEXT); CREATE TABLE usage_records(thread_id TEXT,model TEXT,provider_id TEXT,timestamp TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER,cache_write_input_tokens INTEGER)');
  const thread=db.prepare('INSERT INTO chat_threads VALUES(?,?,?,?)'),usage=db.prepare('INSERT INTO usage_records VALUES(?,?,?,?,?,?,?,?)');
  for(const [id,privateMode,meta,title] of [['normal',0,'{}','Normal'],['private',1,'{}','Secret'],['cron',0,'{"isCron":true}','Scheduled']] as const){thread.run(id,privateMode,meta,title);usage.run(id,'m','p',iso,100,20,40,0);}
  db.close();expect(readLocalUsageDatabase(file,'alma',0,()=>{}).map(r=>r.sessionId)).toEqual(['normal']);
});

it('keeps Hermes auxiliary usage in addition to the unassigned main-loop remainder',async()=>{
  const dir=await directory(),file=path.join(dir,'hermes.db'),db=new Database(file);
  db.exec('CREATE TABLE sessions(id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,api_call_count INTEGER,last_activity_at REAL); CREATE TABLE session_model_usage(session_id TEXT,model TEXT,task TEXT,input_tokens INTEGER,output_tokens INTEGER,api_call_count INTEGER,last_seen REAL)');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('s','m',50,5,5,at/1000);
  db.prepare('INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?)').run('s','m','',30,3,3,at/1000);
  db.prepare('INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?)').run('s','m','title',10,1,1,at/1000);db.close();
  const rows=readLocalUsageDatabase(file,'hermes',0,()=>{});
  expect(rows.reduce((sum,r)=>sum+r.input,0)).toBe(60);expect(rows.reduce((sum,r)=>sum+(r.requestCount??0),0)).toBe(6);expect(rows.every(r=>r.granularity==='session')).toBe(true);
});

it('clears a stored Hermes remainder when model attribution catches up',async()=>{
  const dir=await directory(),file=path.join(dir,'hermes.db'),db=new Database(file),store=new AiUsageStore(dir);
  db.exec('CREATE TABLE sessions(id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,api_call_count INTEGER,last_activity_at REAL); CREATE TABLE session_model_usage(session_id TEXT,model TEXT,task TEXT,input_tokens INTEGER,output_tokens INTEGER,api_call_count INTEGER,last_seen REAL)');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('s','m',50,5,5,at/1000);
  const sync=()=>{for(const row of readLocalUsageDatabase(file,'hermes',0,()=>{}))store.recordLocal({key:row.key,provider:'hermes',model:row.model,origin:'external',granularity:'session',requestCount:row.requestCount??0,context:{},at:row.at,usage:{input_tokens:row.input,output_tokens:row.output}});};
  try{sync();db.prepare('INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?)').run('s','m','',50,5,5,at/1000);sync();expect(store.summary(null,30,undefined,undefined,'UTC',{scope:'device',now:at}).totals).toMatchObject({inputTokens:50,outputTokens:5,requests:5});}
  finally{store.close();db.close();}
});

it('filters database history by time before the cap and reports truncation',async()=>{
  const dir=await directory(),file=path.join(dir,'devin.db'),db=new Database(file);
  db.exec('CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY,session_id TEXT,chat_message TEXT)');
  const insert=db.prepare('INSERT INTO message_nodes(session_id,chat_message) VALUES(?,?)');
  for(let i=0;i<5;i++)insert.run('s',JSON.stringify({role:'assistant',metadata:{request_id:`old-${i}`,created_at:'2020-01-01T00:00:00Z',metrics:{input_tokens:999}}}));
  insert.run('s',JSON.stringify({role:'assistant',metadata:{request_id:'new',created_at:iso,metrics:{input_tokens:10}}}));
  let capped=false;expect(readLocalUsageDatabase(file,'devin',at,()=>{capped=true;},2)).toHaveLength(1);expect(capped).toBe(false);
  for(let i=0;i<3;i++)insert.run('s',JSON.stringify({role:'assistant',metadata:{request_id:`new-${i}`,created_at:iso,metrics:{input_tokens:10}}}));
  expect(readLocalUsageDatabase(file,'devin',at,()=>{capped=true;},2)).toHaveLength(2);expect(capped).toBe(true);db.close();
});
