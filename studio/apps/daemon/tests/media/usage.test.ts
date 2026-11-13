import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureTokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { AiUsageStore } from '../../src/integrations/usage-store.js';
import { fetchMedia, withMediaUsage } from '../../src/media/usage.js';
const dirs:string[]=[],stores:AiUsageStore[]=[];
afterEach(()=>{configureTokenToSeaRuntime(undefined);vi.unstubAllGlobals();stores.splice(0).forEach(store=>store.close());dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true}));});
it('records concurrent BYOK tasks, reported usage and unknown costs without cross-project attribution',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'byok-usage-'));dirs.push(dir);const usage=new AiUsageStore(dir);stores.push(usage);
  configureTokenToSeaRuntime({usage} as never);
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({usage:{input_tokens:10,output_tokens:5},costUsd:'0.250000'})));
  await Promise.all([
    withMediaUsage({provider:'openai',model:'image',surface:'image',projectId:'a'},async()=>{await (await fetchMedia('https://provider.invalid')).json();return {}; }),
    withMediaUsage({provider:'other',model:'voice',surface:'audio',projectId:'b'},async()=>({})),
  ]);
  expect(usage.summary(null,30,'a').totals).toMatchObject({requests:1,inputTokens:10,outputTokens:5,reportedUsd:'0.250000',unknown:0});
  expect(usage.summary(null,30,'b').totals).toMatchObject({requests:1,inputTokens:0,unknown:1});
  await expect(withMediaUsage({provider:'other',model:'video',surface:'video',projectId:'c'},async()=>{throw new Error('Provider failed');})).rejects.toThrow('Provider failed');
  expect(usage.summary(null,30,'c').recent[0]?.status).toBe('failed');
});
