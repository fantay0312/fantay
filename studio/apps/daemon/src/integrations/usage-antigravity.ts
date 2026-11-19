import type Database from 'better-sqlite3';
import { usageIdentity, type NativeUsage } from './usage-local-parsers.js';

type Field = number | Buffer;
/** Minimal protobuf wire reader for public statistics fields; encrypted chat content is never selected. */
function fields(bytes: Buffer): Map<number, Field> {
  if(bytes.length>64*1024*1024)throw new Error('Oversize usage metadata');
  const out=new Map<number,Field>();let at=0;
  const varint=()=>{let value=0,factor=1;for(let i=0;i<10&&at<bytes.length;i++){const b=bytes[at++]!;value+=(b&127)*factor;if(!(b&128)){if(!Number.isSafeInteger(value))throw new Error('Unsafe protobuf integer');return value;}factor*=128;}throw new Error('Invalid protobuf integer');};
  while(at<bytes.length){
    const tag=varint(),field=Math.floor(tag/8),wire=tag%8;
    if(wire===0)out.set(field,varint());
    else if(wire===2){const size=varint();if(at+size>bytes.length)throw new Error('Truncated protobuf');out.set(field,bytes.subarray(at,at+size));at+=size;}
    else if(wire===1)at+=8;else if(wire===5)at+=4;else throw new Error('Unsupported protobuf wire type');
    if(at>bytes.length)throw new Error('Truncated protobuf');
  }
  return out;
}
const nested=(value:Field|undefined)=>Buffer.isBuffer(value)?fields(value):new Map<number,Field>();
const num=(value:Field|undefined)=>typeof value==='number'?value:0;
const text=(value:Field|undefined)=>Buffer.isBuffer(value)?value.toString('utf8'):'';

export function readAntigravityUsage(db:Database.Database,session:string,since:number):NativeUsage[]{
  const models=new Map<number,string>();
  for(const r of db.prepare('SELECT idx,data FROM gen_metadata').iterate() as Iterable<{idx:number;data:Buffer}>){
    if(!Buffer.isBuffer(r.data))continue;
    const generator=nested(fields(r.data).get(1));
    models.set(r.idx,text(generator.get(19))||text(generator.get(21))||text(generator.get(22))||'unknown');
  }
  const rows=new Map<string,NativeUsage>();
  for(const r of db.prepare('SELECT idx,metadata FROM steps ORDER BY idx').iterate() as Iterable<{idx:number;metadata:Buffer}>){
    if(!Buffer.isBuffer(r.metadata))continue;
    const meta=fields(r.metadata),u=nested(meta.get(9)),timestamp=nested(meta.get(1));
    const at=num(timestamp.get(1))*1000+num(timestamp.get(2))/1e6;
    if(!u.size||at<since)continue;
    const input=num(u.get(2)),output=num(u.get(3)),cacheWrite=num(u.get(4)),cacheRead=num(u.get(5));
    if(input+output+cacheWrite+cacheRead===0)continue;
    const response=text(u.get(11)),key=response||String(r.idx);
    let model=models.get(num(nested(meta.get(20)).get(3)))??'unknown';
    if(model.startsWith('gemini-'))model=model.replace(/-[a-z]$/,'');
    rows.set(key,{key:usageIdentity(`antigravity:${session}:${key}`),provider:'antigravity-ide',sessionId:session,sourceStep:r.idx,model,at,input,output,cacheRead,cacheWrite,inputIncludesCache:false});
  }
  return [...rows.values()];
}
