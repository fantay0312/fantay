// SPDX-License-Identifier: AGPL-3.0-only
import {useEffect,useRef} from 'react';
import {getOpenDesignHost} from '@open-design/host';
import type {AgentInfo,AppConfig} from '../../types';
import type {ProviderModelsCache} from '../../components/providerModelsCache';
import {nativeChannelOptions,selectChannelModel} from '../../components/movie/MovieChannelSwitcher';
import {navigate} from '../../router';
import {useTheme} from '../theme/theme';

/** Lives above page routing so account/settings never suspend native sync. */
export function DesktopNativeBridge({config,agents,providerModelsCache,onConfigPersist,onOpenSettings}:{
  config:AppConfig;agents:AgentInfo[];providerModelsCache:ProviderModelsCache;
  onConfigPersist(config:AppConfig):void;onOpenSettings(section:'account'|'execution'|'usage'):void;
}) {
  const {preference:themePreference,setPreference:setThemePreference}=useTheme();
  const actionPending=useRef(false);
  useEffect(()=>{
    const client=getOpenDesignHost()?.client;
    if(client?.type!=='desktop'||client.platform!=='darwin')return;
    const sync=()=>{void fetch('/api/tokentosea/native/sync',{method:'POST',headers:{'Content-Type':'application/json','X-OD-Client':'desktop'},body:JSON.stringify({...nativeChannelOptions(config,agents,providerModelsCache),theme:themePreference})}).catch(()=>{});};
    const action=async()=>{
      if(actionPending.current)return;
      actionPending.current=true;
      try{
      const response=await fetch('/api/tokentosea/native/action',{method:'POST',headers:{'X-OD-Client':'desktop'}});if(!response.ok)return;
      const items=(await response.json()).actions??[];
      let nextConfig=config;
      for(const item of items){
        if(item.action==='select-execution'){try{const value=JSON.parse(item.value);nextConfig=selectChannelModel(nextConfig,agents,value.channelId,value.modelId,providerModelsCache);}catch{}}
        if(item.action==='select-channel'){
          const channel=nativeChannelOptions(nextConfig,agents,providerModelsCache).channels.find(c=>c.id===item.value);
          if(channel?.models[0])nextConfig=selectChannelModel(nextConfig,agents,channel.id,channel.models[0].id,providerModelsCache);
        }
        if(item.action==='select-model'){
          const snapshot=nativeChannelOptions(nextConfig,agents,providerModelsCache);
          nextConfig=selectChannelModel(nextConfig,agents,snapshot.selectedId,item.value,providerModelsCache);
        }
      }
      if(nextConfig!==config){onConfigPersist(nextConfig);await new Promise(resolve=>setTimeout(resolve,0));}
      for(const item of items){
        if(item.action==='open-account')onOpenSettings('account');
        if(item.action==='open-usage')onOpenSettings('usage');
        if(item.action==='open-movies')navigate({kind:'home',view:'movies'});
        if(item.action==='open-channels')onOpenSettings('execution');
        if(item.action==='set-theme'){if(item.value==='light'||item.value==='dark')setThemePreference(item.value);else if(item.value==='system')setThemePreference('light');}
        if(item.projectId&&['chat-send','chat-new','chat-select','chat-stop','open-generation'].includes(item.action)){
          sessionStorage.setItem('fantay:native-entry',JSON.stringify({projectId:item.projectId,at:Date.now()}));
          sessionStorage.setItem(`fantay:native-action:${item.projectId}`,JSON.stringify(item));
          navigate({kind:'project',projectId:item.projectId,conversationId:null,fileName:'movie-studio.json'});
          window.dispatchEvent(new CustomEvent('fantay-native-action',{detail:item}));
        }
      }
    }catch{}finally{actionPending.current=false;}};
    sync();
    const refresh=window.setInterval(sync,20000),poll=window.setInterval(()=>{void action();},1500);
    window.addEventListener('focus',sync);window.addEventListener('fantay:tokentosea-session-changed',sync);
    return()=>{window.clearInterval(refresh);window.clearInterval(poll);window.removeEventListener('focus',sync);window.removeEventListener('fantay:tokentosea-session-changed',sync);};
  },[config,agents,providerModelsCache,onConfigPersist,onOpenSettings,themePreference,setThemePreference]);
  return null;
}
