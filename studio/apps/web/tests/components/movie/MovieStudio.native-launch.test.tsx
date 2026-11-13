// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createMovieDocument,type MovieDocument} from '@open-design/contracts';
import {MovieStudio} from '../../../src/components/movie/MovieStudio';
import {I18nProvider} from '../../../src/i18n';

const host = vi.hoisted(() => ({ platform: 'darwin' }));
vi.mock('@open-design/host',async original=>({...await original<typeof import('@open-design/host')>(),getOpenDesignHost:()=>({client:{type:'desktop',platform:host.platform}})}));
vi.mock('../../../src/providers/movie',async original=>({...await original<typeof import('../../../src/providers/movie')>(),movieRequest:vi.fn(async()=>film()),getMovieVideoSources:vi.fn(async()=>[])}));
vi.mock('../../../src/state/projects',()=>({listConversations:vi.fn(async()=>[]),listProjects:vi.fn(async()=>[])}));
vi.mock('../../../src/components/workspace/SideChatTab',()=>({SideChatTab:()=>null}));
vi.mock('../../../src/components/movie/MovieConnection',()=>({MovieConnection:()=>null}));
vi.mock('../../../src/components/materials/MaterialPickerDialog',()=>({MaterialPickerDialog:()=>null}));
function film():MovieDocument {
 const base=createMovieDocument('Native film');
 return {...base,shots:[],style:{...base.style,assets:[{id:'source',path:'video-sources/clip.mp4',label:'Clip'}]}} as MovieDocument;
}
const request=vi.fn(async(input:unknown,_init?:unknown)=>new Response(JSON.stringify(String(input).endsWith('/editor/initialize') ? {document:film()} : {supported:true,project:{path:'/owned/film.palmier'}}),{status:200}));
beforeEach(()=>{host.platform='darwin';vi.stubGlobal('fetch',request);request.mockClear();sessionStorage.clear();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function editor(){return <I18nProvider initial="zh-CN"><MovieStudio presentation="project" projectId="native-test" isActive chat={{mode:'main',busy:false,send:vi.fn(async()=>({accepted:true as const})),reveal:vi.fn()}}/></I18nProvider>;}
const opens=()=>request.mock.calls.filter(args=>String(args[0]).endsWith('/native/open'));
it.each(['darwin','win32'])('keeps all editing inside the project on %s and never offers a second editor',async platform=>{
 host.platform=platform;
 const rendered=render(editor());
 await screen.findByTestId('movie-editing-workspace');
 await screen.findByRole('slider',{name:'播放位置'});
 expect(opens()).toHaveLength(0);
 rendered.rerender(editor());
 expect(opens()).toHaveLength(0);
 expect(screen.queryByRole('button',{name:'打开 Fantay 剪辑'})).toBeNull();
 expect(screen.getAllByRole('button',{name:'导入素材'}).length).toBeGreaterThan(0);
 expect(screen.getByRole('button',{name:'片段与项目调整'})).toBeTruthy();
 expect(opens()).toHaveLength(0);
 expect(screen.queryByTestId('native-movie-workspace')).toBeNull();
});
it('leaves AI editing to the project chat: the project editor has no AI entry of its own',async()=>{
 const send=vi.fn(async(_prompt:string)=>({accepted:true as const}));
 render(<I18nProvider initial="zh-CN"><MovieStudio presentation="project" projectId="native-test" isActive chat={{mode:'main',busy:false,send,reveal:vi.fn()}}/></I18nProvider>);
 await screen.findByTestId('movie-editing-workspace');
 expect(screen.queryByRole('button',{name:/^AI$/})).toBeNull();
 expect(screen.queryByRole('button',{name:'发送到项目对话'})).toBeNull();
 expect(screen.queryByRole('textbox',{name:'AI 剪辑要求'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'片段与项目调整'}));
 expect(send).not.toHaveBeenCalled();
 expect(opens()).toHaveLength(0);
});
it('initializes the editable desktop project after viewer permissions settle',async()=>{
 const props={presentation:'project' as const,projectId:'native-test',isActive:true,chat:{mode:'main' as const,busy:false,send:vi.fn(async()=>({accepted:true as const})),reveal:vi.fn()}};
 const rendered=render(<I18nProvider initial="zh-CN"><MovieStudio {...props} readOnly/></I18nProvider>);
 await screen.findByTestId('movie-editing-workspace');
 expect(request.mock.calls.some(args=>String(args[0]).endsWith('/editor/initialize'))).toBe(false);
 rendered.rerender(<I18nProvider initial="zh-CN"><MovieStudio {...props} readOnly={false}/></I18nProvider>);
 await waitFor(()=>expect(request.mock.calls.filter(args=>String(args[0]).endsWith('/editor/initialize'))).toHaveLength(1));
});
it('does not steal focus when a native chat or generation action returns to the host',async()=>{
 sessionStorage.setItem('fantay:native-entry',JSON.stringify({projectId:'native-test',at:Date.now()}));
 render(editor());
 await screen.findByTestId('movie-editing-workspace');
 await waitFor(()=>expect(request).toHaveBeenCalled());
 expect(opens()).toHaveLength(0);
});
