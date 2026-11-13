/**
 * Presets of the editor's resource panel (text, captions, transitions, filters, clip animation) and
 * the pure builders that turn one choice into the edit operations of one user intention. The caller
 * sends each result as one batch, so it is one undo step. Values stay inside the document model's
 * limits (the daemon's movie parser rejects anything outside them).
 */
import {
  movieClipPose,
  movieNextShotIndex,
  movieShotStarts,
  type MovieCaption,
  type MovieCaptionStyle,
  type MovieDocument,
  type MovieEditOperation,
  type MovieShot,
  type MovieVisual,
} from '@open-design/contracts';
import { MOVIE_MAX_EDIT_OPERATIONS } from './movie-editor-layout';

/** A preset name in both UI languages; components pick with `zh ? name.zh : name.en`. */
export interface MovieBilingual {
  zh: string;
  en: string;
}

type MovieClip = NonNullable<MovieShot['clip']>;
type MovieClipKeyframe = NonNullable<MovieClip['keyframes']>[number];
type MovieShotChanges = Extract<MovieEditOperation, { op: 'update-shot' }>['changes'];
export type MovieClipColor = NonNullable<MovieClip['color']>;
export type MovieTextAnimation = NonNullable<MovieShot['textAnimation']>;
/** A shot whose clip shows a picture (video or image), as opposed to detached audio or text. */
export type MovieVisualShot = MovieShot & { clip: MovieClip };

/** Highest timeline track an edit may place a clip on. */
export const MOVIE_MAX_TRACK = 7;

export function isMovieVisualClip(shot: MovieShot | undefined): shot is MovieVisualShot {
  return Boolean(shot?.clip && !shot.clip.audioOnly);
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Why an "apply to all" over `targets` clips cannot run, or undefined when it can. Each builder below writes one
 * operation per clip, and one intention is one request (one undo step): past the edit API's per-request limit the
 * button is disabled with this reason instead of splitting the change.
 */
export function movieApplyAllBlocked(targets: number, zh: boolean): string | undefined {
  if (targets <= MOVIE_MAX_EDIT_OPERATIONS) return undefined;
  return zh
    ? `一次最多统一 ${MOVIE_MAX_EDIT_OPERATIONS} 个片段，当前有 ${targets} 个`
    : `One edit can change at most ${MOVIE_MAX_EDIT_OPERATIONS} clips; this would change ${targets}`;
}

// ─── Matching a look to a preset ─────────────────────────────────────────────────────────────────

/**
 * The preset a look shows as: `exact` when it carries the preset's values, otherwise the nearest
 * preset it reads as on screen (a look tuned by hand, or written by an agent with its own values).
 */
export interface MovieLookMatch<T> {
  preset: T;
  exact: boolean;
}

/** Looks closer than one visible step to a preset read as that preset. */
const NEAR_LOOK = 1;

function nearestLook<T>(presets: readonly T[], distance: (preset: T) => number): T | undefined {
  let best: T | undefined;
  let bestDistance = NEAR_LOOK;
  for (const preset of presets) {
    const value = distance(preset);
    if (value < bestDistance) {
      best = preset;
      bestDistance = value;
    }
  }
  return best;
}

/** Colour distance in visible steps: white to the bold caption yellow is about 1.2. */
function hexDistance(a: string, b: string): number {
  const rgb = (hex: string) => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) : undefined;
  const from = rgb(a), to = rgb(b);
  if (!from || !to) return a.toLowerCase() === b.toLowerCase() ? 0 : 1;
  return Math.hypot(from[0]! - to[0]!, from[1]! - to[1]!, from[2]! - to[2]!) / 150;
}

// ─── Text ────────────────────────────────────────────────────────────────────────────────────────

/** The visual `insert-text` gives every new text clip (mirrors the daemon). */
export const MOVIE_TEXT_VISUAL: MovieVisual = {
  composition: 'minimal',
  copy: { x: 10, y: 78, width: 80, align: 'center', titleSize: 3.5, bodySize: 2 },
  layers: [],
  transition: 'cut',
  copyMode: 'caption',
  foreground: '#FFFFFF',
};
export const MOVIE_TEXT_DURATION = 3;

export interface MovieTextPreset {
  id: string;
  name: MovieBilingual;
  /** Copy box in percent of the frame; `titleSize` is a percent of the frame width. */
  copy: MovieVisual['copy'];
  /** Six-digit hex, as the document model requires. */
  foreground: string;
  animation: MovieTextAnimation;
}

const textCopy = (copy: Partial<MovieVisual['copy']>): MovieVisual['copy'] => ({ ...MOVIE_TEXT_VISUAL.copy, ...copy });

export const MOVIE_TEXT_PRESETS: readonly MovieTextPreset[] = [
  { id: 'default', name: { zh: '默认文字', en: 'Default text' }, copy: textCopy({}), foreground: '#FFFFFF', animation: 'none' },
  { id: 'headline', name: { zh: '大标题', en: 'Headline' }, copy: textCopy({ x: 8, y: 36, width: 84, titleSize: 8 }), foreground: '#FFFFFF', animation: 'rise' },
  { id: 'subheading', name: { zh: '副标题', en: 'Subheading' }, copy: textCopy({ x: 12, y: 52, width: 76, titleSize: 4.5 }), foreground: '#FFFFFF', animation: 'fade' },
  { id: 'lower-third', name: { zh: '底部说明', en: 'Lower third' }, copy: textCopy({ x: 6, y: 80, width: 60, align: 'left', titleSize: 2.8 }), foreground: '#FFFFFF', animation: 'slide' },
  { id: 'typewriter', name: { zh: '逐字出现', en: 'Typewriter' }, copy: textCopy({ y: 44, titleSize: 5 }), foreground: '#FFFFFF', animation: 'typewriter' },
  { id: 'tagline', name: { zh: '淡入标语', en: 'Fade-in tagline' }, copy: textCopy({ y: 46, titleSize: 4 }), foreground: '#FFE9B8', animation: 'fade' },
  { id: 'highlight', name: { zh: '强调文字', en: 'Highlight' }, copy: textCopy({ y: 40, titleSize: 6.5 }), foreground: '#FFDD55', animation: 'rise' },
  { id: 'corner', name: { zh: '角标', en: 'Corner tag' }, copy: textCopy({ x: 5, y: 7, width: 40, align: 'left', titleSize: 2.4 }), foreground: '#FFFFFF', animation: 'fade' },
];

export const MOVIE_TEXT_ANIMATIONS: ReadonlyArray<{ id: MovieTextAnimation; name: MovieBilingual }> = [
  { id: 'none', name: { zh: '直接出现', en: 'None' } },
  { id: 'fade', name: { zh: '淡入', en: 'Fade' } },
  { id: 'rise', name: { zh: '向上进入', en: 'Rise' } },
  { id: 'slide', name: { zh: '从左进入', en: 'Slide' } },
  { id: 'typewriter', name: { zh: '逐字出现', en: 'Typewriter' } },
];

/** The track a new text clip goes on: above every existing clip, never above the top track. */
export function movieTextTrack(d: MovieDocument): number {
  return Math.min(MOVIE_MAX_TRACK, 1 + Math.max(0, ...d.shots.map(shot => shot.placement?.track ?? 0)));
}

/** Insert a text clip at `at` (output seconds) and style it per the preset, in one batch. */
export function movieTextInsertOperations(
  d: MovieDocument,
  preset: MovieTextPreset,
  options: { text: string; at: number; newShotId: string },
): MovieEditOperation[] {
  const operations: MovieEditOperation[] = [{
    op: 'insert-text',
    text: options.text,
    at: Math.max(0, options.at),
    duration: MOVIE_TEXT_DURATION,
    track: movieTextTrack(d),
    newShotId: options.newShotId,
  }];
  const changes: MovieShotChanges = {};
  const copyKeys = Object.keys(preset.copy) as Array<keyof MovieVisual['copy']>;
  const restyled = copyKeys.some(key => preset.copy[key] !== MOVIE_TEXT_VISUAL.copy[key]) || preset.foreground !== MOVIE_TEXT_VISUAL.foreground;
  if (restyled) changes.visual = { ...MOVIE_TEXT_VISUAL, copy: { ...preset.copy }, foreground: preset.foreground };
  if (preset.animation !== 'none') changes.textAnimation = preset.animation;
  if (Object.keys(changes).length) operations.push({ op: 'update-shot', shotId: options.newShotId, changes });
  return operations;
}

export function movieTextAnimationOperations(shot: MovieShot, animation: MovieTextAnimation): MovieEditOperation[] {
  return [{ op: 'update-shot', shotId: shot.id, changes: { textAnimation: animation } }];
}

// ─── Captions ────────────────────────────────────────────────────────────────────────────────────

/** How the renderer draws captions of a clip without its own style (mirrors the inspector). */
export const MOVIE_DEFAULT_CAPTION_STYLE: MovieCaptionStyle = {
  fontSize: 42, color: '#FFFFFF', background: '#000000', backgroundOpacity: 0.65, y: 85, outline: 0, align: 'center',
};

type MovieCaptionLook = Pick<MovieCaptionStyle, 'fontSize' | 'color' | 'background' | 'backgroundOpacity' | 'outline'>;

export interface MovieCaptionStylePreset {
  id: string;
  name: MovieBilingual;
  /** The look only: a preset keeps the clip's caption position (y, align). */
  style: Partial<MovieCaptionLook>;
}

export const MOVIE_CAPTION_STYLE_PRESETS: readonly MovieCaptionStylePreset[] = [
  { id: 'clean', name: { zh: '简洁', en: 'Clean' }, style: { fontSize: 38, color: '#FFFFFF', background: '#000000', backgroundOpacity: 0.65, outline: 0 } },
  { id: 'bold', name: { zh: '醒目', en: 'Bold' }, style: { fontSize: 58, color: '#FFDD55', backgroundOpacity: 0, outline: 2 } },
  { id: 'cinema', name: { zh: '电影', en: 'Cinema' }, style: { fontSize: 34, color: '#F4EFE6', backgroundOpacity: 0, outline: 1 } },
  { id: 'outline', name: { zh: '描边', en: 'Outline' }, style: { fontSize: 46, color: '#FFFFFF', backgroundOpacity: 0, outline: 4 } },
  { id: 'boxed', name: { zh: '黑底', en: 'Boxed' }, style: { fontSize: 42, color: '#FFFFFF', background: '#000000', backgroundOpacity: 0.9, outline: 0 } },
  { id: 'soft', name: { zh: '柔和', en: 'Soft' }, style: { fontSize: 40, color: '#FFFFFF', background: '#000000', backgroundOpacity: 0.35, outline: 0 } },
];

export function movieCaptionStyle(shot: MovieShot): MovieCaptionStyle {
  return shot.captionStyle ?? MOVIE_DEFAULT_CAPTION_STYLE;
}

/** The preset whose look the style currently has, if any. */
export function movieCaptionStylePresetFor(style: MovieCaptionStyle): MovieCaptionStylePreset | undefined {
  return MOVIE_CAPTION_STYLE_PRESETS.find(preset =>
    (Object.keys(preset.style) as Array<keyof MovieCaptionLook>).every(key => {
      const want = preset.style[key]!, have = style[key];
      return typeof want === 'number' ? sameNumber(want, have as number) : String(have).toLowerCase() === want.toLowerCase();
    }));
}

/** How far each caption field moves before the change is one visible step. */
const CAPTION_STEP = { fontSize: 12, backgroundOpacity: 0.3, outline: 1.5 } as const;

function captionLookDistance(style: MovieCaptionStyle, look: Partial<MovieCaptionLook>): number {
  const steps = (Object.keys(CAPTION_STEP) as Array<keyof typeof CAPTION_STEP>)
    .filter(key => look[key] !== undefined)
    .map(key => (style[key] - look[key]!) / CAPTION_STEP[key]);
  if (look.color) steps.push(hexDistance(style.color, look.color));
  // The box colour shows only while both draw a box.
  const box = Math.min(style.backgroundOpacity, look.backgroundOpacity ?? style.backgroundOpacity);
  if (look.background && box > 0) steps.push(hexDistance(style.background, look.background) * box);
  return Math.hypot(...steps);
}

/** The caption preset a style shows as, exact or nearest (see `MovieLookMatch`). */
export function movieCaptionStyleMatch(style: MovieCaptionStyle): MovieLookMatch<MovieCaptionStylePreset> | undefined {
  const exact = movieCaptionStylePresetFor(style);
  if (exact) return { preset: exact, exact: true };
  const near = nearestLook(MOVIE_CAPTION_STYLE_PRESETS, preset => captionLookDistance(style, preset.style));
  return near ? { preset: near, exact: false } : undefined;
}

/** Clips that "apply to all" restyles: unlocked clips that carry captions. */
export function movieCaptionTargets(d: MovieDocument): MovieShot[] {
  return d.shots.filter(shot => !shot.locked && Boolean(shot.captions?.length));
}

export function movieCaptionStyleOperations(shots: readonly MovieShot[], preset: MovieCaptionStylePreset): MovieEditOperation[] {
  return shots.map(shot => ({ op: 'update-shot', shotId: shot.id, changes: { captionStyle: { ...movieCaptionStyle(shot), ...preset.style } } }));
}

export interface MovieCaptionEntry {
  shot: MovieShot;
  caption: MovieCaption;
  /** Output seconds. */
  start: number;
  end: number;
}

/** Every caption of the film at its output time, in playback order. */
export function movieCaptionEntries(d: MovieDocument): MovieCaptionEntry[] {
  const starts = movieShotStarts(d);
  return d.shots
    .flatMap((shot, index) => (shot.captions ?? []).map(caption => ({
      shot,
      caption,
      start: (starts[index] ?? 0) + caption.start,
      end: (starts[index] ?? 0) + caption.end,
    })))
    .sort((a, b) => a.start - b.start);
}

/** Change one caption's text: by its id, or by rewriting the clip's captions for a legacy cue without one. */
export function movieCaptionTextOperations(shot: MovieShot, caption: MovieCaption, text: string): MovieEditOperation[] {
  if (caption.id) return [{ op: 'update-caption', shotId: shot.id, captionId: caption.id, changes: { text } }];
  const captions = (shot.captions ?? []).map(item => (item === caption ? { ...item, text } : item));
  return [{ op: 'replace-captions', shotId: shot.id, captions }];
}

// ─── Transitions ─────────────────────────────────────────────────────────────────────────────────

export type MovieTransitionKind = 'cut' | 'crossfade' | 'wipe' | 'iris';

export const MOVIE_TRANSITIONS: ReadonlyArray<{ id: MovieTransitionKind; name: MovieBilingual }> = [
  { id: 'cut', name: { zh: '直接切换', en: 'Cut' } },
  { id: 'crossfade', name: { zh: '交叉淡化', en: 'Crossfade' } },
  { id: 'wipe', name: { zh: '擦除', en: 'Wipe' } },
  { id: 'iris', name: { zh: '圆形展开', en: 'Iris' } },
];

export const MOVIE_TRANSITION_SECONDS = { min: 0.05, max: 1.5, default: 0.45 } as const;

/** The visual a clip without its own falls back to when an edit has to write one. */
export const MOVIE_DEFAULT_VISUAL: MovieVisual = {
  composition: 'minimal',
  copy: { x: 8, y: 75, width: 84, align: 'center', titleSize: 3.5, bodySize: 2 },
  layers: [],
  transition: 'cut',
  copyMode: 'none',
};

export function movieShotVisual(d: MovieDocument, shot: MovieShot): MovieVisual {
  return shot.visual ?? d.style.visual ?? MOVIE_DEFAULT_VISUAL;
}

export function movieTransitionKind(visual: MovieVisual): MovieTransitionKind | undefined {
  return MOVIE_TRANSITIONS.find(transition => transition.id === visual.transition)?.id;
}

export function clampTransitionSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MOVIE_TRANSITION_SECONDS.default;
  return clamp(Math.round(seconds * 100) / 100, MOVIE_TRANSITION_SECONDS.min, MOVIE_TRANSITION_SECONDS.max);
}

/** A transition plays only when the next clip starts exactly where this one ends on its track. */
export function movieTransitionReady(d: MovieDocument, shot: MovieShot): boolean {
  return movieNextShotIndex(d, d.shots.findIndex(s => s.id === shot.id)) >= 0;
}

/** Clips that "apply to all" changes: unlocked visual clips followed by an adjacent clip. */
export function movieTransitionTargets(d: MovieDocument): MovieShot[] {
  return d.shots.filter((shot, index) => isMovieVisualClip(shot) && !shot.locked && movieNextShotIndex(d, index) >= 0);
}

/** `update-shot` replaces the whole visual, so each clip keeps everything else it has. */
export function movieTransitionOperations(
  d: MovieDocument,
  shots: readonly MovieShot[],
  transition: MovieTransitionKind,
  seconds: number,
): MovieEditOperation[] {
  const transitionDuration = clampTransitionSeconds(seconds);
  return shots.map(shot => ({
    op: 'update-shot',
    shotId: shot.id,
    changes: { visual: { ...movieShotVisual(d, shot), transition, transitionDuration } },
  }));
}

// ─── Filters ─────────────────────────────────────────────────────────────────────────────────────

export interface MovieFilterPreset {
  id: string;
  name: MovieBilingual;
  /** exposure −3..3 EV, contrast 0..3, saturation 0..3, blur 0..30 px, grayscale 0..1. */
  color: MovieClipColor;
}

export const MOVIE_ORIGINAL_COLOR: MovieClipColor = { exposure: 0, contrast: 1, saturation: 1, blur: 0, grayscale: 0 };

export const MOVIE_FILTER_PRESETS: readonly MovieFilterPreset[] = [
  { id: 'original', name: { zh: '原色', en: 'Original' }, color: MOVIE_ORIGINAL_COLOR },
  { id: 'bright', name: { zh: '明亮', en: 'Bright' }, color: { exposure: 0.35, contrast: 1.08, saturation: 1.1, blur: 0, grayscale: 0 } },
  { id: 'soft', name: { zh: '柔和', en: 'Soft' }, color: { exposure: 0.1, contrast: 0.9, saturation: 0.85, blur: 0, grayscale: 0 } },
  { id: 'mono', name: { zh: '黑白', en: 'B&W' }, color: { exposure: 0, contrast: 1.12, saturation: 1, blur: 0, grayscale: 1 } },
  { id: 'vivid', name: { zh: '浓郁', en: 'Vivid' }, color: { exposure: 0.05, contrast: 1.15, saturation: 1.45, blur: 0, grayscale: 0 } },
  { id: 'fresh', name: { zh: '清新', en: 'Fresh' }, color: { exposure: 0.25, contrast: 0.92, saturation: 1.18, blur: 0, grayscale: 0 } },
  { id: 'cinema', name: { zh: '电影', en: 'Cinematic' }, color: { exposure: -0.15, contrast: 1.25, saturation: 0.8, blur: 0, grayscale: 0 } },
  { id: 'vintage', name: { zh: '复古', en: 'Vintage' }, color: { exposure: 0.05, contrast: 0.85, saturation: 0.65, blur: 0, grayscale: 0.25 } },
];

const COLOR_FIELDS = ['exposure', 'contrast', 'saturation', 'blur', 'grayscale'] as const;

export function movieClipColor(clip: MovieClip): MovieClipColor {
  return clip.color ?? MOVIE_ORIGINAL_COLOR;
}

export function movieFilterPresetFor(color: MovieClipColor): MovieFilterPreset | undefined {
  return MOVIE_FILTER_PRESETS.find(preset => COLOR_FIELDS.every(field => sameNumber(preset.color[field], color[field])));
}

/** How far each colour field moves before the change is one visible step. */
const COLOR_STEP: Record<(typeof COLOR_FIELDS)[number], number> = { exposure: 0.5, contrast: 0.3, saturation: 0.4, blur: 6, grayscale: 0.35 };

function colorDistance(a: MovieClipColor, b: MovieClipColor): number {
  // Saturation stops showing as the picture turns gray.
  const gray = Math.min(a.grayscale, b.grayscale);
  return Math.hypot(...COLOR_FIELDS.map(field => ((a[field] - b[field]) / COLOR_STEP[field]) * (field === 'saturation' ? 1 - gray : 1)));
}

/** The filter preset a clip colour shows as, exact or nearest (see `MovieLookMatch`). */
export function movieFilterMatch(color: MovieClipColor): MovieLookMatch<MovieFilterPreset> | undefined {
  const exact = movieFilterPresetFor(color);
  if (exact) return { preset: exact, exact: true };
  const near = nearestLook(MOVIE_FILTER_PRESETS, preset => colorDistance(color, preset.color));
  return near ? { preset: near, exact: false } : undefined;
}

/**
 * The CSS filter the renderer applies for a clip color. `blurScale` shrinks the blur for a small
 * preview (blur is in output pixels).
 */
export function movieColorFilter(color: MovieClipColor, blurScale = 1): string {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return `brightness(${round(2 ** color.exposure)}) contrast(${color.contrast}) saturate(${color.saturation}) blur(${round(color.blur * blurScale)}px) grayscale(${color.grayscale})`;
}

/** Clips that "apply to all" changes: unlocked clips with a picture. */
export function movieFilterTargets(d: MovieDocument): MovieShot[] {
  return d.shots.filter(shot => isMovieVisualClip(shot) && !shot.locked);
}

export function movieFilterOperations(shots: readonly MovieShot[], color: MovieClipColor): MovieEditOperation[] {
  return shots.map(shot => ({ op: 'update-clip', shotId: shot.id, changes: { color: { ...color } } }));
}

// ─── Clip animation ──────────────────────────────────────────────────────────────────────────────

export type MovieClipAnimationKind = 'zoom-in' | 'zoom-out' | 'slide-left' | 'slide-right' | 'fade-in' | 'fade-out';

export const MOVIE_CLIP_ANIMATIONS: ReadonlyArray<{ id: MovieClipAnimationKind; name: MovieBilingual }> = [
  { id: 'zoom-in', name: { zh: '缓慢推近', en: 'Slow zoom in' } },
  { id: 'zoom-out', name: { zh: '缓慢拉远', en: 'Slow zoom out' } },
  { id: 'slide-left', name: { zh: '从左移入', en: 'Slide in from left' } },
  { id: 'slide-right', name: { zh: '从右移入', en: 'Slide in from right' } },
  { id: 'fade-in', name: { zh: '淡入', en: 'Fade in' } },
  { id: 'fade-out', name: { zh: '淡出', en: 'Fade out' } },
];

const POSE_LIMITS = {
  x: [-150, 250], y: [-150, 250], width: [1, 400], height: [1, 400], rotation: [-360, 360], opacity: [0, 1],
} as const;
const POSE_FIELDS = Object.keys(POSE_LIMITS) as Array<keyof typeof POSE_LIMITS>;

type MovieClipPose = ReturnType<typeof movieClipPose>;

function keyframe(at: number, pose: MovieClipPose): MovieClipKeyframe {
  const frame: MovieClipKeyframe = { at };
  for (const field of POSE_FIELDS) frame[field] = clamp(pose[field], POSE_LIMITS[field][0], POSE_LIMITS[field][1]);
  return frame;
}

/** Preset keyframes around the clip's resting pose (its existing keyframes are replaced). */
export function movieClipAnimationKeyframes(clip: MovieClip, kind: MovieClipAnimationKind): MovieClipKeyframe[] {
  const rest = movieClipPose({ ...clip, keyframes: [] }, 0);
  const zoomed = { ...rest, x: rest.x - rest.width * 0.075, y: rest.y - rest.height * 0.075, width: rest.width * 1.15, height: rest.height * 1.15 };
  switch (kind) {
    case 'zoom-in': return [keyframe(0, rest), keyframe(1, zoomed)];
    case 'zoom-out': return [keyframe(0, zoomed), keyframe(1, rest)];
    case 'slide-left': return [keyframe(0, { ...rest, x: -rest.width }), keyframe(0.2, rest), keyframe(1, rest)];
    case 'slide-right': return [keyframe(0, { ...rest, x: 100 }), keyframe(0.2, rest), keyframe(1, rest)];
    case 'fade-in': return [keyframe(0, { ...rest, opacity: 0 }), keyframe(0.15, rest), keyframe(1, rest)];
    case 'fade-out': return [keyframe(0, rest), keyframe(0.85, rest), keyframe(1, { ...rest, opacity: 0 })];
  }
}

/** The preset the clip's keyframes were made by, if any. */
export function movieClipAnimationFor(clip: MovieClip): MovieClipAnimationKind | undefined {
  const keys = clip.keyframes ?? [];
  if (!keys.length) return undefined;
  return MOVIE_CLIP_ANIMATIONS.find(({ id }) => {
    const preset = movieClipAnimationKeyframes(clip, id);
    return preset.length === keys.length && preset.every((frame, index) => {
      const key = keys[index]!;
      return sameNumber(frame.at, key.at) && POSE_FIELDS.every(field => key[field] !== undefined && sameNumber(frame[field]!, key[field]!));
    });
  })?.id;
}

export function movieClipAnimationOperations(shot: MovieVisualShot, kind: MovieClipAnimationKind): MovieEditOperation[] {
  return [{ op: 'update-clip', shotId: shot.id, changes: { keyframes: movieClipAnimationKeyframes(shot.clip, kind) } }];
}

/** Drop the keyframes; the clip returns to its resting pose. */
export function movieClearClipAnimationOperations(shot: MovieShot): MovieEditOperation[] {
  return [{ op: 'update-clip', shotId: shot.id, changes: { keyframes: [] } }];
}
