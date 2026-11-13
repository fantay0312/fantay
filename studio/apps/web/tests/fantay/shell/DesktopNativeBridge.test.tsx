// @vitest-environment jsdom
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DesktopNativeBridge} from '../../../src/fantay/shell/DesktopNativeBridge';
import type {AppConfig} from '../../../src/types';
const state=vi.hoisted(()=>({theme:'dark',platform:'darwin',setTheme:vi.fn(),navigate:vi.fn()}));
vi.mock('../../../src/router',()=>({navigate:state.navigate}));
vi.mock('@open-design/host',()=>({getOpenDesignHost:()=>({client:{type:'desktop',platform:state.platform}})}));
vi.mock('../../../src/fantay/theme/theme',()=>({useTheme:()=>({preference:state.theme,setPreference:state.setTheme})}));
vi.mock('../../../src/components/movie/MovieChannelSwitcher',()=>({nativeChannelOptions:()=>({channels:[]}),selectChannelModel:vi.fn(),selectMovieChannel:vi.fn(),savedMovieChannels:()=>[],publicChannelId:()=>''}));
const request=vi.fn(async(_url:unknown,_init?:RequestInit)=>new Response(JSON.stringify({actions:[]}),{status:200}));
beforeEach(()=>{state.theme='dark';state.platform='darwin';state.navigate.mockClear();request.mockReset().mockImplementation(async()=>new Response(JSON.stringify({actions:[]}),{status:200}));vi.stubGlobal('fetch',request);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
const props={config:{} as AppConfig,agents:[],providerModelsCache:{},onConfigPersist:vi.fn(),onOpenSettings:vi.fn()};
it('keeps syncing theme preferences when a non-project page is rendered',async()=>{
 const view=render(<DesktopNativeBridge {...props}/>);
 await waitFor(()=>expect(request).toHaveBeenCalled());
 state.theme='light';view.rerender(<DesktopNativeBridge {...props}/>);
 await waitFor(()=>expect(request.mock.calls.filter(([url])=>url==='/api/tokentosea/native/sync').some(([,init])=>JSON.parse(String(init?.body)).theme==='light')).toBe(true));
});
it('refreshes the same account snapshot on login changes outside the movie page',async()=>{
 render(<DesktopNativeBridge {...props}/>);
 const before=request.mock.calls.length;
 await act(async()=>window.dispatchEvent(new Event('fantay:tokentosea-session-changed')));
 expect(request.mock.calls.length).toBeGreaterThan(before);
});
it('returns the native home action to the main video library',async()=>{
 vi.useFakeTimers();
 request.mockImplementation(async(url)=>new Response(JSON.stringify({actions:url==='/api/tokentosea/native/action'?[{action:'open-movies'}]:[]}),{status:200}));
 render(<DesktopNativeBridge {...props}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(state.navigate).toHaveBeenCalledWith({kind:'home',view:'movies'});
});
it('does not start macOS native editor polling on Windows',async()=>{
 vi.useFakeTimers();state.platform='win32';
 render(<DesktopNativeBridge {...props}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(request).not.toHaveBeenCalled();
 expect(vi.getTimerCount()).toBe(0);
});
it('keeps only one native action request in flight even when the config changes',async()=>{
 vi.useFakeTimers();
 let finishRequest!:(response:Response)=>void;
 request.mockImplementation(async(url)=>url==='/api/tokentosea/native/action'
  ?new Promise<Response>(resolve=>{finishRequest=resolve;})
  :new Response(JSON.stringify({}),{status:200}));
 const view=render(<DesktopNativeBridge {...props}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 view.rerender(<DesktopNativeBridge {...props} config={{...props.config,model:'updated'}}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
 expect(request.mock.calls.filter(([url])=>url==='/api/tokentosea/native/action')).toHaveLength(1);
 await act(async()=>{finishRequest(new Response(JSON.stringify({actions:[]}),{status:200}));});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(request.mock.calls.filter(([url])=>url==='/api/tokentosea/native/action')).toHaveLength(2);
});
