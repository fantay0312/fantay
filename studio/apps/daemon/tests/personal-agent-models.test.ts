import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentDef } from '../src/runtimes/types.js';

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  getAgentDef: vi.fn(),
  chatModels: vi.fn(),
  config: {} as Record<string, unknown>,
}));
vi.mock('../src/agents.js', async (original) => ({
  ...await original<typeof import('../src/agents.js')>(),
  detectAgents: mocks.detectAgents,
  getAgentDef: mocks.getAgentDef,
  resolveAgentLaunch: () => ({ launchPath: process.execPath, selectedPath: process.execPath, childPathPrepend: [] }),
}));
vi.mock('../src/app-config.js', async (original) => ({
  ...await original<typeof import('../src/app-config.js')>(),
  readAppConfig: async () => mocks.config,
}));
vi.mock('../src/integrations/tokentosea-runtime.js', () => ({
  tokenToSeaRuntime: () => ({ current: () => ({ user: { id: 'owner' } }), chatModels: mocks.chatModels }),
  tokenToSeaAgentOutputLimit: () => 8192,
}));
vi.mock('undici', () => ({ Agent: class {}, fetch: vi.fn().mockRejectedValue(new Error('No local Ollama')) }));

import { createPaModelRuntime } from '../src/runtimes/personal-agent.js';
import { paModelSchema } from '@open-design/contracts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pa-models-'));
  mocks.config = {};
  mocks.detectAgents.mockReset().mockResolvedValue([]);
  mocks.getAgentDef.mockReset();
  mocks.chatModels.mockReset().mockResolvedValue([]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('PersonalAgent model catalog', () => {
  it('lists TokenToSea first and all installed local agents from the chat catalog', async () => {
    mocks.detectAgents.mockResolvedValue([
      { id: 'claude', name: 'Claude Code', available: true, models: [{ id: 'sonnet', label: 'Sonnet' }] },
      { id: 'codex', name: 'Codex', available: true, models: [{ id: 'gpt-5', label: 'GPT-5' }] },
      { id: 'opencode', name: 'OpenCode', available: true, models: [{ id: 'openai/gpt-5', label: 'GPT-5' }] },
      { id: 'my-agent', name: 'My Agent', available: true, models: [{ id: 'default', label: 'Default' }] },
      { id: 'missing', name: 'Missing', available: false, models: [{ id: 'default', label: 'Default' }] },
      { id: 'byok', name: 'BYOK', available: true, models: [] },
    ]);
    mocks.chatModels.mockResolvedValue([{ id: 'official:model', name: 'Account model' }]);
    const runtime = createPaModelRuntime(root);
    const models = await runtime.models();
    expect(models.map((model) => model.runtime)).toEqual(['tokentosea', 'claude', 'codex', 'opencode', 'my-agent']);
    expect(models[2]).toMatchObject({ modelId: 'gpt-5', available: true });
    await runtime.models();
    expect(mocks.detectAgents).toHaveBeenCalledTimes(1);
  });

  it('preserves old model records and accepts local profile IDs', () => {
    for (const runtime of ['claude', 'ollama', 'tokentosea', 'managed', 'codex', 'my-agent']) {
      expect(paModelSchema.parse({ runtime, modelId: 'model' })).toEqual({ runtime, modelId: 'model' });
    }
    expect(paModelSchema.safeParse({ runtime: '../bad', modelId: 'model' }).success).toBe(false);
  });

  it('marks missing login unavailable and refreshes models after configuration changes', async () => {
    mocks.detectAgents.mockResolvedValue([{ id: 'codex', name: 'Codex', available: true, authStatus: 'missing',
      models: [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'hidden', label: 'Hidden' }] }]);
    const runtime = createPaModelRuntime(root);
    expect((await runtime.models())[0]).toMatchObject({ runtime: 'codex', available: false });
    mocks.config = { hiddenAgentModels: { codex: ['hidden'] } };
    expect(await runtime.models()).toHaveLength(1);
    expect(mocks.detectAgents).toHaveBeenCalledTimes(2);
  });
});

describe('PersonalAgent local execution', () => {
  function fixture(streamFormat: string, program: string) {
    const buildArgs = vi.fn(() => ['-e', program]);
    mocks.getAgentDef.mockReturnValue({
      id: 'local-test', name: 'Local Test', bin: process.execPath, versionArgs: [],
      fallbackModels: [], streamFormat, eventParser: 'codex', promptViaStdin: true, buildArgs,
    } satisfies RuntimeAgentDef);
    return buildArgs;
  }

  it('executes the selected local provider and model with the normal adapter', async () => {
    const build = fixture('plain', "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write('Reply: '+input));");
    const result = await createPaModelRuntime(root).execute({ runtime: 'local-test', modelId: 'selected-model' }, 'Hello', 'run-plain', new AbortController().signal);
    expect(result).toMatchObject({ text: 'Reply: Hello', resolvedModel: 'selected-model' });
    expect(build).toHaveBeenCalledWith('', [], [], { model: 'selected-model' }, expect.objectContaining({ executionPermission: 'read-only' }));
  });

  it('parses structured text and reported usage through the existing stream parser', async () => {
    fixture('json-event-stream', `process.stdin.resume();process.stdin.on('end',()=>{
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Structured reply'}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));
    });`);
    const result = await createPaModelRuntime(root).execute({ runtime: 'local-test', modelId: 'gpt-5' }, 'Hello', 'run-json', new AbortController().signal);
    expect(result.text).toContain('Structured reply');
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, visibility: 'reported' });
  });

  it('rejects unknown local providers before invoking a different service', async () => {
    mocks.getAgentDef.mockReturnValue(null);
    await expect(createPaModelRuntime(root).execute({ runtime: 'unknown', modelId: 'model' }, 'Hello', 'run-unknown', new AbortController().signal))
      .rejects.toMatchObject({ code: 'PA_MODEL_UNAVAILABLE' });
    expect(mocks.chatModels).not.toHaveBeenCalled();
  });

  it('selects the model before sending a prompt over ACP', async () => {
    fixture('acp-json-rpc', `const readline=require('node:readline');let model='';
      const send=value=>console.log(JSON.stringify(value));
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);let result={};
        if(request.method==='initialize')result={protocolVersion:1,agentCapabilities:{}};
        if(request.method==='session/new')result={sessionId:'test-session'};
        if(request.method==='session/set_model')model=request.params.modelId;
        if(request.method==='session/prompt'){
          send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP '+model}}}});
          result={stopReason:'end_turn'};
        }
        send({jsonrpc:'2.0',id:request.id,result});
      });`);
    const result = await createPaModelRuntime(root).execute({ runtime: 'local-test', modelId: 'selected-model' }, 'Hello', 'run-acp', new AbortController().signal);
    expect(result.text).toBe('ACP selected-model');
  });

  it('uses the Pi RPC prompt and confirms the terminal turn', async () => {
    fixture('pi-rpc', `const readline=require('node:readline');const send=value=>console.log(JSON.stringify(value));
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);
        send({type:'response',id:request.id,command:request.type,success:true,data:{}});
        if(request.type==='prompt'){
          send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi '+request.message}});
          send({type:'agent_end'});
        }
      });`);
    const result = await createPaModelRuntime(root).execute({ runtime: 'local-test', modelId: 'provider/model' }, 'Hello', 'run-pi', new AbortController().signal);
    expect(result.text).toBe('Pi Hello');
  });

  it('rejects an RPC process that exits before its final turn receipt', async () => {
    fixture('pi-rpc', `process.stdin.once('data',()=>{
      console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Incomplete'}}));
      process.exit(0);
    });`);
    await expect(createPaModelRuntime(root).execute({ runtime: 'local-test', modelId: 'provider/model' }, 'Hello', 'run-incomplete', new AbortController().signal))
      .rejects.toMatchObject({ code: 'PA_MODEL_UNAVAILABLE' });
  });

  it('confirms cancellation of the complete local process group', async () => {
    fixture('plain', 'process.stdin.resume();setInterval(()=>{},1000);');
    const controller = new AbortController();
    const run = createPaModelRuntime(root).execute({ runtime: 'local-test', modelId: 'model' }, 'Hello', 'run-cancel', controller.signal);
    const assertion = expect(run).rejects.toMatchObject({ code: 'PA_CANCEL_CONFIRMED' });
    setTimeout(() => controller.abort(), 150);
    await assertion;
  });
});
