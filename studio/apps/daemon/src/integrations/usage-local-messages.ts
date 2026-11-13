import type Database from 'better-sqlite3';
import type { AiUsageStore } from './usage-store.js';

type Value = Record<string,unknown>;
const object=(v:unknown):Value=>v&&typeof v==='object'&&!Array.isArray(v)?v as Value:{};
const normalizedUsage=(v:Value):Value=>Object.fromEntries(Object.entries({
  input_tokens:v.input_tokens??v.prompt_tokens??v.inputTokens,
  output_tokens:v.output_tokens??v.completion_tokens??v.outputTokens,
  cache_read_input_tokens:v.cache_read_input_tokens??v.cached_tokens??v.cacheReadInputTokens,
}).filter(([,value])=>value!==undefined&&value!==null));

/** Read only usage events in SQLite; never load chat content or tool output. */
export function syncLocalUsageMessages(db: Database.Database, store: AiUsageStore, since: number, projectId?: string) {
  const hasBatches=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_event_batches'").get());
  const scope="m.role='assistant' AND m.agent_id NOT IN ('tokentosea','amr') AND (? IS NULL OR c.project_id=?) AND (CASE WHEN typeof(m.created_at) IN ('integer','real') THEN m.created_at ELSE CAST(strftime('%s',m.created_at) AS INTEGER)*1000 END)>=?";
  const base=`SELECT m.id,c.project_id AS projectId,m.agent_id AS agentId,m.run_id AS runId,m.run_status AS status,m.created_at AS createdAt,m.events_json AS events,0 AS batch FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE ${scope}`;
  const batches=hasBatches?` UNION ALL SELECT m.id,c.project_id,m.agent_id,m.run_id,m.run_status,m.created_at,b.events_json,b.id FROM message_event_batches b JOIN messages m ON m.id=b.message_id JOIN conversations c ON c.id=m.conversation_id WHERE ${scope}`:'';
  const sql=`WITH logs AS (${base}${batches}) SELECT logs.id,projectId,agentId,runId,status,createdAt,j.value AS event FROM logs LEFT JOIN json_each(CASE WHEN json_valid(events) THEN events ELSE '[]' END) j ON j.type='object' AND (json_extract(j.value,'$.kind') IN ('usage','request_usage') OR json_extract(j.value,'$.type') IN ('usage','request_usage') OR json_extract(j.value,'$.data.type') IN ('usage','request_usage')) ORDER BY logs.id,batch,CAST(j.key AS INTEGER)`;
  const params=[projectId??null,projectId??null,since];
  const rows=db.prepare(sql).all(...params,...(hasBatches?params:[])) as Array<{id:string;projectId:string;agentId:string;runId?:string;status?:string;createdAt:number|string;event:string}>;
  const groups=new Map<string,typeof rows>();
  for(const row of rows){
    const list=groups.get(row.id);
    if(list)list.push(row);else groups.set(row.id,[row]);
  }
  store.transaction(()=>{
    for(const [id,events] of groups){
      const first=events[0]!;const requests=new Map<string,Value>();let fallback:Value={},cost:unknown,model=first.agentId;
      for(const row of events){
        let event:Value;try{event=object(JSON.parse(row.event));}catch{continue;}
        const data=event.event==='agent'?object(event.data):event;
        const kind=data.kind??data.type;
        const usage=normalizedUsage(Object.keys(object(data.usage)).length?object(data.usage):data);
        if(kind==='request_usage'&&typeof data.requestId==='string')requests.set(data.requestId,{...requests.get(data.requestId),...usage});
        else if(kind==='usage')fallback={...fallback,...Object.fromEntries(Object.entries(usage).filter(([,v])=>v!==undefined&&v!==null))};
        if(typeof data.costUsd==='number'||typeof data.costUsd==='string')cost=data.costUsd;
        if(typeof data.model==='string'&&data.model)model=data.model;
      }
      let usage=fallback;
      if(requests.size){usage={};for(const record of requests.values())for(const key of ['input_tokens','output_tokens','prompt_tokens','completion_tokens','cache_read_input_tokens'])if(typeof record[key]==='number')usage[key]=Number(usage[key]??0)+Number(record[key]);}
      const at=typeof first.createdAt==='number'?first.createdAt:Date.parse(first.createdAt);
      if(!Number.isFinite(at))continue;
      store.recordLocal({key:`message:${id}`,provider:first.agentId??'local-cli',model:model??'unknown',context:{projectId:first.projectId,...first.runId?{localRunId:first.runId}:{}},usage,reportedUsd:cost,status:first.status??'completed',at});
    }
  });
}
