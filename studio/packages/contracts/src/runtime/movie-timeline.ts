import { movieDuration, movieShotStarts, type MovieDocument } from "../api/movie.js";
import { movieVisual, MOVIE_LAYER_TIMELINE } from "./movie-layers.js";
import { movieClipPose } from './movie-clip-keyframes.js';

const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
export function movieNextShotIndex(doc: MovieDocument, index: number): number {
  const shot=doc.shots[index];if(!shot||shot.clip?.audioOnly)return -1;
  const starts=movieShotStarts(doc),end=starts[index]!+shot.duration,track=shot.placement?.track??0;
  return doc.shots.findIndex((s,i)=>i!==index&&!s.clip?.audioOnly&&(s.placement?.track??0)===track&&Math.abs(starts[i]!-end)<1e-6);
}
export function movieTransitionDuration(
  doc: MovieDocument,
  index: number,
): number {
  const shot = doc.shots[index],
    next = doc.shots[movieNextShotIndex(doc,index)];
  if (
    !shot ||
    !next ||
    !["crossfade", "wipe", "iris"].includes(movieVisual(doc, shot).transition)
  )
    return 0;
  return Math.min(
    movieVisual(doc, shot).transitionDuration ?? 0.45,
    shot.duration / 2,
    next.duration / 2,
  );
}

export function buildMovieTimeline(
  doc: MovieDocument,
  width: number,
  initialTime: number,
  autoplay: boolean,
): string {
  const duration = movieDuration(doc);
  const renderShots=doc.shots.map(s=>s.clip?.keyframes?.length?{...s,clip:{...s.clip,keyframes:s.clip.keyframes.map(k=>({at:k.at,...movieClipPose(s.clip!,k.at)}))}}:s);
  const incoming=doc.shots.map(()=>-1);
  doc.shots.forEach((_,i)=>{const next=movieNextShotIndex(doc,i);if(next>=0)incoming[next]=i;});
  return `
window.__timelines=window.__timelines||{};
const tl=gsap.timeline({paused:true});window.__timelines.main=tl;
const baseVisual=${json(movieVisual(doc))},shots=${json(renderShots)},starts=${json(movieShotStarts(doc))},overlaps=${json(doc.shots.map((_, i) => movieTransitionDuration(doc, i)))},incomingClips=${json(incoming)},canvasWidth=${width};
let time=0;
shots.forEach((s,i)=>{
  time=starts[i];
  const previous=incomingClips[i],el='#shot-'+i,visual=s.visual||baseVisual,incoming=previous>=0?(shots[previous].visual||baseVisual):null,blend=previous>=0?overlaps[previous]:0;
  tl.set(el,{autoAlpha:1,x:0,clipPath:'inset(0 0 0 0)'},time);
  tl.set(el+' .copy',{opacity:0},time);
  if(blend>0){
    if(incoming.transition==='crossfade')tl.fromTo(el,{opacity:0},{opacity:1,duration:blend,ease:'none',immediateRender:false},time);
    if(incoming.transition==='wipe')tl.fromTo(el,{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 0% 0 0)',duration:blend,ease:'power2.inOut',immediateRender:false},time);
    if(incoming.transition==='iris')tl.fromTo(el,{clipPath:'circle(0% at 50% 50%)'},{clipPath:'circle(150% at 50% 50%)',duration:blend,ease:'power2.inOut',immediateRender:false},time);
  }
  if(s.kind==='text'){
    tl.set(el+' .copy',{opacity:1},time);
    const intro=Math.min(.5,s.duration/2);
    if(['fade','rise','slide'].includes(s.textAnimation)){tl.set(el+' .copy',{opacity:0,y:s.textAnimation==='rise'?30:0,x:s.textAnimation==='slide'?-80:0},time);tl.to(el+' .copy',{opacity:1,x:0,y:0,duration:intro,ease:'power2.out'},time);}
    if(s.textAnimation==='typewriter'){tl.set(el+' .title-char',{opacity:0},time);tl.to(el+' .title-char',{opacity:1,duration:.01,stagger:Math.min(1.5,s.duration/2)/Math.max(1,Array.from(s.title).length)},time+.01);}
  }
  else tl.fromTo(el+' .copy',{${doc.style.motion === "slide" ? "x:80" : doc.style.motion === "scale" ? "scale:.88" : "y:18"},opacity:0},{x:0,y:0,scale:1,opacity:1,duration:.45,ease:'power3.out',immediateRender:false},time+.08);
  if(s.clip?.fadeIn)tl.fromTo(el,{opacity:0},{opacity:1,duration:s.clip.fadeIn,ease:'none',immediateRender:false},time);
  if(s.clip?.fadeOut)tl.to(el,{opacity:0,duration:s.clip.fadeOut,ease:'none'},time+s.duration-s.clip.fadeOut);
  ${MOVIE_LAYER_TIMELINE}
  if(s.clip?.keyframes?.length)track(el+(s.clip.crop&&Object.values(s.clip.crop).some(Boolean)?' .clip-frame':' .media'),s.clip.keyframes);
  if(overlaps[i]>0)tl.set(el,{autoAlpha:0},time+s.duration+overlaps[i]);
  else if(['cut','crossfade','wipe','iris'].includes(visual.transition)){if(s.placement||i<shots.length-1)tl.set(el,{autoAlpha:0},time+s.duration);}
  else tl.to(el,{autoAlpha:0,x:visual.transition==='slide'?-120:0,duration:.25},time+s.duration-.25);
  time+=s.duration;
});
tl.set({}, {},${Math.max(duration, 0.1)});
function syncVideos(t,playing){
document.querySelectorAll('[data-crop-media]').forEach(box=>{const media=box.querySelector('video,img'),crop=JSON.parse(box.dataset.cropMedia||'{}'),sw=media.videoWidth||media.naturalWidth,sh=media.videoHeight||media.naturalHeight;if(!sw||!sh)return;const cw=sw*(1-crop.left-crop.right),ch=sh*(1-crop.top-crop.bottom),scale=box.dataset.fit==='cover'?Math.max(box.clientWidth/cw,box.clientHeight/ch):Math.min(box.clientWidth/cw,box.clientHeight/ch);Object.assign(media.style,{width:sw*scale+'px',height:sh*scale+'px',left:(box.clientWidth-cw*scale)/2-sw*crop.left*scale+'px',top:(box.clientHeight-ch*scale)/2-sh*crop.top*scale+'px',clipPath:'inset('+[crop.top,crop.right,crop.bottom,crop.left].map(v=>v*100+'%').join(' ')+')'});});
document.querySelectorAll('[data-caption-start]').forEach(caption=>{const start=Number(caption.dataset.captionStart),end=Number(caption.dataset.captionEnd),active=t>=start&&t<end;const progress=active?Math.min(1,(t-start)/Math.min(.12,(end-start)/3)):0;caption.style.visibility=active?'visible':'hidden';caption.style.opacity=String(1-Math.pow(1-progress,3));caption.style.transform='translateY('+(8*(1-progress))+'px)';});
document.querySelectorAll('video[data-start],audio[data-start]').forEach(video=>{
  const local=t-Number(video.dataset.start||0),span=Number(video.dataset.playDuration||video.dataset.duration||0),hold=Number(video.closest('.scene')?.dataset.hold||0),active=local>=0&&local<span,held=local>=span&&local<span+hold;
  const offset=Number(video.dataset.mediaStart||0),rate=Number(video.dataset.playbackRate||1);
  const target=Math.max(0,Math.min(Number.isFinite(video.duration)?Math.max(0,video.duration-.02):offset+local*rate,offset+Math.max(0,span-.02)*rate,offset+local*rate));
  video.playbackRate=rate;
  const fadeIn=Number(video.dataset.fadeIn||0),fadeOut=Number(video.dataset.fadeOut||0);
  video.volume=Math.max(0,Math.min(1,Number(video.dataset.volume??1)*(fadeIn?Math.min(1,Math.max(0,local)/fadeIn):1)*(fadeOut?Math.min(1,Math.max(0,span-local)/fadeOut):1)));
  if(!active||!playing)video.pause();
  if((active||held)&&Math.abs(video.currentTime-target)>(playing ? .08 : .0005))try{video.currentTime=target;}catch{}
  if(active&&playing&&video.paused){const pending=video.play();if(pending&&pending.catch)pending.catch(()=>{});}
});}
const pauseTimeline=tl.pause.bind(tl),playTimeline=tl.play.bind(tl);
tl.pause=function(...args){const result=pauseTimeline(...args);syncVideos(tl.time(),false);return result;};
tl.play=function(...args){const result=playTimeline(...args);syncVideos(tl.time(),true);return result;};
tl.eventCallback('onUpdate',()=>syncVideos(tl.time(),!tl.paused()));
document.querySelectorAll('video,audio').forEach(video=>video.addEventListener('loadedmetadata',()=>syncVideos(tl.time(),!tl.paused())));
document.querySelectorAll('[data-crop-media] img').forEach(image=>image.addEventListener('load',()=>syncVideos(tl.time(),!tl.paused())));
function seek(t){tl.pause(Math.max(0,Math.min(t,${duration})));syncVideos(tl.time(),false);}
window.addEventListener('message',e=>{if(e.source!==parent)return;const d=e.data;if(!d||d.type!=='fantay-movie')return;if(d.action==='seek')seek(Number(d.time)||0);if(d.action==='play'){tl.repeat(d.loop?-1:0).play();syncVideos(tl.time(),true);}if(d.action==='pause'){tl.pause();syncVideos(tl.time(),false);}});
seek(${Number(initialTime)});${autoplay ? "tl.repeat(-1).play(0);" : ""}
`;
}
