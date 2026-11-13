import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown, ChevronRight, Link, RotateCcw } from 'lucide-react';
import { KNOWN_PROVIDERS } from '../../state/config';
import type { AgentInfo, AgentModelChoice, ApiProtocol, ApiProtocolConfig, AppConfig } from '../../types';
import { AgentIcon } from '../AgentIcon';
import { agentModelIsSelectable, dropUnavailableServiceTier, effectiveAgentModelChoice, modelServiceTierAvailability, modelServiceTierEfforts, normalizeAgentModelVariantChoice, visibleAgentModels } from '../agentModelSelection';
import { byokPreflightBlockReason } from '../byok/preflight';
import { groupModelsByCompany, modelCompany } from '../modelOptions';
import { isAgentEnabled } from '../../utils/visibleAgents';
import { fetchProviderModels } from '../../providers/provider-models';
import { providerModelsCacheKey, configuredProviderModelOptions, type ProviderModelsCache } from '../providerModelsCache';
import { useI18n } from '../../i18n';
import { Button, DropdownMenu, DropdownMenuCaption, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, Icon, IconButton, Popover, PopoverContent, PopoverTrigger } from '../../fantay/ui';
import { STANDARD_SPEED, isStandardSpeedTier, speedKind, speedTierHint, speedTierName } from '../speedTiers';
import { SpeedGlyph } from './SpeedGlyph';
import styles from './MovieChannelSwitcher.module.css';
import { isByokAgentId } from '@open-design/contracts';

export function currentChannelSnapshot(config: AppConfig): ApiProtocolConfig {
  return {apiKey:config.apiKey,baseUrl:config.baseUrl,model:config.model,apiVersion:config.apiVersion,apiProviderBaseUrl:config.apiProviderBaseUrl,
    byokImageModel:config.byokImageModel,byokVideoModel:config.byokVideoModel,byokSpeechModel:config.byokSpeechModel,byokSpeechVoice:config.byokSpeechVoice};
}
export const channelKey = (protocol:ApiProtocol, value:ApiProtocolConfig) => `${protocol}:${value.apiProviderBaseUrl ?? `custom:${value.baseUrl}`}`;
/** An agent's saved choice the way every picker reads it: a concrete CLI id saved before the daemon folded
 *  effort / speed variants into one model shows as that family, its effort and its tier, never as unknown. */
function savedAgentChoice(config:AppConfig,agents:readonly AgentInfo[],agentId:string|null|undefined):AgentModelChoice|undefined{
  if(!agentId)return undefined;
  return effectiveAgentModelChoice(agents.find(agent=>agent.id===agentId),config.agentModels?.[agentId]);
}
export function publicChannelId(key:string){let hash=2166136261;for(const character of key)hash=Math.imul(hash^character.charCodeAt(0),16777619);return `api-${(hash>>>0).toString(16)}`;}
export function nativeChannelOptions(config:AppConfig,agents:AgentInfo[],cache:ProviderModelsCache={}){
  const channels = [
    ...agents.filter(agent => !isByokAgentId(agent.id) && agent.available && agent.authStatus !== 'missing' && isAgentEnabled(config, agent.id)).map(agent => ({
      id: `agent:${agent.id}`,
      label: agent.name,
      available: true,
      models: visibleAgentModels(
        agent.models?.length ? agent.models : agent.id === 'tokentosea' ? [] : [{ id: 'default', label: 'Default', enabled: true }],
        config.hiddenAgentModels?.[agent.id],
        savedAgentChoice(config, agents, agent.id)?.model,
      )
        .filter(model => model.enabled !== false && agentModelIsSelectable(agent, model.id))
        .map(model => ({ id: model.id, label: model.label ?? model.id, enabled: true })),
    })),
    ...savedMovieChannels(config).filter(channel => byokPreflightBlockReason({ ...channel.apiConfig, apiProtocol: channel.protocol }) === null).map((channel, index) => {
      const key = providerModelsCacheKey(channel.protocol, channel.apiConfig.baseUrl, channel.apiConfig.apiKey, channel.apiConfig.apiVersion);
      const fetched = cache[key];
      return {
        id: publicChannelId(channel.key),
        label: KNOWN_PROVIDERS.find(provider => provider.protocol === channel.protocol && provider.baseUrl === channel.apiConfig.baseUrl)?.label ?? `${channel.protocol} · ${index + 1}`,
        available: true,
        models: configuredProviderModelOptions(fetched, channel.apiConfig.model),
      };
    }),
  ].filter(channel => channel.models.length > 0);
  const selectedId = config.mode === 'api' && config.apiProtocol ? publicChannelId(channelKey(config.apiProtocol, currentChannelSnapshot(config))) : `agent:${config.agentId}`;
  const selected = channels.find(channel => channel.id === selectedId);
  const savedModel = config.mode === 'api' ? config.model : savedAgentChoice(config, agents, config.agentId)?.model;
  const modelId = selected?.models.find(model => model.id === savedModel)?.id ?? selected?.models[0]?.id ?? '';
  return { channels, selectedId, modelId };
}
export function savedMovieChannels(config:AppConfig) {
  const channels=new Map<string,{protocol:ApiProtocol;apiConfig:ApiProtocolConfig;maxTokens?:number}>();
  for(const [protocol,value] of Object.entries(config.apiProtocolConfigs ?? {})) if(value)channels.set(channelKey(protocol as ApiProtocol,value),{protocol:protocol as ApiProtocol,apiConfig:value});
  for(const [key,draft] of Object.entries(config.byokProviderConfigDrafts ?? {}))channels.set(key,{protocol:key.slice(0,key.indexOf(':')) as ApiProtocol,...draft});
  if(config.apiProtocol)channels.set(channelKey(config.apiProtocol,currentChannelSnapshot(config)),{protocol:config.apiProtocol,apiConfig:currentChannelSnapshot(config),maxTokens:config.maxTokens});
  return [...channels.entries()].map(([key,value])=>({key,...value}));
}
export function selectMovieChannel(config:AppConfig, target:ReturnType<typeof savedMovieChannels>[number]):AppConfig {
  const drafts={...config.byokProviderConfigDrafts};
  if(config.apiProtocol)drafts[channelKey(config.apiProtocol,currentChannelSnapshot(config))]={apiConfig:currentChannelSnapshot(config),maxTokens:config.maxTokens};
  return {...config,...target.apiConfig,mode:'api',apiProtocol:target.protocol,maxTokens:target.maxTokens,byokPendingProviderKey:undefined,byokProviderConfigDrafts:drafts,
    apiProtocolConfigs:{...config.apiProtocolConfigs,[target.protocol]:target.apiConfig}};
}
export function selectChannelModel(config:AppConfig,agents:AgentInfo[],channelId:string,model:string,cache:ProviderModelsCache={}):AppConfig {
  const channel = nativeChannelOptions(config, agents, cache).channels.find(candidate => candidate.id === channelId);
  if (!channel?.models.some(candidate => candidate.id === model)) return config;
  if(channelId.startsWith('agent:')){
    const id=channelId.slice(6);
    // A speed tier belongs to one model route. Carrying it onto a model without that tier would let the
    // daemon swap the "default" model for whichever route offers the tier, so it is dropped here, as it is
    // when the new model has no concrete id for that tier at the saved effort. The write is the family form.
    const {serviceTier,...previous}=savedAgentChoice(config,agents,id)??{};
    const option=agents.find(agent=>agent.id===id)?.models?.find(candidate=>candidate.id===model);
    const keepTier=Boolean(serviceTier&&option?.serviceTierOptions?.some(tier=>tier.id===serviceTier)&&modelServiceTierAvailability(option,previous.reasoning,serviceTier));
    return {...config,mode:'daemon',agentId:id,agentModels:{...config.agentModels,[id]:{...previous,model,...(keepTier?{serviceTier}:{})}}};
  }
  const target=savedMovieChannels(config).find(c=>publicChannelId(c.key)===channelId);if(!target)return config;const next=selectMovieChannel(config,target);return {...next,model,apiProtocolConfigs:{...next.apiProtocolConfigs,[target.protocol]:{...target.apiConfig,model}}};
}

type RunOption = { id: string; label: string; description?: string; default?: boolean; reasoningControlKind?: 'effort' | 'toggle' | 'budget' | 'mode' | 'fixed' | 'automatic'; reasoningBudgetTokens?: number };
export interface AgentRunControls {
  agentId: string;
  /** Model-owned choices; TokenToSea also includes modes, budgets and fixed thinking. */
  steps: RunOption[];
  /** The saved effort when the route accepts it; null leaves the choice to the client. */
  saved: string | null;
  /** The step the client uses when no effort is passed, when the catalogue says so. */
  recommended: string | null;
  /** Speed tiers of the current model route: Codex flags, or the Fast ids a folded family (Cursor, Antigravity, Grok) lists. */
  tiers: RunOption[];
  /** The tier in effect: saved and runnable at the current effort. */
  tier: string | null;
  /** Tiers the current effort can run. A folded family runs only the pairings it has a concrete id for. */
  availableTiers: string[];
  /** Per tier, the efforts that can run it, for saying where an unavailable tier lives. */
  tierEfforts: Record<string, string[]>;
}

/** Effort and speed knobs of the selected agent's current model, read the way the daemon validates them:
 *  the model's own ladder when it has one, else the agent-wide ladder. */
export function agentRunControls(config:AppConfig,agents:AgentInfo[],modelId:string):AgentRunControls|null{
  if(config.mode!=='daemon'||!config.agentId)return null;
  const agent=agents.find(candidate=>candidate.id===config.agentId);if(!agent)return null;
  const choice=savedAgentChoice(config,agents,agent.id)??{};
  const model=agent.models?.find(option=>option.id===modelId);
  const steps=(model?.reasoningOptions??agent.reasoningOptions??[]).filter(option=>option.id!=='default'||agent.id==='tokentosea'||option.reasoningControlKind==='fixed');
  const tiers=(model?.serviceTierOptions??[]).filter(option=>!isStandardSpeedTier(option.id));
  const availableTiers=tiers.filter(tier=>modelServiceTierAvailability(model,choice.reasoning,tier.id)).map(tier=>tier.id);
  return {
    agentId:agent.id,
    steps,
    saved:steps.some(option=>option.id===choice.reasoning)?choice.reasoning!:null,
    recommended:steps.find(option=>option.default)?.id??null,
    tiers,
    tier:choice.serviceTier&&availableTiers.includes(choice.serviceTier)?choice.serviceTier:null,
    availableTiers,
    tierEfforts:Object.fromEntries(tiers.map(tier=>[tier.id,modelServiceTierEfforts(model,tier.id)])),
  };
}
/** Writes (or, with null, clears) the agent's saved effort or speed tier, leaving its other picks alone.
 *  Given the agents and the model in effect, the write is the family form of a concrete id saved before the
 *  daemon folded variants (so that id cannot override the edit), and a tier the new effort cannot run is dropped. */
export function withAgentRunChoice(config:AppConfig,agentId:string,patch:{reasoning?:string|null;serviceTier?:string|null},agents?:readonly AgentInfo[],modelId?:string):AppConfig{
  const saved=config.agentModels?.[agentId];
  const agent=agents?.find(candidate=>candidate.id===agentId);
  let entry:AgentModelChoice={...(normalizeAgentModelVariantChoice(agent,saved)??saved)};
  for(const key of ['reasoning','serviceTier'] as const){
    if(!(key in patch))continue;
    const value=patch[key];
    if(value)entry[key]=value;else delete entry[key];
  }
  if(agent)entry=dropUnavailableServiceTier(agent.models?.find(option=>option.id===(modelId??entry.model)),entry);
  return {...config,agentModels:{...config.agentModels,[agentId]:entry}};
}

const EFFORT_COPY:Record<string,{zh:string;en:string;hintZh:string;hintEn:string}>={
  default:{zh:'自动',en:'Auto',hintZh:'按模型默认策略自动调节推理深度',hintEn:'Balances speed and reasoning depth automatically'},
  off:{zh:'关闭',en:'Off',hintZh:'不做额外推理，回复最快',hintEn:'No extra reasoning, fastest replies'},
  none:{zh:'关闭',en:'None',hintZh:'不做额外推理，回复最快',hintEn:'No extra reasoning, fastest replies'},
  on:{zh:'开启思考',en:'Thinking on',hintZh:'开启深度思考，适合多步分析与复杂任务',hintEn:'Extended thinking for multi-step problems'},
  minimal:{zh:'极简',en:'Minimal',hintZh:'只做最少的推理',hintEn:'The least reasoning that still helps'},
  low:{zh:'低',en:'Low',hintZh:'回复快，推理较浅',hintEn:'Fast replies with lighter reasoning'},
  medium:{zh:'中',en:'Medium',hintZh:'速度与推理深度均衡',hintEn:'Balances speed and reasoning depth'},
  high:{zh:'高',en:'High',hintZh:'更深的推理，适合复杂问题',hintEn:'Deeper reasoning for complex problems'},
  xhigh:{zh:'极高',en:'Extra',hintZh:'极高推理深度，适合难题',hintEn:'Extra reasoning depth for hard problems'},
  max:{zh:'最高',en:'Max',hintZh:'最大推理深度，留给最难的问题',hintEn:'Maximum depth for the hardest problems'},
  ultra:{zh:'Ultra',en:'Ultra',hintZh:'最大推理，并自动分派子任务',hintEn:'Maximum reasoning with automatic task delegation'},
  between_tools_low:{zh:'仅工具间思考 · 低',en:'Between tools · low',hintZh:'仅在工具调用之间进行轻量推理',hintEn:'Light reasoning between tool calls only'},
  between_tools_medium:{zh:'仅工具间思考 · 中',en:'Between tools · medium',hintZh:'仅在工具调用之间进行均衡推理',hintEn:'Balanced reasoning between tool calls only'},
  between_tools_high:{zh:'仅工具间思考 · 高',en:'Between tools · high',hintZh:'仅在工具调用之间进行深度推理',hintEn:'Deep reasoning between tool calls only'},
};

const EFFORT_INTENSITY:Record<string,number>={
  off:0,none:0,minimal:0.16,low:0.26,between_tools_low:0.26,default:0.42,medium:0.48,between_tools_medium:0.48,
  on:0.64,high:0.70,between_tools_high:0.70,xhigh:0.86,max:0.95,ultra:1,
};

const EFFORT_FLOW_SPEED:Record<string,number>={
  off:0,none:0,minimal:0.65,low:0.85,between_tools_low:0.85,default:1.35,medium:1.5,between_tools_medium:1.5,
  on:2.3,high:2.55,between_tools_high:2.55,xhigh:3.75,max:4.75,ultra:5.6,
};

/** Fixed badges and explicit token-budget / non-ladder menus stay in ThinkingControl;
 *  every multi-step effort / toggle / automatic ladder (including TokenToSea's) uses RunControl. */
export function usesNamedThinkingMenu(controls:AgentRunControls):boolean{
  if(controls.tiers.length>0)return false;
  if(controls.steps.length<=1)return true;
  if(controls.steps.some(step=>step.reasoningControlKind==='fixed'||step.reasoningControlKind==='budget'))return true;
  return controls.steps.filter(step=>step.reasoningControlKind!=='mode').length<2;
}
const effortLabel=(option:RunOption,zh:boolean)=>{
  if(option.reasoningControlKind==='budget')return zh?option.label:`Budget ${option.reasoningBudgetTokens?.toLocaleString('en-US')??''} tokens`;
  if(option.reasoningControlKind==='fixed')return option.id==='on'?(zh?'仅开启思考':'Thinking on only'):(zh?'自动思考':'Fixed thinking');
  if(option.reasoningControlKind==='automatic')return zh?'自动':'Auto';
  if(option.reasoningControlKind==='mode')return zh?option.label:`Between tools · ${option.id.replace('between_tools_','')}`;
  if(option.id==='on')return zh?'开启思考':'Thinking on';
  const copy=EFFORT_COPY[option.id.toLowerCase()];return copy?(zh?copy.zh:copy.en):option.label;
};
/** Why a tier row is off-limits at the current effort, naming the efforts that do run it. */
const tierUnavailableReason=(controls:AgentRunControls,tierId:string,zh:boolean)=>{
  const names=(controls.tierEfforts[tierId]??[]).map(id=>{const step=controls.steps.find(candidate=>candidate.id===id);return step?effortLabel(step,zh):id;});
  if(names.length===0){const name=speedTierName(controls.tiers.find(tier=>tier.id===tierId)??{id:tierId},zh);return zh?`当前强度没有${name}版本`:`No ${name} variant at this effort`;}
  return zh?`仅「${names.join('、')}」强度可用`:`Only at ${names.join(' / ')}`;
};
const at=(index:number,count:number)=>count>1?index/(count-1):0.5;

function computeNestedRightPadding(rootEl: HTMLElement | null, subEl: HTMLElement | null): number {
  if (!rootEl || !subEl || typeof window === 'undefined') return 12;
  const rootRect = rootEl.getBoundingClientRect();
  const subRect = subEl.getBoundingClientRect();
  if (subRect.width > 0 && subRect.right <= rootRect.left + 8 && subRect.left >= 220) {
    return Math.max(12, Math.ceil(window.innerWidth - rootRect.left + 8));
  }
  return 12;
}

/** TokenToSea's thinking choices are budgets and modes, not a ladder, so they stay a named list. */
function ThinkingControl({controls,zh,onChange}:{controls:AgentRunControls;zh:boolean;onChange(reasoning:string|null):void}){
  const {steps,saved,recommended}=controls;
  const activeId=saved??recommended;
  const active=steps.find(step=>step.id===activeId)??null;
  const label=active?effortLabel(active,zh):(zh?'自动':'Auto');
  if(steps.length===1)return <Button size="sm" variant="ghost" className={styles.effortTrigger} disabled title={active?.label} aria-label={`${zh?'思考设置':'Thinking'} · ${label}`}>{label}</Button>;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={styles.effortTrigger} aria-label={`${zh?'思考设置':'Thinking'} · ${label}`}><span className={styles.effortChipLabel}>{label}</span></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={styles.thinkingMenu}>
      <DropdownMenuCaption>{zh?'思考设置':'Thinking'}</DropdownMenuCaption>
      <DropdownMenuRadioGroup value={activeId??''} onValueChange={onChange}>
        {steps.map(step=><DropdownMenuRadioItem key={step.id} value={step.id}>{effortLabel(step,zh)}{step.default?(zh?'（默认）':' (default)'):''}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {saved!==null?<><DropdownMenuSeparator/><DropdownMenuItem onSelect={()=>onChange(null)}>{zh?'恢复模型默认':'Reset to model default'}</DropdownMenuItem></>:null}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The speed button at the panel's top left and its menu: 标准 always, then only the tiers this model lists.
 *  A tier the current effort has no concrete id for stays in place, disabled, naming the efforts that run it. */
function SpeedMenu({controls,zh,onChange}:{controls:AgentRunControls;zh:boolean;onChange(serviceTier:string|null):void}){
  const activeTier=controls.tiers.find(tier=>tier.id===controls.tier)??null;
  const rows=[null,...controls.tiers.filter(tier=>!isStandardSpeedTier(tier.id))];
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><IconButton size="md" tooltip={false} className={styles.speedButton} data-speed={speedKind(activeTier?.id)}
      aria-label={`${zh?'速度':'Speed'} · ${speedTierName(activeTier,zh)}`}>
      {/* IconButton sizes any svg without a size- class to 16 px; the panel's speed mark is meant to read larger. */}
      <SpeedGlyph tier={activeTier?.id} size={18} className="size-[18px]"/>
    </IconButton></DropdownMenuTrigger>
    <DropdownMenuContent side="right" align="start" sideOffset={6} alignOffset={-6} className={styles.speedMenu} aria-label={zh?'速度':'Speed'}>
      <DropdownMenuRadioGroup value={activeTier?.id??STANDARD_SPEED} onValueChange={value=>onChange(value===STANDARD_SPEED?null:value)}>
        {rows.map(tier=>{
          const available=tier===null||controls.availableTiers.includes(tier.id);
          const name=speedTierName(tier,zh);
          const line=available?speedTierHint(tier,zh):tierUnavailableReason(controls,tier!.id,zh);
          return <DropdownMenuRadioItem key={tier?.id??STANDARD_SPEED} value={tier?.id??STANDARD_SPEED} disabled={!available} textValue={name} className={styles.speedRow}>
            <SpeedGlyph tier={tier?.id} size={16} className={styles.speedRowGlyph}/>
            <span className={styles.speedRowText}>
              <span className={styles.speedRowName}>{name}</span>
              {line?<span className={styles.speedRowHint}>{line}</span>:null}
            </span>
          </DropdownMenuRadioItem>;
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Multi-depth particles streaming rightward into the slider thumb:
 *  [left%, top%, sizePx, stretchFactor, travelDxPx, driftDyPx, phase01, periodFactor, streak] */
const PARTICLES:ReadonlyArray<readonly [number,number,number,number,number,number,number,number,boolean]>=[
  [5,28,2.2,1.1,48,-2,0.06,0.92,false],
  [12,68,1.6,0.8,42,2,0.44,1.12,false],
  [18,46,1.6,3.8,68,0,0.21,0.78,true],
  [24,22,2.4,1.3,52,2.5,0.68,0.96,false],
  [31,76,1.8,1.0,44,-2,0.83,1.18,false],
  [36,52,1.5,4.4,74,0,0.52,0.74,true],
  [42,30,2.0,1.2,50,-1.5,0.14,1.04,false],
  [48,66,2.5,1.4,54,2,0.35,0.88,false],
  [54,40,1.6,4.2,72,0,0.77,0.76,true],
  [59,20,1.7,0.9,46,2,0.91,1.15,false],
  [64,74,2.1,1.2,48,-2.5,0.29,0.94,false],
  [69,50,1.5,4.6,76,0,0.61,0.72,true],
  [74,32,2.3,1.3,44,1.5,0.09,0.98,false],
  [79,64,1.7,1.0,38,-1.5,0.48,1.08,false],
];

function effortMotion(step:RunOption|null,fill:number):{intensity:number;speed:number}{
  if(!step)return {intensity:0,speed:0};
  const key=step.id.toLowerCase();
  const intensity=EFFORT_INTENSITY[key]??Math.max(0.2,fill);
  const speed=EFFORT_FLOW_SPEED[key]??(intensity<=0?0:0.85+intensity*4.2);
  return {intensity,speed};
}

/** The chip beside the model name and its panel: effort as a filled slider, speed behind the button at the
 *  top left, the model the two apply to under the title. A model with speed tiers but no effort ladder gets
 *  the same panel without the slider. */
function RunControl({controls,zh,modelLabel,onEffortChange,onSpeedChange,onOpenModelMenu}:{controls:AgentRunControls;zh:boolean;modelLabel:string;onEffortChange(reasoning:string|null):void;onSpeedChange(serviceTier:string|null):void;onOpenModelMenu():void}){
  const {steps,saved,recommended}=controls;
  const [open,setOpen]=useState(false);
  const handingOff=useRef(false);
  const range=useRef<HTMLInputElement|null>(null);
  const ladderSteps=steps.filter(step=>step.reasoningControlKind!=='mode');
  const modeSteps=steps.filter(step=>step.reasoningControlKind==='mode');
  const hasEffort=ladderSteps.length>0;
  const activeId=saved??recommended;
  const active=activeId?steps.find(step=>step.id===activeId)??null:null;
  const isModeActive=active?.reasoningControlKind==='mode';
  const sliderTargetId=isModeActive&&active?active.id.replace(/^between_tools_/,''):activeId;
  const index=sliderTargetId?ladderSteps.findIndex(step=>step.id===sliderTargetId):-1;
  const label=active?effortLabel(active,zh):(zh?'自动':'Auto');
  const copy=active?EFFORT_COPY[active.id.toLowerCase()]:undefined;
  const activeTier=controls.tiers.find(tier=>tier.id===controls.tier)??null;
  const speedName=speedTierName(activeTier,zh);
  const speedLabel=`${zh?'速度':'Speed'} · ${speedName}`;
  const hint=!hasEffort
    ?[speedName,speedTierHint(activeTier,zh)].filter(Boolean).join(' · ')
    :active?(copy?(zh?copy.hintZh:copy.hintEn):''):(zh?'不指定强度，由客户端按模型决定':'No effort is passed; the client decides per model');
  const recommendedIndex=recommended?ladderSteps.findIndex(step=>step.id===recommended):-1;
  const placeholder=Math.floor((ladderSteps.length-1)/2);
  const pick=(value:string)=>{
    const step=ladderSteps[Number(value)];
    if(!step)return;
    if(isModeActive){
      const paired=modeSteps.find(candidate=>candidate.id===`between_tools_${step.id}`);
      onEffortChange(paired?paired.id:step.id);
      return;
    }
    onEffortChange(step.id);
  };
  const toggleBetweenTools=(betweenTools:boolean)=>{
    if(!betweenTools){
      const baseId=active?.id.replace(/^between_tools_/, '')??'';
      const target=ladderSteps.find(step=>step.id===baseId)??ladderSteps[placeholder];
      if(target)onEffortChange(target.id);
      return;
    }
    const currentBase=active?.id.replace(/^between_tools_/, '')??'';
    const paired=modeSteps.find(step=>step.id===`between_tools_${currentBase}`)??modeSteps[modeSteps.length-1];
    if(paired)onEffortChange(paired.id);
  };
  const fill=index>=0?at(index,ladderSteps.length):0;
  const {intensity,speed}=effortMotion(active,fill);
  const flowDuration=speed>0?Number((2.6/speed).toFixed(3)):0;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button size="sm" variant="ghost" className={styles.effortTrigger} data-level={active?.id} data-speed={speedKind(activeTier?.id)}
      aria-label={hasEffort?`${zh?'推理强度':'Reasoning effort'} · ${label} · ${speedLabel}`:`${zh?'速度设置':'Speed settings'} · ${speedName}`}>
      {activeTier||!hasEffort?<SpeedGlyph tier={activeTier?.id} size={14} className={styles.chipGlyph}/>:null}
      <span className={styles.effortChipLabel}>{hasEffort?label:speedName}</span>
    </Button></PopoverTrigger>
    <PopoverContent width={280} align="end" className={styles.effortPanel}
      onOpenAutoFocus={event=>{if(range.current){event.preventDefault();range.current.focus({preventScroll:true});}}}
      onCloseAutoFocus={event=>{if(handingOff.current){handingOff.current=false;event.preventDefault();}}}>
      <div className={styles.runHead}>
        <SpeedMenu controls={controls} zh={zh} onChange={onSpeedChange}/>
        <div className={styles.runTitle}>
          <span className={styles.runValue} data-level={hasEffort?active?.id:undefined}>{hasEffort?label:(zh?'速度':'Speed')}</span>
          <button type="button" className={styles.runModel} title={modelLabel} aria-label={`${zh?'切换模型':'Change model'} · ${modelLabel}`}
            onClick={()=>{handingOff.current=true;setOpen(false);onOpenModelMenu();}}>
            <span className={styles.runModelLabel}>{modelLabel}</span><Icon icon={ChevronRight} size="sm" className={styles.runModelChevron}/>
          </button>
        </div>
        <span className={styles.runEnd}>
          {hasEffort&&saved!==null&&saved!==recommended?<IconButton size="md" className={styles.effortReset} onClick={()=>onEffortChange(null)} aria-label={zh?'恢复默认强度':'Reset to default effort'}><RotateCcw/></IconButton>:null}
        </span>
      </div>
      {hasEffort?<>
        <div className={styles.slider} data-unset={index<0} data-paused={speed<=0} data-effort-level={active?.id}
          style={{
            '--effort-fill':String(fill),
            '--effort-intensity':intensity.toFixed(3),
            '--effort-flow-duration':flowDuration>0?`${flowDuration}s`:'0s',
          } as CSSProperties}>
          <span className={styles.track} aria-hidden>
            <span className={styles.sliderFill}>
              <span className={styles.sliderFlow}/>
              <span className={styles.sliderGlow}/>
              {PARTICLES.map(([x,y,size,stretch,dx,dy,phase,periodFactor,streak],i)=>{
                const duration=speed>0?Number(((2.4*periodFactor)/speed).toFixed(3)):0;
                const delay=duration>0?-Number((phase*duration).toFixed(3)):0;
                const travel=Math.round(dx*(0.65+intensity*0.65));
                const peak=streak?Math.min(0.95,0.22+intensity*0.74):Math.min(0.95,0.45+intensity*0.5);
                return <span key={i} className={styles.sparkle} data-streak={streak||undefined}
                  style={{
                    left:`${x}%`,
                    top:`${y}%`,
                    '--spark-size':`${size}px`,
                    '--spark-stretch':String(stretch),
                    '--spark-dx':`${travel}px`,
                    '--spark-dy':`${dy}px`,
                    '--spark-peak':peak.toFixed(2),
                    animationDelay:`${delay}s`,
                    animationDuration:duration>0?`${duration}s`:'0s',
                  } as CSSProperties}/>;
              })}
            </span>
          </span>
          <span className={styles.stops} aria-hidden>{ladderSteps.map((step,i)=><span key={step.id} className={styles.stop} data-recommended={i===recommendedIndex} data-filled={index>=0&&i<index} style={{'--effort-at':String(at(i,ladderSteps.length))} as CSSProperties}/>)}</span>
          <input ref={range} type="range" className={styles.range} min={0} max={Math.max(0,ladderSteps.length-1)} step={1}
            value={index>=0?index:placeholder} aria-label={zh?'推理强度':'Reasoning effort'} aria-valuetext={label}
            onChange={event=>pick(event.currentTarget.value)}
            onPointerUp={event=>{if(index<0)pick(event.currentTarget.value);}}/>
        </div>
        {recommendedIndex>=0?<div className={styles.marks} aria-hidden><span className={styles.recommended} style={{'--effort-at':String(at(recommendedIndex,ladderSteps.length))} as CSSProperties}>{zh?'推荐':'Recommended'}</span></div>:null}
        {modeSteps.length>0?<div className={styles.modeScope} role="group" aria-label={zh?'思考范围':'Thinking scope'}>
          <button type="button" className={styles.modePill} aria-pressed={!isModeActive} onClick={()=>toggleBetweenTools(false)}>{zh?'全程思考':'Full turn'}</button>
          <button type="button" className={styles.modePill} aria-pressed={isModeActive} onClick={()=>toggleBetweenTools(true)}>{zh?'仅工具间':'Between tools'}</button>
        </div>:null}
      </>:null}
      {hint?<p className={styles.effortHint}>{hint}</p>:null}
    </PopoverContent>
  </Popover>;
}

export function MovieChannelSwitcher({config,agents,onConfigChange,onOpenSettings,providerModelsCache={},onProviderModelsCacheChange,openSignal=0}:{config:AppConfig;agents:AgentInfo[];onConfigChange(config:AppConfig):void;onOpenSettings():void;providerModelsCache?:ProviderModelsCache;onProviderModelsCacheChange?:Dispatch<SetStateAction<ProviderModelsCache>>;openSignal?:number}) {
  const {locale}=useI18n(),zh=locale.startsWith('zh');
  const [open,setOpen]=useState(false);
  const snapshot=useMemo(()=>nativeChannelOptions(config,agents,providerModelsCache),[config,agents,providerModelsCache]);
  const [expanded,setExpanded]=useState<string|null>(null);
  const [expandedSupplier,setExpandedSupplier]=useState<string|null>(null);
  const [nestedRightPad,setNestedRightPad]=useState(12);
  const menuRef=useRef<HTMLDivElement|null>(null);
  const supplierMenuRef=useRef<HTMLDivElement|null>(null);
  const openingCurrentSub=useRef(false);
  useEffect(()=>{if(openSignal){setOpen(true);setExpanded(null);setExpandedSupplier(null);}},[openSignal]);
  const fetching=useRef(new Set<string>());
  const current=snapshot.channels.find(c=>c.id===snapshot.selectedId);
  const others=snapshot.channels.filter(c=>c.id!==snapshot.selectedId);
  const label=!current?(zh?'选择模型':'Choose model'):snapshot.modelId==='default'?(zh?'默认':'Default'):current.models.find(m=>m.id===snapshot.modelId)?.label??snapshot.modelId;
  const controls=useMemo(()=>current?agentRunControls(config,agents,snapshot.modelId):null,[current,config,agents,snapshot.modelId]);
  const tokentoseaModels=snapshot.channels.find(c=>c.id==='agent:tokentosea')?.models;
  const tokentoseaGroups=useMemo(()=>tokentoseaModels?groupModelsByCompany(tokentoseaModels):[],[tokentoseaModels]);
  // A concrete id saved before the daemon folded variants reads as its family here, so it is never "unknown"
  // and never rewritten to the first model; the family form is written once the user changes something.
  const persistedModel = config.mode === 'api' ? config.model : savedAgentChoice(config, agents, config.agentId)?.model;
  useEffect(() => {
    if (!current || !persistedModel || persistedModel === 'default' || persistedModel === snapshot.modelId) return;
    const next = selectChannelModel(config, agents, current.id, snapshot.modelId, providerModelsCache);
    if (next !== config) onConfigChange(next);
  }, [config, agents, current, persistedModel, snapshot.modelId, providerModelsCache, onConfigChange]);
  useEffect(()=>{
    if(!open||!onProviderModelsCacheChange)return;
    for(const id of new Set([expanded,snapshot.selectedId])){
      if(!id?.startsWith('api-'))continue;
      const c=savedMovieChannels(config).find(c=>publicChannelId(c.key)===id);if(!c)continue;
      const key=providerModelsCacheKey(c.protocol,c.apiConfig.baseUrl,c.apiConfig.apiKey,c.apiConfig.apiVersion);
      if(providerModelsCache[key]!==undefined||fetching.current.has(key)||byokPreflightBlockReason({...c.apiConfig,apiProtocol:c.protocol})!==null)continue;
      fetching.current.add(key);
      void fetchProviderModels({protocol:c.protocol,baseUrl:c.apiConfig.baseUrl,apiKey:c.apiConfig.apiKey,apiVersion:c.apiConfig.apiVersion}).then(result=>{if(result.ok&&result.models)onProviderModelsCacheChange(cache=>({...cache,[key]:result.models!}));}).catch(()=>{}).finally(()=>fetching.current.delete(key));
    }
  },[open,expanded,snapshot.selectedId,config,providerModelsCache,onProviderModelsCacheChange]);
  useEffect(()=>{
    if(!open||!openingCurrentSub.current)return;
    openingCurrentSub.current=false;
    setExpanded(current?.id??null);
    setExpandedSupplier(current?.id==='agent:tokentosea'&&tokentoseaGroups.length>1?modelCompany(snapshot.modelId,label).key:null);
  },[open,current,tokentoseaGroups.length,snapshot.modelId,label]);
  useEffect(()=>{
    if(!open||expanded!=='agent:tokentosea'){setNestedRightPad(12);return;}
    const sync=()=>setNestedRightPad(computeNestedRightPadding(menuRef.current,supplierMenuRef.current));
    sync();
    const frame=window.requestAnimationFrame(sync);
    return ()=>window.cancelAnimationFrame(frame);
  },[open,expanded,expandedSupplier]);
  const select=(channelId:string,model:string)=>{
    setExpanded(null);
    setExpandedSupplier(null);
    setOpen(false);
    const next=selectChannelModel(config,agents,channelId,model,providerModelsCache);
    if(next!==config)onConfigChange(next);
  };
  const modelRows=(models:{id:string;label:string}[],className:string,stripSupplier=false)=>models.map(model=>{
    if(model.id==='default'){
      return <DropdownMenuRadioItem key={model.id} value={model.id} textValue={zh?'默认':'Default'} className={className} description={zh?'使用渠道配置':'Channel settings'}>{zh?'默认':'Default'}</DropdownMenuRadioItem>;
    }
    const itemLabel=stripSupplier&&/^supplier:/i.test(model.id)&&model.label.includes(' · ')?model.label.slice(model.label.indexOf(' · ')+3):model.label;
    return <DropdownMenuRadioItem key={model.id} value={model.id} textValue={itemLabel} className={className}><span className={styles.modelLabel} title={model.label}>{itemLabel}</span></DropdownMenuRadioItem>;
  });
  const onChannelOpenChange=(channelId:string,value:boolean)=>{
    setExpanded(prev=>{
      const next=value?channelId:(prev===channelId?null:prev);
      if(next!=='agent:tokentosea')setExpandedSupplier(null);
      return next;
    });
  };
  const renderChannelSubContent=(channel:typeof snapshot.channels[number])=>{
    const isCurrent=channel.id===current?.id;
    const activeValue=isCurrent?snapshot.modelId:'';
    if(channel.id==='agent:tokentosea'&&tokentoseaGroups.length>1){
      const rightPad=Math.max(nestedRightPad,computeNestedRightPadding(menuRef.current,supplierMenuRef.current));
      const subCollision=rightPad>12?{top:12,bottom:12,left:12,right:rightPad}:12;
      return <DropdownMenuSubContent ref={supplierMenuRef} className={styles.suppliers} aria-label={channel.label}>
        {tokentoseaGroups.map(group=>{
          const hasActive=isCurrent&&group.options.some(option=>option.id===snapshot.modelId);
          return <DropdownMenuSub key={group.key} open={expandedSupplier===group.key}
            onOpenChange={value=>setExpandedSupplier(prev=>value?group.key:(prev===group.key?null:prev))}>
            <DropdownMenuSubTrigger className={styles.supplierRow} data-active={hasActive||undefined} textValue={group.name}>
              <span className={styles.channelLabel} title={group.name}>{group.name}</span>
              {hasActive?<span className={styles.supplierDot} aria-hidden />:null}
              <span className={styles.supplierCount} aria-hidden>{group.options.length}</span>
            </DropdownMenuSubTrigger>
            {/* The extra right padding steers the model menu left, but puts
                the supplier row outside the padded bounds used by Popper's
                reference-hidden check. */}
            <DropdownMenuSubContent
              className={styles.models}
              aria-label={`${channel.label} · ${group.name}`}
              collisionPadding={subCollision}
              hideWhenDetached={rightPad <= 12}
            >
              <DropdownMenuRadioGroup value={activeValue} onValueChange={model=>select(channel.id,model)}>
                {modelRows(group.options,styles.modelRow!,true)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>;
        })}
      </DropdownMenuSubContent>;
    }
    return <DropdownMenuSubContent className={styles.models} aria-label={channel.label}>
      <DropdownMenuRadioGroup value={activeValue} onValueChange={model=>select(channel.id,model)}>
        {modelRows(channel.models,styles.modelRow!)}
      </DropdownMenuRadioGroup>
    </DropdownMenuSubContent>;
  };
  return <span className={styles.cluster}>
    <DropdownMenu open={open} onOpenChange={value=>{setOpen(value);if(!value){setExpanded(null);setExpandedSupplier(null);}}}>
      <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={styles.trigger} aria-label={`${current?.label??(zh?'选择渠道与模型':'Choose channel and model')} · ${label}`}>
        <span className={styles.dot} data-ready={current?.available===true} />
        {config.mode==='daemon'&&config.agentId?<AgentIcon id={config.agentId} size={16}/>:<Icon icon={Link} size="sm"/>}<span className={styles.current}>{label}</span>
        <Icon icon={ChevronDown} size="sm" className={styles.chevron}/>
      </Button></DropdownMenuTrigger>
      <DropdownMenuContent ref={menuRef} className={styles.menu} align="end">
        {current?<DropdownMenuSub open={expanded===current.id} onOpenChange={value=>onChannelOpenChange(current.id,value)}>
          <DropdownMenuSubTrigger className={styles.currentGroup} textValue={current.label}>
            <span className={styles.channelIcon} aria-hidden>{current.id.startsWith('agent:')?<AgentIcon id={current.id.slice(6)} size={16}/>:<Icon icon={Link} size="sm"/>}</span>
            <span className={styles.channelLabel} title={current.label}>{current.label}</span>
            <span className={styles.headModel} title={label} aria-hidden>{label}</span>
          </DropdownMenuSubTrigger>
          {renderChannelSubContent(current)}
        </DropdownMenuSub>:null}
        {others.length>0?<>
          {current?<DropdownMenuSeparator className={styles.separator}/>:null}
          <DropdownMenuCaption className={styles.caption}>{current?(zh?'其他渠道':'Other channels'):(zh?'渠道':'Channels')}</DropdownMenuCaption>
          {others.map(channel=><DropdownMenuSub key={channel.id} open={expanded===channel.id} onOpenChange={value=>onChannelOpenChange(channel.id,value)}>
            <DropdownMenuSubTrigger className={styles.group} textValue={channel.label}>
              <span className={styles.channelIcon} aria-hidden>{channel.id.startsWith('agent:')?<AgentIcon id={channel.id.slice(6)} size={16}/>:<Icon icon={Link} size="sm"/>}</span>
              <span className={styles.channelLabel} title={channel.label}>{channel.label}</span>
            </DropdownMenuSubTrigger>
            {renderChannelSubContent(channel)}
          </DropdownMenuSub>)}
        </>:null}
        {snapshot.channels.length===0?<div className={styles.empty} role="status">{zh?'暂无已配置的可用模型':'No configured models available'}</div>:null}
        <DropdownMenuItem className={styles.manage} onSelect={onOpenSettings}>{zh?'管理渠道与模型…':'Manage channels and models…'}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {controls&&(controls.steps.length>0||controls.tiers.length>0)
      ?usesNamedThinkingMenu(controls)
        ?<ThinkingControl controls={controls} zh={zh} onChange={reasoning=>onConfigChange(withAgentRunChoice(config,controls.agentId,{reasoning},agents,snapshot.modelId))}/>
        :<RunControl controls={controls} zh={zh} modelLabel={label}
          onEffortChange={reasoning=>onConfigChange(withAgentRunChoice(config,controls.agentId,{reasoning},agents,snapshot.modelId))}
          onSpeedChange={serviceTier=>onConfigChange(withAgentRunChoice(config,controls.agentId,{serviceTier},agents,snapshot.modelId))}
          onOpenModelMenu={()=>{
            openingCurrentSub.current=true;
            setOpen(true);
          }}/>
      :null}
  </span>;
}
