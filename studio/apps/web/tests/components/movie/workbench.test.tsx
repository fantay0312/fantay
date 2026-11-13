// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieDocument, type MovieDocument, type MovieVideoSource } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { MovieEditingWorkspace } from '../../../src/components/movie/MovieEditingWorkspace';
import { MovieCompactInspector } from '../../../src/components/movie/MovieCompactInspector';
import { parseMovieSubtitles, movieSubtitlesText } from '../../../src/components/movie/movie-subtitles';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const source:MovieVideoSource={assetId:'source',path:'source.mp4',label:'Garden',kind:'video',duration:6,width:1920,height:1080,fps:30,hasAudio:true,frames:[]};
function film(){const d=createMovieDocument('Workbench');d.style.assets=[{id:'source',path:'source.mp4'}];d.shots=[{id:'clip',title:'Garden',body:'',layout:'split',duration:6,clip:{assetId:'source',in:0,rate:1,volume:1,fit:'contain'},captions:[{id:'caption',start:0,end:3,text:'Speech'}]}];return d;}
function workspace(d:MovieDocument,onAddSource=vi.fn()) { return <I18nProvider initial="zh-CN"><MovieEditingWorkspace document={d} projectId="workbench" selectedShotId="clip" sources={[source]} preview={<div>Timeline preview</div>} timeline={<div>Shared timeline</div>} inspector={<div>Shared inspector</div>} generation={null} compact time={0} playing={false} disabled={false} error="" dirty={false} aiBusy={false} generationBusy={false} onImport={vi.fn()} onAddSource={onAddSource} onPlay={vi.fn()} onSeek={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onPlan={vi.fn()} onReview={vi.fn()} onAi={vi.fn(async()=>true)}/></I18nProvider>; }

it('turns a widened project pane into the complete workbench and restores the compact pane when narrowed',async()=>{
  const observers:Array<{cb:ResizeObserverCallback;element?:Element}>=[];
  vi.stubGlobal('ResizeObserver',class{item:{cb:ResizeObserverCallback;element?:Element};constructor(cb:ResizeObserverCallback){this.item={cb};observers.push(this.item);}observe(element:Element){this.item.element=element;}disconnect(){}unobserve(){}});
  render(workspace(film()));const root=screen.getByTestId('movie-editing-workspace');let width=600;Object.defineProperty(root,'clientWidth',{configurable:true,get:()=>width});
  const resize=()=>act(()=>{for(const o of observers.filter(o=>o.element===root))o.cb([],{} as ResizeObserver);});
  resize();expect(root).toHaveAttribute('data-workbench','false');
  width=1200;resize();await waitFor(()=>expect(root).toHaveAttribute('data-workbench','true'));expect(root).toHaveAttribute('data-media-open','true');
  width=600;resize();await waitFor(()=>expect(root).toHaveAttribute('data-workbench','false'));expect(root).toHaveAttribute('data-media-open','false');expect(screen.getByText('Shared timeline')).toBeTruthy();
});

it('previews a source and adds the chosen in/out range through the shared editing callback',async()=>{
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  const add=vi.fn();render(workspace(film(),add));
  expect(screen.queryByRole('button',{name:'素材 Garden'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'素材与效果'}));
  fireEvent.click(screen.getByRole('button',{name:'素材 Garden'}));
  fireEvent.change(await screen.findByRole('spinbutton',{name:'素材入点'}),{target:{value:'1'}});
  fireEvent.change(screen.getByRole('spinbutton',{name:'素材出点'}),{target:{value:'4'}});
  fireEvent.click(screen.getByRole('button',{name:'添加片段'}));
  expect(add).toHaveBeenCalledWith(source,{in:1,duration:3},'append');
});

it('changes speed while preserving the selected source interval and caption timing in one edit batch',async()=>{
  const apply=vi.fn(async(_label:string,_operations:unknown[])=>true);render(<I18nProvider initial="zh-CN"><MovieCompactInspector document={film()} selectedShotId="clip" busy={false} readOnly={false} onApply={apply} onDirtyChange={vi.fn()}/></I18nProvider>);
  fireEvent.change(screen.getByLabelText('速度'),{target:{value:'2'}});fireEvent.click(await screen.findByRole('button',{name:'应用'}));
  await waitFor(()=>expect(apply).toHaveBeenCalled());const operations=apply.mock.calls[0]?.[1] as unknown as Array<{op:string;changes?:Record<string,unknown>}>;
  expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({op:'update-shot',changes:expect.objectContaining({duration:3})}),expect.objectContaining({op:'update-clip',changes:expect.objectContaining({rate:2})})]));
});

it('round-trips SRT text and rejects overlapping or out-of-clip captions',()=>{
  const text='1\n00:00:00,500 --> 00:00:01,500\n中文字幕\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond';
  const cues=parseMovieSubtitles(text,4);expect(parseMovieSubtitles(movieSubtitlesText(cues),4)).toEqual(cues);
  expect(()=>parseMovieSubtitles(text,1)).toThrow();expect(()=>parseMovieSubtitles('1\n00:00:00,000 --> 00:00:02,000\na\n\n2\n00:00:01,000 --> 00:00:03,000\nb',4)).toThrow();
});
