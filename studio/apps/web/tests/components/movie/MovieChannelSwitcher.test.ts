import { expect, it } from 'vitest';
import type {AppConfig, AgentInfo} from '../../../src/types';
import {nativeChannelOptions, savedMovieChannels, selectChannelModel, selectMovieChannel, agentRunControls, withAgentRunChoice} from '../../../src/components/movie/MovieChannelSwitcher';
import {providerModelsCacheKey} from '../../../src/components/providerModelsCache';
it('offers the selected TokenToSea model reasoning levels and saves or clears the choice', () => {
 const config = {mode:'daemon',agentId:'tokentosea',agentModels:{tokentosea:{model:'deepseek'}}} as unknown as AppConfig;
 const agents = [{id:'tokentosea',name:'TokenToSea',available:true,models:[{id:'deepseek',label:'DeepSeek',reasoningOptions:[{id:'off',label:'Off',default:true},{id:'low',label:'Low'},{id:'high',label:'High'},{id:'max',label:'Max'}]},{id:'other',label:'Other',reasoningOptions:[]}]}] as AgentInfo[];
 expect(agentRunControls(config,agents,'deepseek')).toMatchObject({saved:null,recommended:'off',steps:agents[0]!.models?.[0]?.reasoningOptions});
 const saved = withAgentRunChoice(config,'tokentosea',{reasoning:'high'});
 expect(saved.agentModels?.tokentosea).toEqual({model:'deepseek',reasoning:'high'});
 expect(agentRunControls(saved,agents,'deepseek')?.saved).toBe('high');
 expect(agentRunControls(saved,agents,'other')).toMatchObject({steps:[],saved:null,recommended:null});
 expect(withAgentRunChoice(saved,'tokentosea',{reasoning:null}).agentModels?.tokentosea).toEqual({model:'deepseek'});
});
it('keeps different providers on the same protocol and restores their own configuration',()=>{
 const config={agentId:null,skillId:null,designSystemId:null,mode:'api',apiProtocol:'openai',apiKey:'current-test-key',baseUrl:'https://one.example/v1',model:'one-model',apiProviderBaseUrl:'https://one.example/v1',maxTokens:1234,
 byokProviderConfigDrafts:{'openai:https://two.example/v1':{apiConfig:{apiKey:'other-test-key',baseUrl:'https://two.example/v1',model:'two-model',apiProviderBaseUrl:'https://two.example/v1',byokVideoModel:'video-model'},maxTokens:4321}}} as AppConfig;
 const channels=savedMovieChannels(config);expect(channels).toHaveLength(2);
 const next=selectMovieChannel(config,channels.find(c=>c.apiConfig.model==='two-model')!);
 expect(next).toMatchObject({mode:'api',model:'two-model',apiKey:'other-test-key',baseUrl:'https://two.example/v1',maxTokens:4321,byokVideoModel:'video-model'});
 expect(next.byokProviderConfigDrafts?.['openai:https://one.example/v1']?.apiConfig.model).toBe('one-model');
});

it('offers only configured channels and enabled models, including to the native editor', () => {
 const config = {mode:'daemon',agentId:'missing',enabledAgents:['codex'],apiKey:'',baseUrl:'https://api.example/v1',model:'suggested',apiProtocol:'openai',apiProtocolConfigs:{},byokProviderConfigDrafts:{}} as AppConfig;
 const agents = [
  {id:'missing',name:'Not installed',available:false,models:[{id:'a',label:'A'}]},
  {id:'signed-out',name:'Signed out',available:true,authStatus:'missing',models:[{id:'b',label:'B'}]},
  {id:'codex',name:'Codex',available:true,models:[{id:'ready',label:'Ready'},{id:'disabled',label:'Disabled',enabled:false}]},
  {id:'tokentosea',name:'TokenToSea',available:true,models:[]},
 ] as AgentInfo[];
 const snapshot = nativeChannelOptions(config, agents);
 expect(snapshot.channels.map(c=>c.id)).toEqual(['agent:codex']);
 expect(snapshot.channels[0]?.models.map(m=>m.id)).toEqual(['ready']);
 expect(selectChannelModel(config,agents,'agent:signed-out','b')).toBe(config);
 expect(selectChannelModel(config,agents,'agent:codex','disabled')).toBe(config);
 expect(selectChannelModel(config,agents,'agent:codex','invented')).toBe(config);
});
it('keeps fixed thinking and automatic choices visible for TokenToSea',()=>{
 const config={mode:'daemon',agentId:'tokentosea',agentModels:{tokentosea:{model:'fixed'}}} as unknown as AppConfig;
 const agents=[{id:'tokentosea',models:[{id:'fixed',reasoningOptions:[{id:'default',label:'Fixed thinking',reasoningControlKind:'fixed',default:true}]}]}] as AgentInfo[];
 expect(agentRunControls(config,agents,'fixed')).toMatchObject({recommended:'default',steps:[{id:'default',reasoningControlKind:'fixed'}]});
});

it('accepts a configured local Ollama channel without a key but rejects incomplete remote drafts', () => {
 const local = {apiKey:'',baseUrl:'http://localhost:11434',model:'local-model',apiProviderBaseUrl:null};
 const config = {mode:'api',apiProtocol:'ollama',...local,apiProtocolConfigs:{openai:{apiKey:'',baseUrl:'https://api.example/v1',model:'remote-model'}}} as AppConfig;
 expect(nativeChannelOptions(config,[]).channels.map(c=>c.models.map(m=>m.id))).toEqual([['local-model']]);
});

it('uses the returned provider catalogue without restoring saved or suggested models', () => {
 const config={mode:'api',apiProtocol:'openai',apiKey:'sk-test',baseUrl:'https://api.example/v1',model:'retired'} as AppConfig;
 const key=providerModelsCacheKey('openai',config.baseUrl,config.apiKey);
 const snapshot=nativeChannelOptions(config,[],{[key]:[{id:'available',label:'Available'},{id:'locked',label:'Locked',enabled:false}]});
 expect(snapshot.channels[0]?.models.map(model=>model.id)).toEqual(['available']);
 expect(snapshot.modelId).toBe('available');
 expect(nativeChannelOptions(config,[],{[key]:[]}).channels).toEqual([]);
});
