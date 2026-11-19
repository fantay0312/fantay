import path from 'node:path';
import type { AiUsageLocalSource } from '@open-design/contracts';
import { museUsageParser } from './usage-muse.js';
import { createUsageLineParser, parseGeminiUsage, parseOpenCodeUsage, usageObject as obj, usageIdentity as hash, type NativeUsage } from './usage-local-parsers.js';

export interface LocalUsageParser {
  parse(value: unknown): NativeUsage[];
  finish(): NativeUsage[];
}
const list = (value: NativeUsage | null) => value ? [value] : [];
const str = (v: unknown, fallback = 'unknown') => typeof v === 'string' && v.trim() ? v : fallback;
const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const amount = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
const time = (v: unknown, fallback = NaN) => typeof v === 'number' && v > 0 ? (v < 1e11 ? v * 1000 : v) : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : fallback;
function piCost(value: unknown): number | undefined {
  const cost = obj(value), total = amount(cost.total);
  if (total && total > 0) return total;
  const sum = ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((s,k) => s + (amount(cost[k]) ?? 0), 0);
  return sum > 0 ? sum : undefined;
}

function piParser(flavor: string, fallback: string, modified: number): LocalUsageParser {
  let session = fallback, start = modified;
  const parseCarrier = (row: Record<string, unknown>, message: Record<string, unknown>, usage: Record<string, unknown>, key: string): NativeUsage[] => {
    if (!Object.keys(usage).length) return [];
    const cost = piCost(usage.cost);
    return [{ key: hash(key), provider: flavor, sessionId: session, model: str(message.responseModel ?? message.model), priceProvider: str(message.provider, ''),
      at: time(row.timestamp, time(message.timestamp, start)), input: n(usage.input), output: n(usage.output), cacheRead: n(usage.cacheRead), cacheWrite: n(usage.cacheWrite), inputIncludesCache: false,
      ...(cost === undefined ? {} : { reportedUsd: cost }) }];
  };
  return {
    parse(value) {
      const row = obj(value), message = obj(row.message);
      if (row.type === 'session') { session = str(row.id, session); start = time(row.timestamp, modified); return []; }
      if(flavor==='pi'&&message.role==='toolResult'&&message.toolName==='subagent'){
        const results=obj(message.details).results;
        if(Array.isArray(results))return results.flatMap((raw,index)=>{
          const result=obj(raw);if(result.sessionFile)return [];
          const children=Array.isArray(result.messages)?result.messages.map(obj).filter(m=>m.role==='assistant'&&Object.keys(obj(m.usage)).length):[];
          if(children.length)return children.flatMap((child,i)=>parseCarrier(row,child,obj(child.usage),`pi:subagent:${row.id}:${index}:${str(child.id,String(i))}`));
          const usage=obj(result.usage);if(typeof usage.cost==='number')usage.cost={total:usage.cost};
          return parseCarrier(row,result,usage,`pi:subagent:${row.id}:${index}`);
        });
      }
      const carrier = row.type === 'message' && (message.role === 'assistant' || message.role === 'toolResult') ? message : ['compaction','branch_summary','model_usage'].includes(String(row.type)) ? row : null;
      if (!carrier) return [];
      const key = `${flavor}:${String(row.type)}:${str(row.id, `${row.timestamp}:${JSON.stringify(obj(carrier.usage))}`)}`;
      return parseCarrier(row, carrier, obj(carrier.usage), key);
    }, finish: () => [],
  };
}

function grokParser(session: string): LocalUsageParser {
  let ordinal = 0;
  return { parse(value) {
    const row = obj(value); ordinal++;
    if (row.method !== '_x.ai/session/update') return [];
    const params = obj(row.params), update = obj(params.update);
    if (update.sessionUpdate && update.sessionUpdate !== 'turn_completed') return [];
    const usage = obj(update.usage), models = obj(usage.modelUsage);
    const entries = Object.keys(models).length ? Object.entries(models) : [['unknown', usage]] as Array<[string, unknown]>;
    return entries.flatMap(([model, raw]): NativeUsage[] => {
      const u = obj(raw); if (!Object.keys(u).length) return [];
      const ticks = amount(u.costUsdTicks), cost = ticks && !u.costIsPartial && !usage.costIsPartial ? ticks / 10_000_000_000 : undefined;
      return [{ key: hash(`${session}:${str(update.prompt_id ?? params.prompt_id, String(ordinal))}:${model}`), provider: 'grok', sessionId: session,
        model, priceProvider: 'xai', at: time(row.timestamp), input: n(u.inputTokens), output: n(u.outputTokens), cacheRead: n(u.cachedReadTokens), cacheWrite: 0, inputIncludesCache: true,
        ...(cost === undefined ? {} : { reportedUsd: cost }) }];
    });
  }, finish: () => [] };
}

function dshParser(session: string): LocalUsageParser {
  return { parse(value) {
    const row = obj(value), data = obj(row.data), message = obj(data.message), usage = obj(data.usage), source = obj(message.source);
    if (row.type !== 'assistant/message' || !Object.keys(usage).length) return [];
    const model = str(source.model);
    return [{ key: hash(`dsh:${str(message.id, `${session}:${row.time}:${JSON.stringify(usage)}`)}`), provider: 'deepseek-harness', sessionId: session, model,
      priceProvider: source.provider === 'deepseek-account' ? 'deepseek' : str(source.provider, ''), at: time(row.time), input: n(usage.inputTokens), output: n(usage.outputTokens), cacheRead: n(usage.cacheReadTokens), cacheWrite: n(usage.cacheWriteTokens), inputIncludesCache: false }];
  }, finish: () => [] };
}

function kimiParser(session: string, agent: string): LocalUsageParser {
  const steps = new Map<string, { turn: string; model?: string; at?: number }>();
  const requests = new Map<string, { model: string; at: number }>();
  const messages = new Map<string, NativeUsage>();
  const links = new Map<string, string>();
  return { parse(value) {
    const row = obj(value), event = obj(row.event);
    if (row.type === 'context.append_loop_event' && event.type === 'step.begin') steps.set(str(event.uuid), { turn: `${event.turnId}.${event.step}` });
    if (row.type === 'llm.request' && row.kind === 'loop') requests.set(str(row.turnStep), { model: str(row.model), at: time(row.time) });
    if (row.type === 'context.append_loop_event' && event.type === 'step.end') {
      links.set(str(event.messageId), str(event.uuid));
      if (agent !== 'main' && Object.keys(obj(event.usage)).length) {
        const u = obj(event.usage), id = str(event.messageId, str(event.uuid));
        messages.set(id, { key: hash(`kimi:${agent}:${id}`), provider: 'kimi', sessionId: session, model: 'unknown', at: time(row.time), input: n(u.inputOther), output: n(u.output), cacheRead: n(u.inputCacheRead), cacheWrite: n(u.inputCacheCreation), inputIncludesCache: false });
        links.set(id, str(event.uuid));
      }
    }
    if (['agent.message.appended','human.agent.message.appended'].includes(String(row.type))) {
      const outer = obj(row.message), meta = obj(outer.meta), u = obj(meta.usage);
      if (obj(outer.message).role !== 'assistant' || !Object.keys(u).length) return [];
      const id = str(meta.messageId, `${session}:${row.time}:${JSON.stringify(u)}`), model = obj(meta.model);
      messages.set(id, { key: hash(`kimi:${str(model.provider)}:${id}`), provider: 'kimi', sessionId: session, model: str(model.model) === 'agent-loop' ? 'unknown' : str(model.model), at: time(row.time), input: n(u.inputOther), output: n(u.output), cacheRead: n(u.inputCacheRead), cacheWrite: n(u.inputCacheCreation), inputIncludesCache: false });
    }
    return [];
  }, finish() {
    return [...messages].map(([id,row]) => {
      const step = steps.get(links.get(id) ?? ''), request = step ? requests.get(step.turn) : undefined;
      return request ? { ...row, model: request.model, at: request.at } : row;
    });
  } };
}

function geminiParser(fallbackSession: string): LocalUsageParser {
  let session = fallbackSession;
  const messages = new Map<string, NativeUsage>();
  const collect = (values: unknown[]) => {
    for (const v of values) for(const row of parseGeminiUsage({sessionId:session,messages:[v]},session)) {
      const key = str(obj(v).id), previous = messages.get(key);
      messages.set(key, previous ? { ...row, input: Math.max(previous.input,row.input), output: Math.max(previous.output,row.output), cacheRead: Math.max(previous.cacheRead,row.cacheRead) } : row);
    }
  };
  return { parse(value) {
    const row=obj(value), set=obj(row.$set);
    session=str(row.sessionId ?? set.sessionId,session);
    if(Array.isArray(row.messages))collect(row.messages);
    if(Array.isArray(set.messages))collect(set.messages);
    if(typeof row.id==='string')collect([row]);
    // Rewinds and content patches change the conversation, not tokens already spent.
    return [];
  }, finish:()=>[...messages].map(([id,row])=>({...row,sessionId:session,key:hash(`${session}:${id}`)})) };
}

function copilotParser(session: string): LocalUsageParser {
  let selected = 'unknown';
  return { parse(value) {
    const row=obj(value),data=obj(row.data),u=obj(data.usage);
    if(row.type==='session.start'||row.type==='session.resume')selected=str(data.selectedModel,selected);
    if(row.type==='session.model_change')selected=str(data.newModel,selected);
    if(row.type!=='session.usage_record'||!Object.keys(u).length)return [];
    const identity=row.id??obj(u.accounting).sequence; if(identity===undefined)return [];
    const details=obj(u.copilotUsage).tokenDetails;
    const byType:Record<string,number>={};
    if(Array.isArray(details))for(const raw of details){const d=obj(raw);if(typeof d.tokenType==='string')byType[d.tokenType]=(byType[d.tokenType]??0)+n(d.tokenCount);}
    const detailed=Object.keys(byType).length>0;
    return [{key:hash(`copilot:${session}:${identity}`),provider:'copilot',sessionId:session,model:str(u.model,selected),at:time(row.timestamp),
      input:detailed?(byType.input??0):n(u.inputTokens),output:detailed?(byType.output??0):n(u.outputTokens),cacheRead:detailed?(byType.cache_read??0):n(u.cacheReadTokens),cacheWrite:detailed?(byType.cache_write??0):n(u.cacheWriteTokens),inputIncludesCache:!detailed}];
  },finish:()=>[]};
}

function workbuddyParser(session: string): LocalUsageParser {
  return {parse(value){
    const row=obj(value),p=obj(row.providerData),raw=obj(p.rawUsage),u=obj(p.usage);
    if(row.type==='user'||row.role==='user'||obj(row.message).role==='user')return [];
    const id=p.messageId??row.id; if(id===undefined)return [];
    const model=str(p.model??row.requestModelId).replace(/^custom-[^:]*:/,'');
    let input=0,output=0,cacheRead=0,cacheWrite=0,inputIncludesCache=true;
    if(Object.keys(raw).length){
      input=n(raw.prompt_tokens??raw.input_tokens);output=n(raw.completion_tokens??raw.output_tokens);
      cacheRead=Math.max(n(raw.prompt_cache_hit_tokens),n(raw.cache_read_input_tokens),n(raw.cached_tokens),n(obj(raw.prompt_tokens_details).cached_tokens));
      cacheWrite=Math.max(n(raw.cache_creation_input_tokens),n(raw.prompt_cache_write_tokens));
      inputIncludesCache=raw.prompt_tokens!==undefined||raw.input_tokens===undefined;
    } else {
      if(!Object.keys(u).length)return [];
      input=n(u.inputTokens??u.input_tokens);output=n(u.outputTokens??u.output_tokens);
      const details=u.inputTokensDetails??u.input_tokens_details;
      cacheRead=Array.isArray(details)?details.reduce((sum,v)=>sum+n(obj(v).cached_tokens),0):n(obj(details).cached_tokens);
      cacheWrite=n(u.cacheCreationTokens??u.cache_creation_input_tokens);
    }
    if(input+output+cacheRead+cacheWrite===0)return [];
    const actualSession=str(row.sessionId,session);
    return [{key:hash(`workbuddy:${actualSession}:${String(id)}`),provider:'workbuddy',sessionId:actualSession,model,at:time(row.timestamp),input,output,cacheRead,cacheWrite,inputIncludesCache}];
  },finish:()=>[]};
}

function agyParser(session:string):LocalUsageParser {
  return {parse(value){
    const r=obj(value);
    if(!(r.type==='PLANNER_RESPONSE'&&r.status==='DONE'||r.source==='MODEL')||r.step_index===undefined||r.input_tokens===undefined&&r.output_tokens===undefined)return [];
    return [{key:hash(`agy:${session}:${String(r.step_index)}`),provider:'antigravity',sessionId:session,sourceStep:n(r.step_index),model:str(r.model??r.model_id),at:time(r.created_at),input:n(r.input_tokens),output:n(r.output_tokens),cacheRead:n(r.cache_read_tokens),cacheWrite:n(r.cache_write_tokens),inputIncludesCache:false}];
  },finish:()=>[]};
}

export function devinUsage(value:unknown,session:string):NativeUsage|null {
  const row=obj(value),node=obj(row.node),message=obj(node.message??row.message??value),meta=obj(message.metadata),metrics=obj(meta.metrics);
  if(message.role!=='assistant'||!Object.keys(metrics).length||typeof meta.request_id!=='string')return null;
  return {key:hash(`devin:${meta.request_id}`),provider:'devin',sessionId:session,model:str(meta.generation_model),at:time(meta.created_at),input:n(metrics.input_tokens),output:n(metrics.output_tokens),cacheRead:n(metrics.cache_read_tokens),cacheWrite:n(metrics.cache_creation_tokens),inputIncludesCache:false};
}

/** Adapters share the accounting shape, never a guessed generic token-field search. */
export function localUsageParser(format: string, session: string, onPartial: (reason?: NonNullable<AiUsageLocalSource['issues']>[number]) => void, file = '', modified = NaN): LocalUsageParser {
  if (format === 'muse') return museUsageParser(file, onPartial);
  if (format === 'claude' || format === 'codex') {
    const parse = createUsageLineParser(format, session, onPartial);
    return { parse: value => list(parse(value)), finish: () => list(parse.finish()) };
  }
  if (format === 'opencode') return { parse: value => list(parseOpenCodeUsage(value, session)), finish: () => [] };
  if (format === 'gemini') return geminiParser(session);
  if (format === 'pi' || format === 'omp') return piParser(format, session, modified);
  if (format === 'grok') return grokParser(path.basename(path.dirname(file)) || session);
  if (format === 'dsh') return dshParser(path.basename(path.dirname(file)) || session);
  if (format === 'kimi') return kimiParser(path.basename(path.dirname(path.dirname(path.dirname(file)))) || session, path.basename(path.dirname(file)));
  if (format === 'copilot') return copilotParser(path.basename(path.dirname(file)) || session);
  if (format === 'workbuddy') return workbuddyParser(session);
  if (format === 'agy') return agyParser(file ? path.basename(path.dirname(path.dirname(path.dirname(file)))) : session);
  if (format === 'devin') return {parse:value=>list(devinUsage(value,path.basename(path.dirname(file))||session)),finish:()=>[]};
  onPartial();
  return { parse: () => [], finish: () => [] };
}

export function localUsageDocument(format: string, value: unknown, session: string, onPartial: () => void, file = '', modified = NaN): NativeUsage[] {
  if(format==='droid'){
    const root=obj(value),u=obj(root.tokenUsage);
    if(!Object.keys(u).length)return [];
    return [{key:hash(`droid:${session}`),provider:'droid',sessionId:session,granularity:'session',model:str(root.model),at:modified,input:n(u.inputTokens),output:n(u.outputTokens),cacheRead:n(u.cacheReadTokens),cacheWrite:n(u.cacheCreationTokens),inputIncludesCache:false}];
  }
  if(format==='cline'){
    const root=obj(value);if(!Array.isArray(root.messages))return [];
    return root.messages.flatMap((raw,index):NativeUsage[]=>{
      const m=obj(raw),u=obj(m.metrics),at=time(m.ts);
      if(m.role!=='assistant'||!Object.keys(u).length||at<time(root.__forkCutoff,0))return [];
      return [{key:hash(`cline:${session}:${str(m.id,`${m.ts}:${index}`)}`),provider:'cline',sessionId:session,model:str(obj(m.modelInfo).id),at,input:n(u.inputTokens),output:n(u.outputTokens),cacheRead:n(u.cacheReadTokens),cacheWrite:n(u.cacheWriteTokens),inputIncludesCache:true}];
    });
  }
  const parser = localUsageParser(format, session, onPartial,file,modified);
  return [...parser.parse(value), ...parser.finish()];
}
