// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {I18nProvider} from '../../../src/i18n';
import {MovieChannelSwitcher} from '../../../src/components/movie/MovieChannelSwitcher';
import type {AppConfig,AgentInfo} from '../../../src/types';
afterEach(cleanup);
it('expands another channel and applies its model atomically',()=>{
 // A detected CLI is offered only once it is switched on in Settings ▸ 本机 CLI.
 const config={skillId:null,designSystemId:null,mode:'daemon',agentId:'codex',enabledAgents:['codex','claude'],agentModels:{codex:{model:'code-a'}},apiKey:'',baseUrl:'',model:'',apiProtocolConfigs:{}} as AppConfig;
 const agents=[{id:'codex',name:'Codex CLI',available:true,models:[{id:'code-a',label:'Codex A'}]},{id:'claude',name:'Claude Code',available:true,models:[{id:'claude-a',label:'Claude A'}]}] as AgentInfo[];
 const change=vi.fn();
 render(<I18nProvider initial="en"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={change} onOpenSettings={vi.fn()}/></I18nProvider>);
 fireEvent.pointerDown(screen.getByRole('button'),{button:0,ctrlKey:false});
 expect(screen.queryByRole('menuitem',{name:'Claude A'})).toBeNull();
 fireEvent.click(screen.getByRole('menuitem',{name:'Claude Code'}));
 fireEvent.click(screen.getByRole('menuitemradio',{name:'Claude A'}));
 expect(change).toHaveBeenCalledWith(expect.objectContaining({mode:'daemon',agentId:'claude',agentModels:expect.objectContaining({claude:{model:'claude-a'}})}));
});

it('reconciles a removed model within its configured channel', () => {
 const config={skillId:null,designSystemId:null,mode:'daemon',agentId:'codex',agentModels:{codex:{model:'removed'}},apiKey:'',baseUrl:'',model:''} as AppConfig;
 const agents=[{id:'codex',name:'Codex CLI',available:true,models:[{id:'ready',label:'Ready'},{id:'removed',label:'Removed',enabled:false}]}] as AgentInfo[];
 const change=vi.fn();
 render(<I18nProvider initial="en"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={change} onOpenSettings={vi.fn()}/></I18nProvider>);
 expect(change).toHaveBeenCalledWith(expect.objectContaining({agentId:'codex',agentModels:{codex:{model:'ready'}}}));
});

it('keeps the active channel in a cascading submenu instead of expanding models inline in the root menu', () => {
 const config={skillId:null,designSystemId:null,mode:'daemon',agentId:'claude',enabledAgents:['claude','codex'],agentModels:{claude:{model:'claude-sonnet-5.5'}},apiKey:'',baseUrl:'',model:'',apiProtocolConfigs:{}} as AppConfig;
 const agents=[
  {id:'claude',name:'Claude Code',available:true,models:[{id:'default',label:'Default'},{id:'claude-sonnet-5.5',label:'Claude Sonnet 5.5'},{id:'claude-opus-5.5',label:'Claude Opus 5.5'}]},
  {id:'codex',name:'Codex CLI',available:true,models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}]},
 ] as AgentInfo[];
 const change=vi.fn();
 render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={change} onOpenSettings={vi.fn()}/></I18nProvider>);
 fireEvent.pointerDown(screen.getByRole('button',{name:'Claude Code · Claude Sonnet 5.5'}),{button:0,ctrlKey:false});

 const rootMenu=screen.getByRole('menu');
 expect(within(rootMenu).queryAllByRole('menuitemradio')).toHaveLength(0);
 expect(within(rootMenu).getByText('其他渠道')).toBeTruthy();
 expect(within(rootMenu).getByRole('menuitem',{name:'Claude Code'}).textContent).toContain('Claude Sonnet 5.5');
 expect(within(rootMenu).getByRole('menuitem',{name:'Codex CLI'})).toBeTruthy();

 fireEvent.click(within(rootMenu).getByRole('menuitem',{name:'Claude Code'}));
 const subMenu=screen.getByRole('menu',{name:'Claude Code'});
 expect(within(subMenu).getByRole('menuitemradio',{name:'Claude Sonnet 5.5'}).getAttribute('aria-checked')).toBe('true');
 fireEvent.click(within(subMenu).getByRole('menuitemradio',{name:'Claude Opus 5.5'}));
 expect(change).toHaveBeenCalledWith(expect.objectContaining({mode:'daemon',agentId:'claude',agentModels:expect.objectContaining({claude:{model:'claude-opus-5.5'}})}));
 expect(screen.queryByRole('menu')).toBeNull();
});

it('groups TokenToSea routes by model and preserves the selected supplier and channel', () => {
 const tokentoseaModels=[
  {id:'official:deepseek-flash',label:'DeepSeek Flash'},
  {id:'official:deepseek-v4-pro',label:'DeepSeek V4 Pro'},
  {id:'supplier:suanlizhixuan/claude/claude-opus-5-5',label:'算力智选 · Claude Opus 5.5'},
  {id:'supplier:suanlizhixuan/claude/claude-sonnet-5-5',label:'算力智选 · Claude Sonnet 5.5'},
  {id:'supplier:tokentide/aws/claude-opus-5-5',label:'TokenTide · Claude Opus 5.5',channelOffer:{modelKey:'claude-opus-5-5',modelName:'Claude Opus 5.5',supplier:'TokenTide',channel:'aws',inputMultiplier:'0.4',outputMultiplier:'0.6'}},
  {id:'official:qwen3.8-max',label:'Qwen3.8 Max'},
 ];
 const config={skillId:null,designSystemId:null,mode:'daemon',agentId:'tokentosea',enabledAgents:['tokentosea','claude'],agentModels:{tokentosea:{model:'supplier:suanlizhixuan/claude/claude-opus-5-5'}},apiKey:'',baseUrl:'',model:'',apiProtocolConfigs:{}} as AppConfig;
 const agents=[
  {id:'tokentosea',name:'TokenToSea',available:true,models:tokentoseaModels},
  {id:'claude',name:'Claude Code',available:true,models:[{id:'claude-sonnet-5.5',label:'Claude Sonnet 5.5'}]},
 ] as AgentInfo[];
 const change=vi.fn();
 render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={change} onOpenSettings={vi.fn()}/></I18nProvider>);

 const trigger=screen.getByRole('button',{name:'TokenToSea · Claude Opus 5.5'});
 fireEvent.pointerDown(trigger,{button:0,ctrlKey:false});
 const rootMenu=screen.getByRole('menu');
 expect(within(rootMenu).queryAllByRole('menuitemradio')).toHaveLength(0);
 expect(within(rootMenu).getByRole('menuitem',{name:'TokenToSea'}).textContent).toContain('Claude Opus 5.5');
 expect(within(rootMenu).getByRole('menuitem',{name:'Claude Code'})).toBeTruthy();

 // Both Opus routes share one model row.
 fireEvent.click(within(rootMenu).getByRole('menuitem',{name:'TokenToSea'}));
 const supplierMenu=screen.getByRole('menu',{name:'TokenToSea'});
 expect(within(supplierMenu).getAllByRole('menuitem').map(item=>item.textContent)).toEqual([
  'DeepSeek Flash1','DeepSeek V4 Pro1','Claude Opus 5.52','Claude Sonnet 5.51','Qwen3.8 Max1',
 ]);
 expect(within(supplierMenu).getByRole('menuitem',{name:'Claude Opus 5.5'}).hasAttribute('data-active')).toBe(true);
 expect(within(supplierMenu).getByRole('menuitem',{name:'DeepSeek Flash'}).hasAttribute('data-active')).toBe(false);

 fireEvent.click(within(supplierMenu).getByRole('menuitem',{name:'Claude Opus 5.5'}));
 const tokenTideMenu=screen.getByRole('menu',{name:'Claude Opus 5.5'});
 const opusRow=within(tokenTideMenu).getByRole('menuitemradio',{name:/TokenTide · aws.*输入 0.4× · 输出 0.6×/});
 fireEvent.click(opusRow);
 expect(change).toHaveBeenCalledWith(expect.objectContaining({
  mode:'daemon',
  agentId:'tokentosea',
  agentModels:expect.objectContaining({tokentosea:{model:'supplier:tokentide/aws/claude-opus-5-5'}}),
 }));
});

it('switches from another active channel into TokenToSea through its supplier submenu', () => {
 const tokentoseaModels=[
  {id:'official:deepseek-flash',label:'DeepSeek Flash'},
  {id:'supplier:suanlizhixuan/claude/claude-opus-5-5',label:'算力智选 · Claude Opus 5.5'},
 ];
 const config={skillId:null,designSystemId:null,mode:'daemon',agentId:'claude',enabledAgents:['claude','tokentosea'],agentModels:{claude:{model:'claude-sonnet-5.5'}},apiKey:'',baseUrl:'',model:'',apiProtocolConfigs:{}} as AppConfig;
 const agents=[
  {id:'claude',name:'Claude Code',available:true,models:[{id:'claude-sonnet-5.5',label:'Claude Sonnet 5.5'}]},
  {id:'tokentosea',name:'TokenToSea',available:true,models:tokentoseaModels},
 ] as AgentInfo[];
 const change=vi.fn();
 render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={change} onOpenSettings={vi.fn()}/></I18nProvider>);

 fireEvent.pointerDown(screen.getByRole('button',{name:'Claude Code · Claude Sonnet 5.5'}),{button:0,ctrlKey:false});
 fireEvent.click(screen.getByRole('menuitem',{name:'TokenToSea'}));
 const supplierMenu=screen.getByRole('menu',{name:'TokenToSea'});
 expect(within(supplierMenu).getByRole('menuitem',{name:'Claude Opus 5.5'}).hasAttribute('data-active')).toBe(false);
 fireEvent.click(within(supplierMenu).getByRole('menuitem',{name:'Claude Opus 5.5'}));
 fireEvent.click(within(screen.getByRole('menu',{name:'Claude Opus 5.5'})).getByRole('menuitemradio',{name:/算力智选 · claude/}));
 expect(change).toHaveBeenCalledWith(expect.objectContaining({
  mode:'daemon',
  agentId:'tokentosea',
  agentModels:expect.objectContaining({tokentosea:{model:'supplier:suanlizhixuan/claude/claude-opus-5-5'}}),
 }));
});

it('pre-expands TokenToSea and the active supplier submenu when opened from RunControl', () => {
 const reasoningOptions=[
  {id:'low',label:'低',reasoningControlKind:'effort' as const},
  {id:'medium',label:'中',default:true,reasoningControlKind:'effort' as const},
  {id:'high',label:'高',reasoningControlKind:'effort' as const},
 ];
 const config={skillId:null,designSystemId:null,mode:'daemon',agentId:'tokentosea',enabledAgents:['tokentosea'],agentModels:{tokentosea:{model:'supplier:tokentide/aws/claude-opus-5-5',reasoning:'high'}},apiKey:'',baseUrl:'',model:'',apiProtocolConfigs:{}} as AppConfig;
 const agents=[{
  id:'tokentosea',
  name:'TokenToSea',
  available:true,
  models:[
   {id:'official:deepseek-flash',label:'DeepSeek Flash'},
   {id:'supplier:tokentide/aws/claude-opus-5-5',label:'TokenTide · Claude Opus 5.5',reasoningOptions},
  ],
 }] as AgentInfo[];
 render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={vi.fn()} onOpenSettings={vi.fn()}/></I18nProvider>);

 fireEvent.click(screen.getByRole('button',{name:'推理强度 · 高 · 速度 · 标准'}));
 fireEvent.click(screen.getByRole('button',{name:'切换模型 · Claude Opus 5.5'}));
 const tokenTideMenu=screen.getByRole('menu',{name:'Claude Opus 5.5'});
 expect(within(tokenTideMenu).getByRole('menuitemradio',{name:/TokenTide · aws/}).getAttribute('aria-checked')).toBe('true');
});
