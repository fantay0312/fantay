import Database from 'better-sqlite3';
import path from 'node:path';
import { parseOpenCodeUsage, usageIdentity as hash, type NativeUsage } from './usage-local-parsers.js';
import { usageObject as obj } from './usage-local-parsers.js';
import { readAntigravityUsage } from './usage-antigravity.js';
import { devinUsage } from './usage-agent-parsers.js';

type Row = Record<string, unknown>;
const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

/** Read-only connections include live WAL data and never depend on the main file's mtime. */
export function readLocalUsageDatabase(file: string, format: string, since: number, onLimit: () => void, limit = 100_000): NativeUsage[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const output: NativeUsage[] = [];
  try {
    const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const columns = (name:string) => new Set((db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>).map(r=>r.name));
    if(format==='antigravity-db')return readAntigravityUsage(db,path.basename(file,'.db'),since);
    if(format==='devin'){
      let scanned=0;
      for(const r of db.prepare(`SELECT session_id,chat_message FROM message_nodes WHERE json_valid(chat_message) AND json_extract(chat_message,'$.role')='assistant' AND julianday(json_extract(chat_message,'$.metadata.created_at'))>=julianday(?,'unixepoch') ORDER BY row_id DESC LIMIT ?`).iterate(since/1000,limit+1) as Iterable<Row>){if(scanned++>=limit){onLimit();break;}const parsed=devinUsage(JSON.parse(String(r.chat_message)),String(r.session_id));if(parsed&&parsed.at>=since)output.push(parsed);}
      return output;
    }
    if(format==='alma'){
      const threadColumns=columns('chat_threads');
      const filters=[threadColumns.has('is_incognito')?'COALESCE(t.is_incognito,0)=0':'1',threadColumns.has('metadata')?"COALESCE(json_extract(CASE WHEN json_valid(t.metadata) THEN t.metadata END,'$.isCron'),0)=0":'1',threadColumns.has('title')?"instr(COALESCE(t.title,''),'⏰ Cron:')<>1":'1'];
      let scanned=0;
      for(const name of ['usage_records','aux_usage_records'])if(table(name))for(const r of db.prepare(`SELECT u.rowid AS row_id,u.thread_id,u.model,u.provider_id,u.timestamp,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.cache_write_input_tokens FROM ${name} u JOIN chat_threads t ON t.id=u.thread_id WHERE ${filters.join(' AND ')} AND julianday(u.timestamp)>=julianday(?,'unixepoch') ORDER BY u.timestamp DESC LIMIT ?`).iterate(since/1000,limit+1) as Iterable<Row>){
        if(scanned++>=limit){onLimit();break;}
        const at=Date.parse(String(r.timestamp));if(!Number.isFinite(at)||at<since)continue;
        output.push({key:hash(`alma:${name}:${r.thread_id}:${r.row_id}`),provider:'alma',sessionId:String(r.thread_id),model:String(r.model??'unknown'),priceProvider:String(r.provider_id??''),at,input:n(r.input_tokens),output:n(r.output_tokens),cacheRead:n(r.cached_input_tokens),cacheWrite:n(r.cache_write_input_tokens),inputIncludesCache:true});
      }
      return output;
    }
    if(format==='hermes'){
      const prefix=hash(path.resolve(file)).slice(0,16), seen=new Map<string,NativeUsage[]>();
      const sessionColumns=columns('sessions');
      const clockFields=['last_activity_at','ended_at','started_at'].filter(f=>sessionColumns.has(f));
      const sessionClock=clockFields.length?`COALESCE(${clockFields.map(f=>`NULLIF(${f},0)`).concat('0').join(',')})`:'0';
      let incomplete=false,scanned=0;
      const toUsage=(r:Row,key:string):NativeUsage=>{
        const epoch=Number(r.last_seen)||Number(r.last_activity_at)||Number(r.ended_at)||Number(r.started_at);
        return {key:hash(`hermes:${prefix}:${key}`),provider:'hermes',sessionId:`${prefix}:${r.session_id??r.id}`,granularity:'session',requestCount:n(r.api_call_count),model:String(r.model??'unknown'),priceProvider:String(r.billing_provider??''),at:epoch<1e11?epoch*1000:epoch,input:n(r.input_tokens),output:n(r.output_tokens),cacheRead:n(r.cache_read_tokens),cacheWrite:n(r.cache_write_tokens),inputIncludesCache:false};
      };
      const fields=['session_id','model','billing_provider','task','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','api_call_count','last_seen'];
      if(table('session_model_usage')){
        const known=columns('session_model_usage');
        const relevant=`${known.has('last_seen')?'last_seen':'0'}>=?${table('sessions')?` OR session_id IN (SELECT id FROM sessions WHERE ${sessionClock}>=?)`:''}`;
        for(const r of db.prepare(`SELECT ${fields.map(f=>known.has(f)?f:`${['model','billing_provider','task'].includes(f)?"''":'0'} AS ${f}`).join(',')} FROM session_model_usage WHERE ${relevant} ORDER BY ${known.has('last_seen')?'last_seen':'session_id'} DESC LIMIT ?`).iterate(...(table('sessions')?[since/1000,since/1000,limit+1]:[since/1000,limit+1])) as Iterable<Row>){
          if(scanned++>=limit){incomplete=true;onLimit();break;}
          const row=toUsage(r,`${r.session_id}:${r.model}:${r.billing_provider}:${r.task}`);if(row.at>=since)output.push(row);
          if(!r.task){const list=seen.get(String(r.session_id))??[];list.push(row);seen.set(String(r.session_id),list);}
        }
      }
      if(table('sessions')){
        const known=columns('sessions'),fields=['id','model','billing_provider','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','api_call_count','last_activity_at','ended_at','started_at'];
        let count=0;
        for(const r of db.prepare(`SELECT ${fields.map(f=>known.has(f)?f:`${['model','billing_provider','id'].includes(f)?"''":'0'} AS ${f}`).join(',')} FROM sessions WHERE ${sessionClock}>=? ORDER BY ${sessionClock} DESC LIMIT ?`).iterate(since/1000,limit+1) as Iterable<Row>){
          if(count++>=limit){onLimit();break;}
          const row=toUsage(r,`${r.id}:residual`);for(const previous of seen.get(String(r.id))??[]){row.input=Math.max(0,row.input-previous.input);row.output=Math.max(0,row.output-previous.output);row.cacheRead=Math.max(0,row.cacheRead-previous.cacheRead);row.cacheWrite=Math.max(0,row.cacheWrite-previous.cacheWrite);row.requestCount=Math.max(0,(row.requestCount??0)-(previous.requestCount??0));}
          if(incomplete){row.input=0;row.output=0;row.cacheRead=0;row.cacheWrite=0;row.requestCount=0;}
          // A zero residual is a tombstone for a previous partial attribution.
          if(row.at>=since)output.push(row);
        }
      }
      return output;
    }
    if (format === 'opencode' || format==='zcode') {
      const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const v2 = table('session_v2') && table('session_message');
      if(v2) for(const r of db.prepare("SELECT id,session_id,type,time_created,data FROM session_message WHERE type IN ('assistant','compaction') AND json_valid(data) AND time_created>=? ORDER BY session_id,seq LIMIT 100001").iterate(since) as Iterable<Row>) {
        if(output.length>=100_000){onLimit();break;}
        const data=obj(JSON.parse(String(r.data))), time=obj(data.time);
        if(r.type==='assistant' && !time.completed || r.type==='compaction' && !['completed','failed'].includes(String(data.status)))continue;
        const parsed=parseOpenCodeUsage({...data,role:'assistant',id:r.id,sessionID:r.session_id,time:{...time,created:r.time_created}},String(r.id));
        if(parsed && parsed.input+parsed.output+parsed.cacheRead+parsed.cacheWrite>0){
          if(format==='zcode'){parsed.inputIncludesCache=true;parsed.output=n(obj(data.tokens).output);const origin=obj(obj(data.metadata).forkOrigin).messageId;if(typeof origin==='string'&&db.prepare('SELECT 1 FROM session_message WHERE id=?').get(origin))continue;}
          output.push({...parsed,...(data.status==='failed'?{status:'failed'}:{})});
        }
      }
      let migrated=false;
      if(v2&&table('kv')){const state=db.prepare("SELECT value FROM kv WHERE key='migration.v1-v2'").get() as {value?:string}|undefined;try{migrated=JSON.parse(state?.value??'{}').phase==='completed';}catch{}}
      if(migrated||!table('message'))return output;
      const scope=v2?' AND session_id NOT IN (SELECT id FROM session_v2)':'';
      for (const r of db.prepare(`SELECT id, session_id, time_created, data FROM message WHERE json_valid(data) AND json_extract(data,'$.role')='assistant' AND time_created>=?${scope} LIMIT 100001`).iterate(since) as Iterable<Row>) {
        if (output.length >= 100_000) { onLimit(); break; }
        const value = parseOpenCodeUsage({ ...JSON.parse(String(r.data)), id: r.id, sessionID: r.session_id, time: { created: r.time_created } }, String(r.id));
        if (value) {
          if(format==='zcode'){const raw=JSON.parse(String(r.data)),origin=obj(obj(raw.metadata).forkOrigin).messageId;if(typeof origin==='string'&&db.prepare('SELECT 1 FROM message WHERE id=?').get(origin))continue;value.inputIncludesCache=true;value.output=n(obj(raw.tokens).output);}
          output.push(value);
        }
      }
      return output;
    }
    if (format === 'mcode') {
      for (const r of db.prepare('SELECT id, session_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd FROM local_runtime_token_usage WHERE ts >= ? LIMIT 100001').iterate(since) as Iterable<Row>) {
        if (output.length >= 100_000) { onLimit(); break; }
        let model = typeof r.model === 'string' ? r.model : 'unknown';
        if (model.includes('/')) model = model.slice(model.indexOf('/') + 1);
        const reportedUsd = typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) && r.cost_usd >= 0 ? r.cost_usd : undefined;
        output.push({ key: hash(`mcode:${r.session_id}:${r.id}`), provider: 'mcode', sessionId: String(r.session_id), model, at: Number(r.ts),
          input: n(r.input_tokens), output: n(r.output_tokens) + n(r.reasoning_tokens), cacheRead: n(r.cache_read_tokens), cacheWrite: n(r.cache_write_tokens), inputIncludesCache: false,
          ...(reportedUsd === undefined ? {} : { reportedUsd }) });
      }
      return output;
    }
    throw new Error('Unsupported local usage database');
  } finally { db.close(); }
}
