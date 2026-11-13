import type { MovieShot } from '../api/movie.js';

type Clip = NonNullable<MovieShot['clip']>;
export const MOVIE_CLIP_ANIMATED_FIELDS = ['x','y','width','height','rotation','opacity'] as const;
export type MovieClipPose = Record<(typeof MOVIE_CLIP_ANIMATED_FIELDS)[number], number>;

/** Linear clip animation shared by the inspector, slice planner and renderer. */
export function movieClipPose(clip: Clip, at: number): MovieClipPose {
  const defaults: MovieClipPose = { x:clip.x??0,y:clip.y??0,width:clip.width??100,height:clip.height??clip.width??100,rotation:clip.rotation??0,opacity:clip.opacity??1 };
  for (const field of MOVIE_CLIP_ANIMATED_FIELDS) {
    const keys = (clip.keyframes??[]).filter(k=>k[field]!==undefined);
    if (!keys.length) continue;
    const first=keys[0]!,last=keys.at(-1)!;
    if (at<=first.at) defaults[field]=first[field]!;
    else if(at>=last.at) defaults[field]=last[field]!;
    else {
      const right=keys.findIndex(k=>k.at>at),a=keys[right-1]!,b=keys[right]!;
      defaults[field]=a[field]!+(b[field]!-a[field]!)*(at-a.at)/(b.at-a.at);
    }
  }
  return defaults;
}

/** Include interpolated boundary poses so a split/trim keeps the original visible movement. */
export function sliceMovieClipKeyframes(clip: Clip, start: number, end: number, duration: number): Clip['keyframes'] {
  if (!clip.keyframes?.length) return clip.keyframes;
  const positions=[start/duration,...clip.keyframes.map(k=>k.at).filter(t=>t>start/duration&&t<end/duration),end/duration];
  return positions.map(t=>({at:Math.max(0,Math.min(1,(t*duration-start)/(end-start))),...movieClipPose(clip,t)}));
}
