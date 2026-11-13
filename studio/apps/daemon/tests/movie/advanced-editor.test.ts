import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMovieDocument, buildMovieHtml, movieClipPose, movieNextShotIndex, movieTransitionDuration, type MovieDocument } from '@open-design/contracts';
import { editMovie, stepMovieHistory } from '../../src/movie/edits.js';
import { saveMovie, readMovie } from '../../src/movie/store.js';
import { movieFfmpeg } from '../../src/movie/video-sources.js';

const require=createRequire(import.meta.url),{JSDOM}=require('jsdom');
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
function film():MovieDocument {
  const d=createMovieDocument('Advanced film');d.shots=[];d.style={...d.style,background:'#000000',assets:[{id:'source',path:'source.mp4'}],visual:{composition:'minimal',copy:{x:8,y:75,width:84,align:'center',titleSize:3,bodySize:2},layers:[],transition:'cut',copyMode:'none'}};return d;
}
function shot(id:string,start:number,duration:number){return{id,title:id,body:'',layout:'split' as const,duration,placement:{start,track:0},clip:{assetId:'source',in:start,rate:1,volume:0,fit:'contain' as const}};}
function render(d:MovieDocument){
  const dom=new JSDOM(buildMovieHtml(d),{runScripts:'outside-only',pretendToBeVisual:true});
  dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.play=()=>Promise.resolve();
  dom.window.eval(readFileSync(require.resolve('gsap/dist/gsap.min.js'),'utf8'));
  dom.window.eval([...dom.window.document.scripts].find((s:any)=>!s.src)!.textContent!);
  return dom;
}
function close(dom:any){dom.window.__timelines.main.kill();dom.window.gsap.ticker.sleep();dom.window.close();}

it('renders same-track transitions after absolute placement even when shots are not stored in chronological order',()=>{
  const d=film(),out=shot('out',0,2),incoming=shot('in',2,2);
  d.shots=[incoming,{...out,visual:{...d.style.visual!,transition:'crossfade',transitionDuration:.5}},{id:'overlay',kind:'text',title:'Overlay',body:'',layout:'title',duration:4,placement:{start:0,track:2},visual:{...d.style.visual!,copyMode:'caption'}}];
  expect(movieNextShotIndex(d,1)).toBe(0);expect(movieTransitionDuration(d,1)).toBe(.5);
  const dom=render(d);
  try{
    const a=dom.window.document.querySelector('#shot-0'),b=dom.window.document.querySelector('#shot-1'),overlay=dom.window.document.querySelector('#shot-2');
    dom.window.__timelines.main.pause(2.25);
    expect(Number(a.style.opacity)).toBeCloseTo(.5,3);expect(b.style.visibility).toBe('inherit');expect(Number(overlay.style.opacity)).toBe(1);
    expect(Number(a.style.zIndex)).toBeGreaterThan(Number(b.style.zIndex));
    dom.window.__timelines.main.pause(2.7);expect(b.style.visibility).toBe('hidden');
    dom.window.__timelines.main.pause(1);expect(a.style.visibility).toBe('hidden');expect(Number(b.style.opacity)).toBe(1);
  }finally{close(dom);}
});

it('seeks clip keyframes precisely forward and backward without changing other layers',()=>{
  const d=film();d.shots=[{...shot('moving',0,4),clip:{...shot('moving',0,4).clip,keyframes:[{at:0,x:0,opacity:.2},{at:1,x:50,opacity:1}]}}];
  const dom=render(d);
  try{const media=dom.window.document.querySelector('video.media');for(const [time,x,opacity]of[[2,25,.6],[3,37.5,.8],[1,12.5,.4],[0,0,.2]] as const){dom.window.__timelines.main.pause(time);expect(parseFloat(media.style.left)).toBeCloseTo(x,3);expect(Number(media.style.opacity)).toBeCloseTo(opacity,3);}}finally{close(dom);}
});

it('crops intrinsic source pixels inside a separate clip frame and applies color only to media',()=>{
  const d=film();d.shots=[{...shot('crop',0,2),clip:{...shot('crop',0,2).clip,crop:{left:.25,right:.25,top:0,bottom:0},color:{exposure:1,contrast:1.2,saturation:.8,blur:2,grayscale:0}},captions:[{start:0,end:1,text:'Untinted'}]}];
  const dom=render(d);
  try{const box=dom.window.document.querySelector('.clip-frame'),media=box.querySelector('video');Object.defineProperty(box,'clientWidth',{value:1000});Object.defineProperty(box,'clientHeight',{value:1000});Object.defineProperty(media,'videoWidth',{value:1600});Object.defineProperty(media,'videoHeight',{value:900});dom.window.__timelines.main.pause(.5);expect(media.style.clipPath).toBe('inset(0% 25% 0% 25%)');expect(parseFloat(media.style.height)).toBeCloseTo(1000);expect(box.style.filter).toContain('brightness(2)');expect(dom.window.document.querySelector('.movie-caption').style.filter).toBe('');}finally{close(dom);}
});

it('styles subtitles and exposes a deterministic text entrance',()=>{
  const d=film();d.shots=[{id:'text',kind:'text',textAnimation:'typewriter',title:'中文字幕',body:'',layout:'title',duration:3,visual:{...d.style.visual!,copyMode:'caption'},captions:[{start:0,end:2,text:'Caption'}],captionStyle:{fontSize:58,color:'#FFDD55',background:'#000000',backgroundOpacity:.5,y:80,outline:2,align:'center'}}];
  const dom=render(d);try{const chars=[...dom.window.document.querySelectorAll('.title-char')];expect(chars).toHaveLength(4);dom.window.__timelines.main.pause(2);expect(chars.every((c:any)=>Number(c.style.opacity)===1)).toBe(true);dom.window.__timelines.main.pause(0);expect(chars.every((c:any)=>Number(c.style.opacity)===0)).toBe(true);expect(dom.window.document.querySelector('.movie-caption').style.fontSize).toBe('58px');}finally{close(dom);}
});

it('does not manufacture an audio input for an image clip with a nonzero volume setting',()=>{
  const d=film();d.style.assets=[{id:'source',path:'image.png'}];d.shots=[{...shot('image',0,2),media:'image.png',clip:{...shot('image',0,2).clip,volume:1}}];
  const html=buildMovieHtml(d);expect(html).not.toContain('<audio ');expect(html).toContain('name="od-motion-audio" content="silent"');
});

async function stored(){const parent=path.resolve('.tmp');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'advanced-editor-'));roots.push(dir);execFileSync(movieFfmpeg(),['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=30','-t','2','-c:v','libx264',path.join(dir,'source.mp4')]);return dir;}

it('keeps animation poses across a real clip split and records new fields in one undo receipt',async()=>{
  const dir=await stored(),d=film();d.shots=[{...shot('moving',0,2),clip:{...shot('moving',0,2).clip,keyframes:[{at:0,x:0},{at:1,x:40}]}}];
  const saved=await saveMovie(dir,{expectedRevision:0,document:d});const split=await editMovie(dir,{expectedRevision:saved.revision,operations:[{op:'split-clip',shotId:'moving',at:1,newShotId:'tail'}]});
  expect(movieClipPose(split.document.shots[0]!.clip!,1).x).toBe(20);expect(movieClipPose(split.document.shots[1]!.clip!,0).x).toBe(20);
  const colored=await editMovie(dir,{expectedRevision:split.document.revision,operations:[{op:'update-clip',shotId:'tail',changes:{color:{exposure:1,contrast:1,saturation:1,blur:0,grayscale:0},fadeIn:.2}}]});
  expect(colored.receipt.changes.some(c=>c.field==='clip.color')).toBe(true);expect(colored.receipt.changes.some(c=>c.field==='clip.fadeIn')).toBe(true);
  const undo=await stepMovieHistory(dir,{expectedRevision:colored.document.revision},'undo');expect(undo.document.shots[1]!.clip?.color).toBeUndefined();
});

it('protects locked manual work from AI edits and rejects ripple batches atomically',async()=>{
  const dir=await stored(),d=film();d.shots=[shot('first',0,1),{...shot('second',1,1),locked:true}];const saved=await saveMovie(dir,{expectedRevision:0,document:d});
  await expect(editMovie(dir,{expectedRevision:saved.revision,operations:[{op:'remove-shot',shotId:'first',ripple:true}]})).rejects.toThrow(/locked/);
  expect((await readMovie(dir))!.shots).toHaveLength(2);expect((await readMovie(dir))!.revision).toBe(saved.revision);
  const unlocked=await editMovie(dir,{expectedRevision:saved.revision,operations:[{op:'lock-clip',shotId:'second',locked:false}]});
  const removed=await editMovie(dir,{expectedRevision:unlocked.document.revision,operations:[{op:'remove-shot',shotId:'first',ripple:true}]});expect(removed.document.shots[0]!.placement?.start).toBe(0);
});
