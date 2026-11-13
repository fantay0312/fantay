import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Aperture,
  ArrowLeftToLine,
  ArrowRightLeft,
  ArrowRightToLine,
  AudioWaveform,
  Blend,
  Captions,
  Copy,
  Diamond,
  Film,
  FoldHorizontal,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Magnet,
  Minus,
  MoveHorizontal,
  Music,
  Plus,
  Redo2,
  ScanLine,
  Scissors,
  SeparatorVertical,
  Slice,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Unlink,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import {
  MOVIE_MAX_DURATION,
  movieDuration,
  movieFps,
  movieNextShotIndex,
  movieTransitionDuration,
  type MovieDocument,
  type MovieEditOperation,
  type MovieShot,
  type MovieVideoSource,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceResourceUrl } from '../../collab/workspace-identity';
import { useI18n } from '../../i18n';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  MenuItemText,
  SegmentedIconItem,
  SegmentedIcons,
  Tooltip,
} from '../../fantay/ui';
import {
  MOVIE_MAIN_TRACK,
  MOVIE_MAX_EDIT_OPERATIONS,
  movieClipSpans,
  movieCutOperations,
  movieDuplicatePlacement,
  movieLocalTime,
  movieLockOperations,
  movieTargetShot,
  useMovieEditorLayout,
  type MovieCutKind,
  type MovieEditorLayout,
  type MovieInspectorRequest,
} from './movie-editor-layout';
import { useMoviePref } from './movie-editor-prefs';
import {
  MOVIE_MAX_TRACK,
  MOVIE_TEXT_DURATION,
  movieClipColor,
  movieFilterPresetFor,
  movieShotVisual,
  movieTextTrack,
} from './movie-editor-presets';
import { collectTargets, findSnap, formatTimecode, SNAP, type SnapState } from './palmier/palmier-core';
import styles from './MovieTrackTimeline.module.css';

/* ------------------------------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------------------------------- */

export interface TimelineGeometry {
  /** Lane heights: caption row, 主轨 (track 0), other video tracks, text-only tracks, audio-only tracks. */
  caption: number;
  main: number;
  video: number;
  text: number;
  audio: number;
  /** Lane that appears while a drag can create a new track above the video stack or below the audio lanes. */
  ghost: number;
  /** Gap between a lane edge and the clips drawn in it. */
  inset: number;
  /** Width of the track header column. */
  header: number;
  /** Name strip on top of picture clips; 0 floats a name chip over the frames instead. */
  strip: number;
  /** Name strip on top of audio-only clips; 0 writes the name over the waveform. */
  audioStrip: number;
  /** Linked-audio band: a full-width row under the frames of picture clips, sharing their edges and time scale. */
  band: number;
  /** Overview strip between the toolbar and the ruler. */
  overview: number;
}

/** Every lane position, clip box, drag and drop computation derives from this table (design brief §4.5). */
export const TIMELINE_GEOMETRY: Record<MovieEditorLayout, TimelineGeometry> = {
  compact: { caption: 24, main: 60, video: 40, text: 28, audio: 32, ghost: 20, inset: 3, header: 36, strip: 0, audioStrip: 0, band: 12, overview: 14 },
  full: { caption: 28, main: 80, video: 56, text: 32, audio: 44, ghost: 24, inset: 4, header: 120, strip: 18, audioStrip: 16, band: 14, overview: 16 },
};

/** Zoom in pixels per second; buttons and keys step by `step`, the slider is logarithmic. */
export const TIMELINE_ZOOM = { min: 4, max: 400, initial: 38, step: 1.25 } as const;

/** Pixels between the track headers and time 0, so the playhead head is never clipped at the start. */
export const TIMELINE_ORIGIN = 12;

const SOURCE_MIME = 'application/x-fantay-source';
const TRIM_EDGES = ['start', 'end'] as const;
const RULER_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const RULER_MINORS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
const RULER_LABEL_GAP = 64;
const RULER_MINOR_GAP = 10;
/** Clip label rule: name and badges above 86 px, badges only from 44 px, nothing below. */
const LABEL_WIDTH = 86;
const BADGE_WIDTH = 44;
const MIN_TRIM_WIDTH = 28;
const MIN_BAND_WIDTH = 24;
const MIN_FADE_WIDTH = 3;
const MAX_FILM_TILES = 80;
/** Clip rows start this far right of the clip's time on the ruler: the 0.5 px cut gap plus the 1 px body border. */
const CLIP_CONTENT_X = 1.5;
/** Scroll offsets are bucketed so scrolling re-renders the ruler once per bucket, not per pixel. */
const VIEW_BUCKET = 200;

type TrackKind = 'video' | 'audio';
type TrimEdge = (typeof TRIM_EDGES)[number];
type ClipKind = 'video' | 'text' | 'audio';
type ClipSpan = ReturnType<typeof movieClipSpans>[number];
/** What is being dragged: picture/text clips and media, or sound. */
type DragItem = 'visual' | 'audio';
type GhostSide = 'above' | 'below';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const pad2 = (value: number) => String(value).padStart(2, '0');

/* ------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

export function snapEditTime(time: number, boundaries: number[], scale: number, enabled: boolean, fps = 30) {
  const frame = Math.round(time * fps);
  const targets = boundaries.map(at => ({ frame: Math.round(at * fps), kind: 'clipEdge' as const }));
  const result = enabled ? findSnap(frame, [0], targets, { currentProbeOffset: 0 }, SNAP.thresholdPixels, scale / fps) : null;
  return (result?.frame ?? frame) / fps;
}

/** Loudest source peak (0–1) between two source times; interpolated when the range is narrower than one peak bin. */
function peakBetween(peaks: number[], duration: number, from: number, to: number) {
  const bins = peaks.length;
  const a = (from / duration) * bins;
  const b = (to / duration) * bins;
  if (b - a <= 1) {
    const at = clamp((a + b) / 2 - 0.5, 0, bins - 1);
    const index = Math.floor(at);
    const next = Math.min(bins - 1, index + 1);
    return peaks[index]! + (peaks[next]! - peaks[index]!) * (at - index);
  }
  let max = 0;
  for (let index = clamp(Math.floor(a), 0, bins - 1), last = clamp(Math.ceil(b) - 1, 0, bins - 1); index <= last; index += 1) {
    max = Math.max(max, peaks[index]!);
  }
  return max;
}

/** Display curve for peak levels: lifts quiet speech in a 9–11 px row while keeping loud passages distinct. */
const WAVE_GAMMA = 0.6;

/**
 * SVG path, in pixels, of the real audio peaks under `span` source seconds from `start`, scaled by volume; empty
 * when the source has none. `width` × `height` is the drawn box and `pxPerSecond` its scale in source seconds.
 * Buckets are 2 px wide on a grid anchored to source time 0, each the loudest peak it covers, so the shape lines up
 * with the ruler at every zoom and trimming or splitting a clip never re-samples the sound that stays.
 * `baseline` grows the level up from the bottom edge (the linked-audio row); otherwise the envelope is mirrored
 * around the middle. Silence keeps a 1 px line so the track reads as one.
 */
export function clipWaveform(
  source: MovieVideoSource | undefined,
  start: number,
  span: number,
  volume: number,
  options: { width?: number; height?: number; baseline?: boolean; pxPerSecond?: number } = {},
) {
  const peaks = source?.audioPeaks;
  if (!source || !peaks?.length || !(source.duration > 0) || !(span > 0)) return '';
  const { width = 200, height = 40, baseline = false } = options;
  const pps = options.pxPerSecond ?? width / span;
  // Never more than ~4000 points, whatever the caller's window.
  const bucket = Math.max(2 / pps, span / 4000);
  const snap = (value: number) => Math.round(value * 2) / 2;
  const points: Array<[number, number]> = [];
  for (let k = Math.floor(start / bucket); k * bucket < start + span; k += 1) {
    const from = Math.max(0, k * bucket);
    const to = Math.min(source.duration, (k + 1) * bucket);
    const peak = to > from ? peakBetween(peaks, source.duration, from, to) : 0;
    points.push([snap(clamp(((k + 0.5) * bucket - start) * pps, 0, width)), Math.min(1, peak * Math.max(0, volume)) ** WAVE_GAMMA]);
  }
  if (!points.length) return '';
  const right = snap(width);
  const first = points[0]![1];
  const last = points[points.length - 1]![1];
  if (baseline) {
    const y = (level: number) => snap(height - Math.max(1, level * height));
    return `M0,${height}L0,${y(first)}${points.map(([x, level]) => `L${x},${y(level)}`).join('')}L${right},${y(last)}L${right},${height}Z`;
  }
  const mid = height / 2;
  const half = (level: number) => Math.max(0.5, level * mid);
  const top = points.map(([x, level]) => `L${x},${snap(mid - half(level))}`).join('');
  const bottom = points.map(([x, level]) => `L${x},${snap(mid + half(level))}`).reverse().join('');
  return `M0,${snap(mid - half(first))}${top}L${right},${snap(mid - half(last))}L${right},${snap(mid + half(last))}${bottom}L0,${snap(mid + half(first))}Z`;
}

/** A waveform drawn over the visible part of a clip row: `left`/`width` in row pixels, the path in that box. */
interface WaveDraw {
  d: string;
  left: number;
  width: number;
  height: number;
}

const clampZoom = (scale: number) => clamp(scale, TIMELINE_ZOOM.min, TIMELINE_ZOOM.max);

/** Slider position 0–100 → px/s, so every slider step changes the zoom by the same ratio. */
export function zoomFromSlider(position: number) {
  return clampZoom(TIMELINE_ZOOM.min * (TIMELINE_ZOOM.max / TIMELINE_ZOOM.min) ** (position / 100));
}

export function sliderFromZoom(scale: number) {
  return (100 * Math.log(clampZoom(scale) / TIMELINE_ZOOM.min)) / Math.log(TIMELINE_ZOOM.max / TIMELINE_ZOOM.min);
}

/** The zoom that shows the whole film in `width` pixels. */
function fitZoom(width: number, total: number) {
  return clampZoom((width - TIMELINE_ORIGIN - 36) / Math.max(1, total));
}

/** Labelled ruler interval (labels at least 64 px apart) and the finest even minor tick inside it. */
export function rulerInterval(scale: number) {
  const major = RULER_INTERVALS.find(seconds => seconds * scale >= RULER_LABEL_GAP) ?? RULER_INTERVALS[RULER_INTERVALS.length - 1]!;
  const divides = (step: number) => Number.isInteger(Math.round((major / step) * 1000) / 1000);
  const minor = RULER_MINORS.find(step => step < major && step * scale >= RULER_MINOR_GAP && divides(step)) ?? major;
  return { major, minor };
}

/** Ruler label `m:ss`. */
function formatRulerTime(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${pad2(whole % 60)}`;
}

/** Clip duration badge `0:04.2`. */
function formatClipDuration(seconds: number) {
  const tenths = Math.max(0, Math.round(seconds * 10));
  return `${Math.floor(tenths / 600)}:${pad2(Math.floor(tenths / 10) % 60)}.${tenths % 10}`;
}

/** Hover badge `mm:ss.ff` (frames). */
function formatFrameTime(seconds: number, fps: number) {
  const frames = Math.max(0, Math.round(seconds * fps));
  const whole = Math.floor(frames / fps);
  return `${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}.${pad2(Math.round(frames - whole * fps))}`;
}

/** Trim / move delta bubble `+0:01.12` (m:ss.ff). */
function formatDelta(seconds: number, fps: number) {
  const frames = Math.round(Math.abs(seconds) * fps);
  const whole = Math.floor(frames / fps);
  const sign = seconds < 0 ? '−' : '+';
  return `${sign}${Math.floor(whole / 60)}:${pad2(whole % 60)}.${pad2(Math.round(frames - whole * fps))}`;
}

function nearestFrame(frames: MovieVideoSource['frames'], at: number) {
  return frames.reduce((best, frame) => (Math.abs(frame.time - at) < Math.abs(best.time - at) ? frame : best));
}

/** A picture clip whose source has sound: drawn as the linked-audio band inside the clip. */
function hasLinkedAudio(shot: MovieShot, source: MovieVideoSource | undefined) {
  return Boolean(shot.clip && !shot.clip.audioOnly && source?.hasAudio);
}

/** How far each edge may move, in output seconds relative to the clip start / duration. */
function trimBounds(shot: MovieShot, source: MovieVideoSource | undefined) {
  const clip = shot.clip;
  if (!clip) return { min: -(shot.placement?.start ?? 0), max: MOVIE_MAX_DURATION };
  const min = -Math.min(clip.in / clip.rate, shot.placement?.start ?? Infinity);
  const max = !source ? shot.duration : source.kind === 'image' ? MOVIE_MAX_DURATION : (source.duration - clip.in) / clip.rate;
  return { min, max };
}

/** Copies the clip's sound to its own audio clip on `track` and mutes the original. */
function detachAudioOps(shot: MovieShot, at: number, track: number, newShotId: string): MovieEditOperation[] {
  return [
    { op: 'duplicate-clip', shotId: shot.id, newShotId, at, track },
    { op: 'update-clip', shotId: newShotId, changes: { audioOnly: true, muted: false } },
    { op: 'replace-captions', shotId: newShotId, captions: [] },
    { op: 'update-clip', shotId: shot.id, changes: { muted: true } },
  ];
}

/** The track a new audio lane gets: below the existing ones when possible, never the main track. */
function nextAudioTrack(audioTracks: number[]) {
  const below = Math.max(0, ...audioTracks) + 1;
  if (below <= MOVIE_MAX_TRACK) return below;
  for (let track = 1; track <= MOVIE_MAX_TRACK; track += 1) if (!audioTracks.includes(track)) return track;
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Lanes
 * ---------------------------------------------------------------------------------------------- */

export type TimelineLaneKind = 'caption' | 'video' | 'text' | 'audio';

export interface TimelineLane {
  key: string;
  kind: TimelineLaneKind;
  /** The document track (`placement.track`) the lane shows, or the track a drop on it creates. */
  track: number;
  top: number;
  height: number;
  /** Visible name: 字幕, 主轨, V2…V8, 文字, A1…An. */
  name: string;
  /** Stable code used in accessible names: V1…V8, A1…An. */
  code: string;
  /** `ghost`: a new track offered while dragging; `drop`: the empty audio lane shown until a film has detached sound. */
  role?: 'ghost' | 'drop';
}

/**
 * Lanes top to bottom: captions, video tracks high to low (track 0 = 主轨 at the bottom of the stack),
 * audio-only tracks, then (no audio-only clips yet) one empty audio drop lane, in both layouts so music always
 * has a visible target. Linked audio has no lane: it is a row inside its picture clip. `ghost` inserts the new-track lane a drag is currently over.
 */
export function buildLanes(
  spans: ClipSpan[],
  geometry: TimelineGeometry,
  options: { zh: boolean; full: boolean; ghost?: GhostSide | null },
): TimelineLane[] {
  const { zh, ghost } = options;
  const visual = spans.filter(span => !span.shot.clip?.audioOnly);
  const topVideo = clamp(Math.max(0, ...visual.map(span => span.track)), 0, MOVIE_MAX_TRACK);
  const audioTracks = [...new Set(spans.filter(span => span.shot.clip?.audioOnly).map(span => span.track))].sort((a, b) => a - b);
  const newTrack = zh ? '新轨道' : 'New track';
  const lanes: TimelineLane[] = [];
  const push = (lane: Omit<TimelineLane, 'top'>) => {
    const last = lanes[lanes.length - 1];
    lanes.push({ ...lane, top: last ? last.top + last.height : 0 });
  };

  push({ key: 'caption', kind: 'caption', track: MOVIE_MAIN_TRACK, height: geometry.caption, name: zh ? '字幕' : 'Captions', code: 'C' });
  if (ghost === 'above' && topVideo < MOVIE_MAX_TRACK) {
    push({ key: 'ghost-above', kind: 'video', track: topVideo + 1, height: geometry.ghost, name: newTrack, code: `V${topVideo + 2}`, role: 'ghost' });
  }
  for (let track = topVideo; track >= 0; track -= 1) {
    const main = track === MOVIE_MAIN_TRACK;
    const onTrack = visual.filter(span => span.track === track);
    const textOnly = !main && onTrack.length > 0 && onTrack.every(span => span.shot.kind === 'text');
    push({
      key: `v${track}`,
      kind: textOnly ? 'text' : 'video',
      track,
      height: main ? geometry.main : textOnly ? geometry.text : geometry.video,
      name: main ? (zh ? '主轨' : 'Main') : textOnly ? (zh ? '文字' : 'Text') : `V${track + 1}`,
      code: `V${track + 1}`,
    });
  }
  audioTracks.forEach((track, index) => {
    push({ key: `a${track}`, kind: 'audio', track, height: geometry.audio, name: `A${index + 1}`, code: `A${index + 1}` });
  });
  const next = nextAudioTrack(audioTracks);
  if (!audioTracks.length) {
    push({ key: 'audio-drop', kind: 'audio', track: next ?? 1, height: geometry.audio, name: 'A1', code: 'A1', role: 'drop' });
  } else if (ghost === 'below' && next !== null) {
    push({ key: 'ghost-below', kind: 'audio', track: next, height: geometry.ghost, name: newTrack, code: `A${audioTracks.length + 1}`, role: 'ghost' });
  }
  return lanes;
}

type LaneTarget =
  | { type: 'lane'; lane: TimelineLane }
  | { type: 'ghost'; side: GhostSide; track: number }
  | { type: 'reject'; lane: TimelineLane };

/**
 * Where a dragged item lands for a pointer at `y` (px from the top of the lanes).
 * - Picture and text go on video lanes; above the stack they create a track (ghost above). Media
 *   dropped over an audio lane is rejected; a moved clip clamps to the lowest video lane instead.
 * - Sound goes on audio lanes; below them it creates a track (ghost below); above them it lands on
 *   the first audio lane.
 */
function laneTarget(lanes: TimelineLane[], y: number, item: DragItem, media: boolean): LaneTarget {
  const inside = (lane: TimelineLane) => y >= lane.top && y < lane.top + lane.height;
  if (item === 'visual') {
    const video = lanes.filter(lane => (lane.kind === 'video' || lane.kind === 'text') && lane.role !== 'ghost');
    const first = video[0]!;
    if (y < first.top) return first.track < MOVIE_MAX_TRACK ? { type: 'ghost', side: 'above', track: first.track + 1 } : { type: 'lane', lane: first };
    const hit = video.find(inside);
    if (hit) return { type: 'lane', lane: hit };
    const audio = lanes.find(lane => lane.kind === 'audio' && inside(lane));
    return media && audio ? { type: 'reject', lane: audio } : { type: 'lane', lane: video[video.length - 1]! };
  }
  const audio = lanes.filter(lane => lane.kind === 'audio' && lane.role !== 'ghost');
  const next = nextAudioTrack(audio.filter(lane => lane.role !== 'drop').map(lane => lane.track));
  const last = audio[audio.length - 1];
  if (!last) return next === null ? { type: 'reject', lane: lanes[lanes.length - 1]! } : { type: 'ghost', side: 'below', track: next };
  if (y < audio[0]!.top) return { type: 'lane', lane: audio[0]! };
  const hit = audio.find(inside);
  if (hit) return { type: 'lane', lane: hit };
  return last.role !== 'drop' && next !== null ? { type: 'ghost', side: 'below', track: next } : { type: 'lane', lane: last };
}

function resolveTarget(target: LaneTarget) {
  if (target.type === 'ghost') return { laneKey: `ghost-${target.side}`, track: target.track, ghost: target.side, rejected: false };
  return { laneKey: target.lane.key, track: target.lane.track, ghost: null, rejected: target.type === 'reject' };
}

/** A ref that always holds the latest value, for native listeners attached once. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/* ------------------------------------------------------------------------------------------------
 * Toolbar pieces
 * ---------------------------------------------------------------------------------------------- */

interface Command {
  disabled: boolean;
  /** Shown as the tooltip of a disabled control. */
  reason?: string;
  run(): void;
}

interface TimelineTool {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Tooltip, when it should say more than the label. */
  hint?: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  reason?: string;
  /** COMPACT hides the control below this container width (its key still works). */
  hideBelow?: 440 | 600;
  onClick(): void;
}

type ToolSize = 'sm' | 'md';

function ToolButton({ tool, size }: { tool: TimelineTool; size: ToolSize }) {
  return (
    <IconButton
      size={size}
      aria-label={tool.label}
      tooltip={tool.hint ?? tool.label}
      tooltipSide="bottom"
      shortcut={tool.shortcut}
      on={tool.pressed}
      disabled={tool.disabled}
      disabledReason={tool.reason}
      data-hide-below={tool.hideBelow}
      onClick={tool.onClick}
    >
      <Icon icon={tool.icon} size={size} />
    </IconButton>
  );
}

/** 主轨磁吸 / 吸附 / 预览轴: icon toggles that show their text label once the timeline is 1280 px wide. */
function ModeToggle({ icon, label, text, hint, shortcut, pressed, size, hideBelow, onToggle }: {
  icon: LucideIcon;
  label: string;
  text: string;
  hint: string;
  shortcut?: string;
  pressed: boolean;
  size: ToolSize;
  hideBelow?: TimelineTool['hideBelow'];
  onToggle(): void;
}) {
  return (
    <Tooltip label={hint} shortcut={shortcut} side="bottom">
      <button
        type="button"
        className={styles.modeToggle}
        aria-label={label}
        aria-pressed={pressed}
        data-hide-below={hideBelow}
        onClick={onToggle}
      >
        <Icon icon={icon} size={size} />
        <span className={styles.modeText}>{text}</span>
      </button>
    </Tooltip>
  );
}

function ToolGroups({ groups, size }: { groups: TimelineTool[][]; size: ToolSize }) {
  return (
    <>
      {groups.map((tools, index) => (
        <Fragment key={tools[0]!.id}>
          {index ? <span className={styles.divider} /> : null}
          <div className={styles.toolGroup}>
            {tools.map(tool => <ToolButton key={tool.id} tool={tool} size={size} />)}
          </div>
        </Fragment>
      ))}
    </>
  );
}

function ZoomControl({ scale, size, zh, compact, onZoom }: { scale: number; size: ToolSize; zh: boolean; compact: boolean; onZoom(scale: number): void }) {
  return (
    <div className={styles.zoom}>
      <IconButton size={size} aria-label={zh ? '缩小时间线' : 'Zoom out timeline'} tooltipSide="bottom" shortcut="-" disabled={scale <= TIMELINE_ZOOM.min} onClick={() => onZoom(scale / TIMELINE_ZOOM.step)}>
        <Icon icon={Minus} size={size} />
      </IconButton>
      <input
        type="range"
        className={styles.zoomSlider}
        min={0}
        max={100}
        step={1}
        value={Math.round(sliderFromZoom(scale))}
        aria-label={zh ? '时间线缩放' : 'Timeline zoom'}
        aria-valuetext={`${Math.round(scale)} px/s`}
        data-hide-below={compact ? 600 : undefined}
        onChange={event => onZoom(zoomFromSlider(Number(event.target.value)))}
      />
      <IconButton size={size} aria-label={zh ? '放大时间线' : 'Zoom in timeline'} tooltipSide="bottom" shortcut="=" disabled={scale >= TIMELINE_ZOOM.max} onClick={() => onZoom(scale * TIMELINE_ZOOM.step)}>
        <Icon icon={Plus} size={size} />
      </IconButton>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Track headers
 * ---------------------------------------------------------------------------------------------- */

interface LaneState {
  locked: boolean;
  muted: boolean;
  /** The lane has sound to mute (audio lanes, video lanes with linked audio). */
  sound: boolean;
  lockText: string;
  muteText: string;
  lock: Command;
  mute: Command;
}

const LANE_ICONS: Record<TimelineLaneKind, LucideIcon> = { caption: Captions, video: Film, text: Type, audio: Music };

function TrackHeader({ lane, full, zh, state }: { lane: TimelineLane; full: boolean; zh: boolean; state?: LaneState }) {
  const glyph = lane.role === 'ghost' ? Plus : LANE_ICONS[lane.kind];
  const main = lane.kind === 'video' && lane.track === MOVIE_MAIN_TRACK;
  const common = {
    className: styles.header,
    'data-kind': lane.kind,
    'data-main': main || undefined,
    'data-role': lane.role,
    'data-locked': state?.locked || undefined,
    'data-muted': state?.muted || undefined,
    style: { height: lane.height },
  };
  const lockName = `${zh ? '锁定轨道' : 'Lock track'} ${lane.code}`;
  const muteName = `${zh ? '静音轨道' : 'Mute track'} ${lane.code}`;
  const menuItems = state ? (
    <>
      <TrackMenuItem full={full} icon={state.locked ? LockOpen : Lock} command={state.lock} text={state.lockText} />
      {state.sound ? <TrackMenuItem full={full} icon={state.muted ? Volume2 : VolumeX} command={state.mute} text={state.muteText} /> : null}
    </>
  ) : null;

  if (!full) {
    return (
      <div {...common}>
        {state ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="xs" className={styles.headerTile} data-kind={lane.kind} aria-label={`${zh ? '轨道选项' : 'Track options'} ${lane.code}`} tooltip={lane.name} tooltipSide="right">
                <Icon icon={glyph} size="sm" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">{menuItems}</DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className={styles.headerTile} data-kind={lane.kind} title={lane.name}>
            <Icon icon={glyph} size="sm" />
          </span>
        )}
        {state ? <span className={styles.headerDot} data-state={state.locked ? 'locked' : state.muted ? 'muted' : undefined} /> : null}
      </div>
    );
  }

  const body = (
    <div {...common}>
      <span className={styles.headerTile} data-kind={lane.kind}>
        <Icon icon={glyph} size="sm" />
      </span>
      <span className={styles.headerName}>{lane.name}</span>
      {state ? (
        <span className={styles.headerTools}>
          <IconButton size="xs" aria-label={lockName} tooltip={state.lockText} on={state.locked} disabled={state.lock.disabled} disabledReason={state.lock.reason} onClick={state.lock.run}>
            <Icon icon={state.locked ? Lock : LockOpen} size="sm" />
          </IconButton>
          {state.sound ? (
            <IconButton size="xs" aria-label={muteName} tooltip={state.muteText} on={state.muted} disabled={state.mute.disabled} disabledReason={state.mute.reason} onClick={state.mute.run}>
              <Icon icon={state.muted ? VolumeX : Volume2} size="sm" />
            </IconButton>
          ) : null}
        </span>
      ) : null}
    </div>
  );
  if (!state) return body;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent>{menuItems}</ContextMenuContent>
    </ContextMenu>
  );
}

/** Track menus: the COMPACT header's dropdown and the FULL header's right-click menu share their rows. */
function TrackMenuItem({ full, icon, command, text }: { full: boolean; icon: LucideIcon; command: Command; text: string }) {
  const props = { icon: <Icon icon={icon} size="sm" />, disabled: command.disabled, onSelect: () => command.run() };
  const label = command.disabled && command.reason ? <MenuItemText description={command.reason}>{text}</MenuItemText> : text;
  return full ? <ContextMenuItem {...props}>{label}</ContextMenuItem> : <DropdownMenuItem {...props}>{label}</DropdownMenuItem>;
}

/* ------------------------------------------------------------------------------------------------
 * Ruler and overview
 * ---------------------------------------------------------------------------------------------- */

interface RulerMarks {
  hover: number | null;
  snap: number | null;
  changed: Array<{ key: string; start: number; end: number }>;
}

function TimelineRuler({ scale, time, total, fps, from, to, label, marks, scrubbing, onPointerDown, onPointerMove, onPointerEnd, onKeyDown }: {
  scale: number;
  time: number;
  total: number;
  fps: number;
  /** Visible pixel window; labels outside it are not rendered. */
  from: number;
  to: number;
  label: string;
  marks: RulerMarks;
  scrubbing: boolean;
  onPointerDown(event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onPointerEnd(): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}) {
  const { major, minor } = rulerInterval(scale);
  const xOf = (seconds: number) => TIMELINE_ORIGIN + seconds * scale;
  const first = Math.max(0, Math.floor((from - TIMELINE_ORIGIN) / scale / major));
  const last = Math.ceil((to - TIMELINE_ORIGIN) / scale / major);
  const ticks: number[] = [];
  for (let index = first; index <= last; index += 1) ticks.push(index * major);
  return (
    <div
      className={styles.ruler}
      role="slider"
      tabIndex={0}
      data-timeline-ruler=""
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={time}
      aria-valuetext={formatTimecode(Math.round(time * fps), fps)}
      data-scrubbing={scrubbing || undefined}
      style={{ '--ruler-minor': `${minor * scale}px` } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
    >
      {ticks.map(seconds => (
        <span key={seconds} className={styles.tick} style={{ left: xOf(seconds) }}>
          <span className={styles.tickLabel}>{formatRulerTime(seconds)}</span>
        </span>
      ))}
      {marks.changed.map(range => (
        <span key={range.key} className={styles.rulerChange} style={{ left: xOf(range.start), width: Math.max(2, (range.end - range.start) * scale) }} />
      ))}
      {marks.snap === null ? null : <span key={marks.snap} className={styles.snapDot} style={{ left: xOf(marks.snap) }} />}
      {marks.hover === null ? null : (
        <span className={styles.hoverBadge} style={{ left: xOf(marks.hover) }}>
          {formatFrameTime(marks.hover, fps)}
        </span>
      )}
      <span className={styles.playheadHead} style={{ left: xOf(Math.min(time, total)) }} />
    </div>
  );
}

interface OverviewBar {
  key: string;
  row: number;
  kind: TimelineLaneKind;
  x: number;
  width: number;
}

/**
 * Minimap of the whole canvas (positions are canvas pixels): one 2 px bar row per lane, the playhead and
 * the visible window. Drag the window to pan, its edges to zoom; press elsewhere to centre the view there.
 */
function TimelineOverview({ bars, rows, height, canvasWidth, playheadX, windowRef, onPointerDown, onPointerMove, onPointerEnd }: {
  bars: OverviewBar[];
  rows: number;
  height: number;
  canvasWidth: number;
  playheadX: number;
  windowRef: RefObject<HTMLDivElement>;
  onPointerDown(event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onPointerEnd(): void;
}) {
  // Rows sit 3 px apart, squeezed when many lanes would not fit inside the strip's 2 px padding.
  const pitch = Math.min(3, (height - 4) / Math.max(1, rows));
  const percent = (x: number) => `${(x / Math.max(1, canvasWidth)) * 100}%`;
  return (
    <div
      className={styles.overview}
      aria-hidden="true"
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <svg className={styles.overviewBars} viewBox={`0 0 ${Math.max(1, canvasWidth)} ${rows * pitch}`} preserveAspectRatio="none" style={{ height: rows * pitch }}>
        {bars.map(bar => (
          <rect key={bar.key} className={styles.overviewBar} data-kind={bar.kind} x={bar.x} y={bar.row * pitch} width={Math.max(1, bar.width)} height={Math.max(1, pitch - 1)} />
        ))}
      </svg>
      <span className={styles.overviewPlayhead} style={{ left: percent(playheadX) }} />
      <div ref={windowRef} className={styles.overviewWindow} data-overview-window>
        <span className={styles.overviewEdge} data-edge="start" />
        <span className={styles.overviewEdge} data-edge="end" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Clips
 * ---------------------------------------------------------------------------------------------- */

interface ClipBadge {
  key: string;
  icon?: LucideIcon;
  text?: string;
  danger?: boolean;
  /** Spoken in the clip's accessible name. */
  label: string;
}

interface ClipModel {
  shot: MovieShot;
  kind: ClipKind;
  box: { top: number; left: number; width: number; height: number };
  label: string;
  selected: boolean;
  moving: boolean;
  changed: boolean;
  missing: boolean;
  trimmable: boolean;
  trimLabel(edge: TrimEdge): string;
  /** Width-adaptive label: name and badges, badges only, or nothing. */
  detail: 'full' | 'badges' | 'none';
  /** Height of the top strip; 0 floats the name over the content. */
  strip: number;
  badges: ClipBadge[];
  duration: string;
  film?: ReactNode;
  wave?: WaveDraw;
  /**
   * Linked audio: a full-width row at the bottom of the clip body. Collapsed it sits under the frames; `expanded`
   * (FULL's waveform display) fills the whole content area below the strip instead of the frames. An `inert` row
   * (a clip too narrow to aim at) keeps the seam level with its neighbours but draws and takes nothing.
   */
  band?: {
    label: string;
    wave?: WaveDraw;
    height: number;
    expanded: boolean;
    selected: boolean;
    inert: boolean;
    fades: ClipModel['fades'];
  };
  /** Fade widths in px at each end; `ramp` draws audio fades as lines instead of shaded triangles. */
  fades: { start: number; end: number; ramp: boolean };
  keyframes: Array<{ key: string; x: number; time: number; current: boolean }>;
}

interface ClipGestures {
  pointerDown(event: PointerEvent<HTMLButtonElement>, shot: MovieShot): void;
  pointerMove(event: PointerEvent<HTMLButtonElement>): void;
  pointerUp(): void;
  pointerCancel(): void;
  click(event: MouseEvent<HTMLButtonElement>, shot: MovieShot, lane: TrackKind): void;
  doubleClick(): void;
  trimDown(event: PointerEvent<HTMLButtonElement>, shot: MovieShot, edge: TrimEdge): void;
  trimMove(event: PointerEvent<HTMLButtonElement>): void;
  trimUp(): void;
  trimCancel(): void;
  seek(time: number): void;
}

function ClipBadges({ badges, duration }: { badges: ClipBadge[]; duration?: string }) {
  return (
    <span className={styles.badges} aria-hidden="true">
      {badges.map(badge => (
        <span key={badge.key} className={styles.badge} data-danger={badge.danger || undefined}>
          {badge.icon ? <Icon icon={badge.icon} size={10} /> : null}
          {badge.text}
        </span>
      ))}
      {duration ? <span className={styles.duration}>{duration}</span> : null}
    </span>
  );
}

function ClipFades({ fades, top, height }: { fades: ClipModel['fades']; top: number; height: number }) {
  const edges = height > 0 ? (['start', 'end'] as const).filter(edge => fades[edge] >= MIN_FADE_WIDTH) : [];
  return (
    <>
      {edges.map(edge => <ClipFade key={edge} edge={edge} width={fades[edge]} ramp={fades.ramp} top={top} height={height} />)}
    </>
  );
}

/** A shaded triangle over a picture fade, or a straight ramp line over an audio fade. */
function ClipFade({ edge, width, ramp, top, height }: { edge: 'start' | 'end'; width: number; ramp: boolean; top: number; height: number }) {
  const start = edge === 'start';
  const shade = start ? '0,0 100,0 0,100' : '0,0 100,0 100,100';
  // Picture: the hypotenuse of the shade. Audio: the volume ramp, rising into the clip.
  const line = ramp ? (start ? [0, 100, 100, 0] : [0, 0, 100, 100]) : start ? [100, 0, 0, 100] : [0, 0, 100, 100];
  return (
    <svg
      className={styles.fade}
      data-edge={edge}
      data-ramp={ramp || undefined}
      style={{ top, width, height }}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {ramp ? null : <polygon className={styles.fadeShade} points={shade} />}
      <line className={ramp ? styles.fadeRamp : styles.fadeEdge} x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TimelineClip({ model, gestures, zh }: { model: ClipModel; gestures: ClipGestures; zh: boolean }) {
  const { shot, kind, box, strip, detail, band } = model;
  const radius = Math.min(6, box.width / 4);
  /** Radius of the rows drawn inside the 1 px body border. */
  const inner = Math.max(0, radius - 1);
  /** Content height under the strip, inside the 1 px body border. */
  const content = Math.max(0, box.height - strip - 2);
  /** The audio row takes the bottom of the content; the frames keep the rest, so both share the clip's edges. */
  const bandRow = band ? (band.expanded ? content : Math.min(band.height, content)) : 0;
  const film = content - bandRow;
  const bandFlush = Boolean(band?.expanded && strip === 0);
  /** Height inside the row's 1 px top edge (none when it starts at the clip's top). */
  const bandInner = Math.max(0, bandRow - (bandFlush ? 0 : 1));
  /** Picture keyframes sit on the seam between the frames and a collapsed audio row, not on the sound. */
  const seam = band && !band.expanded ? bandRow + 1 : 0;
  const bandStyle = { height: bandRow, borderRadius: bandFlush ? inner : `0 0 ${inner}px ${inner}px` };
  const name = detail === 'full' ? <span className={styles.clipName}>{shot.title}</span> : null;
  const badges = detail === 'none' ? null : <ClipBadges badges={model.badges} duration={detail === 'full' ? model.duration : undefined} />;
  return (
    <div
      className={styles.clip}
      data-shot-id={shot.id}
      data-lane={kind === 'audio' ? 'audio' : 'video'}
      data-kind={kind}
      data-selected={model.selected}
      data-locked={Boolean(shot.locked)}
      data-muted={Boolean(shot.clip?.muted)}
      data-moving={model.moving}
      data-changed={model.changed}
      data-missing={model.missing || undefined}
      style={{ ...box, borderRadius: radius }}
    >
      <button
        type="button"
        className={styles.clipBody}
        aria-label={model.label}
        aria-pressed={model.selected}
        onPointerDown={event => gestures.pointerDown(event, shot)}
        onPointerMove={gestures.pointerMove}
        onPointerUp={gestures.pointerUp}
        onPointerCancel={gestures.pointerCancel}
        onClick={event => gestures.click(event, shot, kind === 'audio' ? 'audio' : 'video')}
        onDoubleClick={gestures.doubleClick}
      >
        {kind === 'video' ? <span className={styles.film} style={{ top: strip, height: film }}>{model.film}</span> : null}
        {kind === 'audio' && model.wave ? <WaveSvg className={styles.wave} wave={model.wave} top={strip + 2} /> : null}
        {kind === 'text' ? (
          <span className={styles.textLabel}>
            {detail === 'none' ? null : <Icon icon={Type} size={11} />}
            {name}
            {badges}
          </span>
        ) : (
          <span className={styles.strip} data-overlay={strip === 0 || undefined} style={strip ? { height: strip } : undefined}>
            {name}
            {badges}
          </span>
        )}
      </button>
      {band?.inert ? (
        <span className={styles.band} data-inert="true" data-expanded={band.expanded || undefined} data-flush={bandFlush || undefined} aria-hidden="true" style={bandStyle}>
          {band.wave ? <WaveSvg className={styles.bandWave} wave={band.wave} top={band.expanded ? 0 : 2} /> : null}
        </span>
      ) : null}
      {band && !band.inert ? (
        <button
          type="button"
          className={styles.band}
          data-lane="audio"
          data-expanded={band.expanded || undefined}
          data-flush={bandFlush || undefined}
          aria-label={band.label}
          aria-pressed={band.selected}
          style={bandStyle}
          onPointerDown={event => gestures.pointerDown(event, shot)}
          onPointerMove={gestures.pointerMove}
          onPointerUp={gestures.pointerUp}
          onPointerCancel={gestures.pointerCancel}
          onClick={event => gestures.click(event, shot, 'audio')}
          onDoubleClick={gestures.doubleClick}
        >
          {band.wave ? <WaveSvg className={styles.bandWave} wave={band.wave} top={band.expanded ? 0 : 2} /> : null}
          <ClipFades fades={band.fades} top={0} height={bandInner} />
        </button>
      ) : null}
      <ClipFades fades={model.fades} top={strip + 1} height={kind === 'video' ? film : content} />
      {model.keyframes.map(keyframe => (
        <button
          key={keyframe.key}
          type="button"
          tabIndex={-1}
          className={styles.keyframe}
          data-current={keyframe.current || undefined}
          style={{ left: keyframe.x, bottom: seam - (keyframe.current ? 4.5 : 3.5) }}
          aria-label={`${zh ? '关键帧' : 'Keyframe'} ${formatClipDuration(keyframe.time)}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            gestures.seek(keyframe.time);
          }}
        />
      ))}
      {model.trimmable
        ? TRIM_EDGES.map(edge => (
            <button
              key={edge}
              type="button"
              tabIndex={-1}
              className={styles.trimHandle}
              data-edge={edge}
              aria-label={model.trimLabel(edge)}
              onPointerDown={event => gestures.trimDown(event, shot, edge)}
              onPointerMove={gestures.trimMove}
              onPointerUp={gestures.trimUp}
              onPointerCancel={gestures.trimCancel}
            />
          ))
        : null}
    </div>
  );
}

/** A waveform box placed over the visible part of its row; the path is already in the box's pixels. */
function WaveSvg({ className, wave, top }: { className?: string; wave: WaveDraw; top: number }) {
  return (
    <svg
      className={className}
      style={{ top, left: wave.left, width: wave.width, height: wave.height }}
      viewBox={`0 0 ${wave.width} ${wave.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={wave.d} />
    </svg>
  );
}

/**
 * Frames at the source aspect, sized to the film height; only tiles near the viewport are rendered. Tiles sit on a
 * grid anchored to source time, so trimming the head keeps the remaining pictures still and the halves of a split
 * continue each other; each tile shows the frame nearest the time at its centre.
 */
function Filmstrip({ shot, source, from, width, height, scale, visible, url }: {
  shot: MovieShot;
  source: MovieVideoSource | undefined;
  /** Shown part of the clip, in output seconds from its start. */
  from: number;
  /** Film row width (the clip's inner width). */
  width: number;
  height: number;
  /** Timeline px per output second. */
  scale: number;
  /** Clip-local pixel window worth rendering. */
  visible: [number, number];
  url(path: string): string;
}) {
  const frames = source?.frames ?? [];
  if (!frames.length) {
    return (
      <span className={styles.noFrame}>
        <Icon icon={source?.kind === 'image' ? ImageIcon : Film} size="md" />
      </span>
    );
  }
  const aspect = source && source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9;
  const tile = Math.max(16, Math.round(height * aspect));
  const sourceIn = shot.clip?.in ?? 0;
  const rate = shot.clip?.rate ?? 1;
  /** Film x 0 is CLIP_CONTENT_X px after the clip's start time on the ruler. */
  const offset = (sourceIn / rate + from) * scale + CLIP_CONTENT_X;
  const first = Math.floor((Math.max(0, visible[0]) + offset) / tile);
  const last = Math.min(Math.ceil((Math.min(width, visible[1]) + offset) / tile), first + MAX_FILM_TILES);
  const tiles: ReactNode[] = [];
  for (let k = first; k < last; k += 1) {
    const left = k * tile - offset;
    const at = sourceIn + (from + (clamp(left + tile / 2, 0, width) + CLIP_CONTENT_X) / scale) * rate;
    tiles.push(<img key={k} src={url(nearestFrame(frames, at).path)} alt="" draggable={false} decoding="async" style={{ left, width: tile }} />);
  }
  return <span className={styles.filmstrip} aria-hidden="true">{tiles}</span>;
}

/* ------------------------------------------------------------------------------------------------
 * Context menus
 * ---------------------------------------------------------------------------------------------- */

interface ClipCommands {
  split: Command;
  trimBefore: Command;
  trimAfter: Command;
  duplicate: Command;
  detach: Command;
  lock: Command;
  mute: Command;
  remove: Command;
  ripple: Command;
}

function MenuItem({ command, icon, text, shortcut, danger }: { command: Command; icon: LucideIcon; text: string; shortcut?: string; danger?: boolean }) {
  return (
    <ContextMenuItem
      icon={<Icon icon={icon} size="sm" />}
      shortcut={shortcut}
      tone={danger ? 'danger' : 'default'}
      disabled={command.disabled}
      onSelect={() => command.run()}
    >
      {text}
    </ContextMenuItem>
  );
}

function ClipMenu({ zh, shot, commands }: { zh: boolean; shot: MovieShot; commands: ClipCommands }) {
  const muted = Boolean(shot.clip?.muted);
  return (
    <ContextMenuContent>
      <MenuItem command={commands.split} icon={Scissors} text={zh ? '分割' : 'Split'} shortcut="mod+b" />
      <MenuItem command={commands.trimBefore} icon={ArrowLeftToLine} text={zh ? '向左裁剪' : 'Trim left'} shortcut="q" />
      <MenuItem command={commands.trimAfter} icon={ArrowRightToLine} text={zh ? '向右裁剪' : 'Trim right'} shortcut="w" />
      <ContextMenuSeparator />
      <MenuItem command={commands.duplicate} icon={Copy} text={zh ? '复制' : 'Duplicate'} shortcut="mod+d" />
      <ContextMenuSeparator />
      <MenuItem command={commands.mute} icon={muted ? Volume2 : VolumeX} text={muted ? (zh ? '取消静音' : 'Unmute') : (zh ? '静音' : 'Mute')} shortcut="m" />
      <MenuItem command={commands.detach} icon={Unlink} text={zh ? '分离音频' : 'Detach audio'} />
      <MenuItem command={commands.lock} icon={shot.locked ? LockOpen : Lock} text={shot.locked ? (zh ? '解锁' : 'Unlock') : (zh ? '锁定' : 'Lock')} shortcut="mod+l" />
      <ContextMenuSeparator />
      <MenuItem command={commands.remove} icon={Trash2} text={zh ? '删除' : 'Delete'} shortcut="backspace" danger />
      <MenuItem command={commands.ripple} icon={FoldHorizontal} text={zh ? '删除并合拢' : 'Ripple delete'} shortcut="shift+backspace" danger />
    </ContextMenuContent>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Timeline
 * ---------------------------------------------------------------------------------------------- */

export interface MovieTrackTimelineProps {
  document: MovieDocument;
  sources: MovieVideoSource[];
  projectId: string;
  context?: WorkspaceCollabContext | null;
  time: number;
  selectedId?: string;
  selectedKind?: TrackKind;
  disabled: boolean;
  /** Defaults to the surrounding editor layout. */
  variant?: MovieEditorLayout;
  /** Clips changed by an edit from outside this editor (the project chat): outlined until cleared. */
  highlightIds?: string[];
  /** Gates 预览轴 hover scrub, which only previews while paused. */
  playing?: boolean;
  /** `null` clears the selection (a click on an empty part of the tracks). */
  onSelect(id: string | null, kind?: TrackKind): void;
  onSeek(time: number): void;
  onEdit(label: string, ops: MovieEditOperation[]): Promise<boolean>;
  onAddSource(source: MovieVideoSource, index?: number, placement?: { start: number; track: number }): void;
  /** 预览轴: the time under the pointer while hovering the paused timeline; `null` restores the playhead frame. */
  onHoverPreview?(time: number | null): void;
  /** A transition badge or caption chip asks the inspector for a tab (and section or cue). */
  onRequestInspector?(request: Omit<MovieInspectorRequest, 'nonce'>): void;
  /** Double-click on a clip reveals the inspector. */
  onOpenInspector?(): void;
  onUndo?: () => void;
  onRedo?: () => void;
  undoEnabled?: boolean;
  redoEnabled?: boolean;
}

interface TrimGesture {
  id: string;
  edge: TrimEdge;
  x: number;
  /** Clip start on the timeline when the gesture began. */
  base: number;
  duration: number;
  /** Kept range in local seconds; may extend past 0 / duration within [min, max]. */
  start: number;
  end: number;
  min: number;
  max: number;
}

interface MovePreview {
  id: string;
  start: number;
  track: number;
  laneKey: string;
}

interface MoveGesture {
  id: string;
  item: DragItem;
  x: number;
  y: number;
  start: number;
  track: number;
  duration: number;
  moved: boolean;
  preview: MovePreview | null;
}

interface OverviewDrag {
  x: number;
  scrollLeft: number;
  /** Canvas pixels per overview pixel. */
  ratio: number;
  edge: 'start' | 'end' | null;
  from: number;
  to: number;
  view: number;
  scale: number;
}

type MenuTarget = { type: 'clip'; id: string; lane: TrackKind } | { type: 'lane'; time: number; track: number };

export function MovieTrackTimeline({
  document: d,
  sources,
  projectId,
  context,
  time,
  selectedId,
  selectedKind,
  disabled,
  variant: variantProp,
  highlightIds,
  playing = false,
  onSelect,
  onSeek,
  onEdit,
  onAddSource,
  onHoverPreview,
  onRequestInspector,
  onOpenInspector,
  onUndo,
  onRedo,
  undoEnabled,
  redoEnabled,
}: MovieTrackTimelineProps) {
  const layout = useMovieEditorLayout();
  const variant = variantProp ?? layout;
  const full = variant === 'full';
  const geometry = TIMELINE_GEOMETRY[variant];
  const toolSize: ToolSize = full ? 'md' : 'sm';
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const fps = movieFps(d);

  const [magnet, setMagnet] = useMoviePref('magnet');
  const [snap, setSnap] = useMoviePref('snap');
  const [skim, setSkim] = useMoviePref('skim');
  const [clipDisplay, setClipDisplay] = useMoviePref('clipDisplay');
  const [scale, setScale] = useState<number>(TIMELINE_ZOOM.initial);
  const [blade, setBlade] = useState(false);
  const [localKind, setLocalKind] = useState<TrackKind>('video');
  const [trim, setTrim] = useState<TrimGesture | null>(null);
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [ghost, setGhost] = useState<GhostSide | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; rejected: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const overviewWindowRef = useRef<HTMLDivElement>(null);
  const snapState = useRef<SnapState>({ currentProbeOffset: 0 });
  const trimGesture = useRef<TrimGesture | null>(null);
  const moveGesture = useRef<MoveGesture | null>(null);
  const overviewDrag = useRef<OverviewDrag | null>(null);
  const seeking = useRef(false);
  const skipClick = useRef(false);
  const zoomAnchor = useRef<{ time: number; offset: number } | null>(null);
  const fittedProject = useRef<string | null>(null);
  /** The zoom is the fitted one and `fitWidth` is the viewport width it was fitted to. */
  const autoFit = useRef(false);
  const fitWidth = useRef(0);
  const dragItem = useRef<DragItem | null>(null);
  const hover = useRef({ frame: 0, next: null as number | null, sent: false });
  const revealedChange = useRef('');

  /* ---- Document-derived layout ---- */
  const spans = useMemo(() => movieClipSpans(d), [d]);
  const total = movieDuration(d);
  const edges = useMemo(() => [...spans.flatMap(span => [span.start, span.end]), total], [spans, total]);
  const sourceById = useMemo(() => new Map(sources.map(source => [source.assetId, source])), [sources]);
  const sourceOf = (shot: MovieShot) => (shot.clip ? sourceById.get(shot.clip.assetId) : undefined);
  const spanOf = (id: string) => spans.find(span => span.shot.id === id);
  const lanes = useMemo(() => buildLanes(spans, geometry, { zh, full, ghost }), [spans, geometry, zh, full, ghost]);
  const laneByKey = useMemo(() => new Map(lanes.map(lane => [lane.key, lane])), [lanes]);
  const lastLane = lanes[lanes.length - 1]!;
  const lanesHeight = lastLane.top + lastLane.height;
  const audioTracks = lanes.filter(lane => lane.kind === 'audio' && !lane.role).map(lane => lane.track);
  const xOf = (seconds: number) => TIMELINE_ORIGIN + seconds * scale;
  const canvasWidth = Math.max(view.width, xOf(total) + Math.max(240, view.width / 2));
  const highlightKey = highlightIds?.join('|') ?? '';
  const highlight = useMemo(() => new Set(highlightKey ? highlightKey.split('|') : []), [highlightKey]);
  /** Cuts with a transition (badge) or a plain cut between adjacent picture clips; computed once per document. */
  const junctions = useMemo(
    () => spans.flatMap(span => {
      if (!span.shot.clip || span.shot.clip.audioOnly || movieNextShotIndex(d, span.index) < 0) return [];
      const blended = movieTransitionDuration(d, span.index) > 0;
      return [{ span, transition: blended ? movieShotVisual(d, span.shot).transition : null }];
    }),
    [d, spans],
  );

  const selected = selectedId ? d.shots.find(shot => shot.id === selectedId) : undefined;
  const selectedLane: TrackKind = selected?.clip?.audioOnly ? 'audio' : (selectedKind ?? localKind);
  const bandSelected = Boolean(selected && selectedLane === 'audio' && !selected.clip?.audioOnly);
  const bladeActive = full && blade;
  const skimActive = skim && !playing;
  const raw = (path: string) => workspaceResourceUrl(`/api/projects/${projectId}/raw/${path}`, context);
  const onHoverPreviewRef = useLatest(onHoverPreview);
  /** Waveform paths per source peak array, so playback and hover re-renders do not rebuild them. */
  const waveCache = useRef(new WeakMap<number[], Map<string, string>>());
  const cachedWaveform = (
    source: MovieVideoSource,
    start: number,
    span: number,
    volume: number,
    width: number,
    height: number,
    baseline: boolean,
    pxPerSecond: number,
  ) => {
    const peaks = source.audioPeaks;
    if (!peaks?.length) return '';
    let paths = waveCache.current.get(peaks);
    if (!paths) waveCache.current.set(peaks, (paths = new Map()));
    const key = `${start.toFixed(4)}|${span.toFixed(4)}|${volume}|${width}|${height}|${baseline ? 1 : 0}|${pxPerSecond.toFixed(4)}`;
    let path = paths.get(key);
    if (path === undefined) {
      if (paths.size > 256) paths.clear();
      path = clipWaveform(source, start, span, volume, { width, height, baseline, pxPerSecond });
      paths.set(key, path);
    }
    return path;
  };

  /* ---- Viewport, zoom and playhead following ---- */
  const placeOverview = () => {
    const el = scrollRef.current;
    const frame = overviewWindowRef.current;
    if (!el || !frame || canvasWidth <= 0) return;
    frame.style.left = `${(el.scrollLeft / canvasWidth) * 100}%`;
    frame.style.width = `${Math.min(1, Math.max(0, el.clientWidth - geometry.header) / canvasWidth) * 100}%`;
  };
  useLayoutEffect(placeOverview);

  const measureView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = { left: Math.floor(el.scrollLeft / VIEW_BUCKET) * VIEW_BUCKET, width: Math.max(0, el.clientWidth - geometry.header) };
    setView(current => (current.left === next.left && current.width === next.width ? current : next));
  }, [geometry.header]);

  useLayoutEffect(() => {
    measureView();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureView);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureView]);

  /** Any zoom other than 适应时间线 leaves fit mode, so a later width change keeps the user's zoom. */
  const zoomTo = (next: number, anchor?: { time: number; offset: number }, keepFit = false) => {
    autoFit.current = keepFit;
    const target = clampZoom(next);
    if (target === scale) return;
    const el = scrollRef.current;
    if (el) {
      const width = el.clientWidth - geometry.header;
      const playX = xOf(time) - el.scrollLeft;
      zoomAnchor.current = anchor ?? { time, offset: playX >= 0 && playX <= width ? playX : width * 0.1 };
    }
    setScale(target);
  };
  const fit = () => {
    const width = (scrollRef.current?.clientWidth ?? 0) - geometry.header;
    fitWidth.current = width;
    zoomTo(fitZoom(width, total), { time: 0, offset: TIMELINE_ORIGIN }, true);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  /* Zooming keeps the anchor (playhead or pointer) where it was on screen. */
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const el = scrollRef.current;
    zoomAnchor.current = null;
    if (anchor && el) el.scrollLeft = Math.max(0, TIMELINE_ORIGIN + anchor.time * scale - anchor.offset);
  }, [scale]);

  /*
   * Fit the film once per project, as soon as it has content and the pane has a width. While the zoom is still the
   * fitted one (no manual zoom since), a width change — 完整剪辑 ↔ the project pane, a resized pane — fits it again.
   * Edits that change the film length never re-zoom.
   */
  useEffect(() => {
    if (total <= 0 || view.width <= 0) return;
    if (fittedProject.current !== projectId) {
      fittedProject.current = projectId;
      autoFit.current = true;
    } else if (!autoFit.current || Math.abs(view.width - fitWidth.current) < 2) return;
    fitWidth.current = view.width;
    setScale(fitZoom(view.width, total));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [projectId, total, view.width]);

  /*
   * Page the view when the playhead moves out of sight (playback, End, edit-point jumps, typed timecode). Only a
   * moving playhead pages: a zoom, length or header change alone never does, so a pointer-anchored zoom keeps its anchor.
   */
  const followedTime = useRef(Math.min(time, total));
  useEffect(() => {
    const at = Math.min(time, total);
    const moved = followedTime.current !== at;
    followedTime.current = at;
    const el = scrollRef.current;
    if (!moved || !el || seeking.current || trimGesture.current || moveGesture.current) return;
    const width = el.clientWidth - geometry.header;
    const x = TIMELINE_ORIGIN + at * scale;
    if (width > 0 && (x < el.scrollLeft || x > el.scrollLeft + width)) el.scrollLeft = Math.max(0, x - width * 0.1);
  }, [time, total, scale, geometry.header]);

  /* Bring the first clip changed from outside into view once per change, without zooming. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !highlightKey || revealedChange.current === highlightKey) return;
    revealedChange.current = highlightKey;
    const first = spans.filter(span => highlight.has(span.shot.id)).sort((a, b) => a.start - b.start)[0];
    const width = el.clientWidth - geometry.header;
    if (!first || width <= 0) return;
    const left = TIMELINE_ORIGIN + first.start * scale;
    const right = TIMELINE_ORIGIN + first.end * scale;
    if (right < el.scrollLeft || left > el.scrollLeft + width) el.scrollLeft = Math.max(0, left - width * 0.1);
  }, [highlightKey, highlight, spans, scale, geometry.header]);

  /* ---- Pointer helpers and snapping ---- */
  const timeAt = (clientX: number) => Math.max(0, (clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0) - TIMELINE_ORIGIN) / scale);
  const pointerY = (clientY: number) => clientY - (lanesRef.current?.getBoundingClientRect().top ?? 0);

  /** Snaps to clip edges, 0, the film end and (optionally) the playhead; Shift or the 吸附 toggle bypasses. */
  const snapTime = (seconds: number, options: { exclude?: string; playhead?: boolean; bypass?: boolean; length?: number } = {}) => {
    const frame = Math.round(seconds * fps);
    const others = spans.filter(span => span.shot.id !== options.exclude);
    const clips = others.map(span => ({ id: span.shot.id, startFrame: Math.round(span.start * fps), endFrame: Math.round(span.end * fps) }));
    const end = Math.round(Math.max(0, ...others.map(span => span.end)) * fps);
    const targets = collectTargets([{ clips }], Math.round(time * fps), new Set(), options.playhead, [0, end]);
    const probes = options.length ? [0, Math.round(options.length * fps)] : [0];
    const result = snap && !options.bypass ? findSnap(frame, probes, targets, snapState.current, SNAP.thresholdPixels, scale / fps) : null;
    if (!result) snapState.current = { currentProbeOffset: 0 };
    setSnapAt(result ? result.frame / fps : null);
    return (result ? result.frame - result.probeOffset : frame) / fps;
  };
  const resetSnap = () => {
    snapState.current = { currentProbeOffset: 0 };
    setSnapAt(null);
  };

  /* ---- 预览轴 hover scrub: rAF-coalesced, latest wins ---- */
  const flushHover = () => {
    const state = hover.current;
    state.frame = 0;
    setHoverTime(state.next);
    if (state.next === null && !state.sent) return;
    state.sent = state.next !== null;
    onHoverPreviewRef.current?.(state.next);
  };
  const queueHover = (next: number | null) => {
    hover.current.next = next;
    if (!hover.current.frame) hover.current.frame = requestAnimationFrame(flushHover);
  };
  useEffect(() => {
    if (skimActive) return;
    const state = hover.current;
    cancelAnimationFrame(state.frame);
    state.frame = 0;
    state.next = null;
    setHoverTime(null);
    if (state.sent) {
      state.sent = false;
      onHoverPreviewRef.current?.(null);
    }
  }, [skimActive, onHoverPreviewRef]);
  useEffect(() => () => cancelAnimationFrame(hover.current.frame), []);

  const skimMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!skimActive || seeking.current || trimGesture.current || moveGesture.current?.moved) return;
    const left = scrollRef.current?.getBoundingClientRect().left ?? 0;
    queueHover(event.clientX < left + geometry.header ? null : Math.min(total, timeAt(event.clientX)));
  };
  const skimLeave = () => {
    if (skimActive) queueHover(null);
  };

  /* ---- Wheel: ⌘/Ctrl+wheel and pinch zoom around the pointer, Shift+wheel pans ---- */
  const onWheel = useLatest((event: WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (!delta) return;
      const pinch = Math.abs(delta) < 10;
      const at = Math.min(total, timeAt(event.clientX));
      zoomTo(scale * Math.exp(-delta * (pinch ? 0.01 : 0.002)), { time: at, offset: xOf(at) - el.scrollLeft });
    } else if (event.shiftKey && !event.deltaX && event.deltaY) {
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    }
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const listener = (event: WheelEvent) => onWheel.current(event);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, [onWheel]);

  /* ---- Media drags: learn whether picture or sound is dragged, since dragover cannot read the data ---- */
  const sniffDrag = useLatest((event: DragEvent) => {
    const id = event.dataTransfer?.getData(SOURCE_MIME);
    dragItem.current = id ? (sourceById.get(id)?.kind === 'audio' ? 'audio' : 'visual') : null;
  });
  useEffect(() => {
    const start = (event: DragEvent) => sniffDrag.current(event);
    const end = () => {
      dragItem.current = null;
      setDropTarget(null);
      setGhost(null);
    };
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', end);
    };
  }, [sniffDrag]);

  /* ---- Edit commands (one user intention = one batch) ---- */
  const apply = (label: string, operations: MovieEditOperation[]) => (operations.length ? onEdit(label, operations) : Promise.resolve(false));

  const select = (id: string, kind: TrackKind) => {
    setLocalKind(kind);
    onSelect(id, kind);
  };

  const reasons = {
    locked: zh ? '片段已锁定' : 'The clip is locked',
    noTarget: zh ? '先选择片段，或把播放头移到片段内' : 'Select a clip, or move the playhead into one',
    edge: zh ? '播放头太靠近片段边缘' : 'The playhead is too close to the clip edge',
    noSelection: zh ? '先选择片段' : 'Select a clip first',
    noSound: zh ? '片段没有声音' : 'This clip has no sound',
    band: zh ? '原声随画面一起剪切，请选中画面' : 'Linked audio is cut with its picture; select the picture',
    soundOff: zh ? '原声已关闭' : 'The clip audio is already off',
    tooManyClips: zh ? `本轨片段太多，超出单次编辑上限（${MOVIE_MAX_EDIT_OPERATIONS} 项）` : `Too many clips on this track for one edit (limit ${MOVIE_MAX_EDIT_OPERATIONS})`,
  };
  const blocked = (reason: string): Command => ({ disabled: true, reason: disabled ? undefined : reason, run() {} });
  const command = (reason: string | null, run: () => void): Command => (disabled || reason ? blocked(reason ?? '') : { disabled: false, run });

  /** Split / trim at the playhead on `shot` (the selected clip, or the clip under the playhead). */
  const cutCommand = (shot: MovieShot | undefined, kind: MovieCutKind, label: string, blockedReason?: string): Command => {
    if (blockedReason) return blocked(blockedReason);
    if (!shot) return blocked(reasons.noTarget);
    if (shot.locked) return blocked(reasons.locked);
    const local = movieLocalTime(d, shot, time);
    if (local === null || local <= 0 || local >= shot.duration) return blocked(reasons.noTarget);
    if (local < 1 / fps || local > shot.duration - 1 / fps) return blocked(reasons.edge);
    return command(null, () => void apply(label, movieCutOperations(d, shot, local, kind, { magnet })));
  };

  const clipCommands = (shot: MovieShot | undefined, lane: TrackKind, cutTarget: MovieShot | undefined): ClipCommands => {
    const band = Boolean(shot && lane === 'audio' && !shot.clip?.audioOnly);
    const sound = Boolean(shot?.clip && (shot.clip.audioOnly || hasLinkedAudio(shot, sourceOf(shot))));
    const editReason = !shot ? reasons.noSelection : shot.locked ? reasons.locked : null;
    const cutBlocked = band ? reasons.band : undefined;
    return {
      split: cutCommand(cutTarget, 'split', zh ? '分割片段' : 'Split clip', cutBlocked),
      trimBefore: cutCommand(cutTarget, 'trim-before', zh ? '向左裁剪' : 'Trim left', cutBlocked),
      trimAfter: cutCommand(cutTarget, 'trim-after', zh ? '向右裁剪' : 'Trim right', cutBlocked),
      remove: command(editReason ?? (band && shot?.clip?.muted ? reasons.soundOff : null), () => {
        if (!shot) return;
        if (band) {
          // Deleting linked audio silences the picture's sound and keeps the picture.
          void apply(zh ? '关闭原声' : 'Mute clip audio', [{ op: 'update-clip', shotId: shot.id, changes: { muted: true } }]);
          return;
        }
        void apply(zh ? '删除片段' : 'Delete clip', movieCutOperations(d, shot, 0, 'delete', { magnet })).then(ok => {
          if (ok) onSelect(null);
        });
      }),
      ripple: command(editReason ?? (band ? reasons.band : null), () => {
        if (!shot) return;
        void apply(zh ? '删除并合拢' : 'Ripple delete', movieCutOperations(d, shot, 0, 'ripple-delete', { magnet })).then(ok => {
          if (ok) onSelect(null);
        });
      }),
      duplicate: command(editReason, () => {
        if (!shot) return;
        const id = crypto.randomUUID();
        void apply(zh ? '复制片段' : 'Duplicate clip', [{ op: 'duplicate-clip', shotId: shot.id, newShotId: id, ...movieDuplicatePlacement(d, shot) }]).then(ok => {
          if (ok) select(id, lane);
        });
      }),
      detach: command(editReason ?? (!shot?.clip || shot.clip.audioOnly || !sound ? reasons.noSound : null), () => {
        const span = shot && spanOf(shot.id);
        if (!shot || !span) return;
        const id = crypto.randomUUID();
        const track = nextAudioTrack(audioTracks) ?? MOVIE_MAX_TRACK;
        void apply(zh ? '分离音频' : 'Detach audio', detachAudioOps(shot, span.start, track, id)).then(ok => {
          if (ok) select(id, 'audio');
        });
      }),
      lock: command(shot ? null : reasons.noSelection, () => {
        if (!shot) return;
        const label = shot.locked ? (zh ? '解锁片段' : 'Unlock clip') : (zh ? '锁定片段' : 'Lock clip');
        void apply(label, movieLockOperations(d, [shot], !shot.locked));
      }),
      mute: command(editReason ?? (sound ? null : reasons.noSound), () => {
        if (!shot) return;
        const muted = Boolean(shot.clip?.muted);
        void apply(muted ? (zh ? '取消静音' : 'Unmute clip') : (zh ? '静音片段' : 'Mute clip'), [{ op: 'update-clip', shotId: shot.id, changes: { muted: !muted } }]);
      }),
    };
  };

  /** One batch over a whole track: disabled when there is nothing to change or more than one edit request accepts. */
  const trackCommand = (label: string, operations: MovieEditOperation[]): Command => {
    if (!operations.length) return { disabled: true, run() {} };
    return command(operations.length > MOVIE_MAX_EDIT_OPERATIONS ? reasons.tooManyClips : null, () => void apply(label, operations));
  };

  /** Track-wide lock / mute: one batch over every clip on the lane. Track 0's mute is 关闭原声. */
  const laneState = (lane: TimelineLane): LaneState | undefined => {
    // Placeholder lanes (a drag's new track, the empty audio drop lane) hold no clips to lock or mute.
    if (lane.kind === 'caption' || lane.role) return undefined;
    const audioLane = lane.kind === 'audio';
    const members = spans.filter(span => span.track === lane.track && Boolean(span.shot.clip?.audioOnly) === audioLane).map(span => span.shot);
    const audible = audioLane ? members : members.filter(shot => hasLinkedAudio(shot, sourceOf(shot)));
    const mutable = audible.filter(shot => !shot.locked);
    const locked = members.length > 0 && members.every(shot => shot.locked);
    const muted = audible.length > 0 && audible.every(shot => shot.clip?.muted);
    const main = lane.kind === 'video' && lane.track === MOVIE_MAIN_TRACK;
    const lockText = locked ? (zh ? '解锁轨道' : 'Unlock track') : (zh ? '锁定轨道' : 'Lock track');
    const muteText = main
      ? muted ? (zh ? '打开原声' : 'Restore original sound') : (zh ? '关闭原声' : 'Mute original sound')
      : muted ? (zh ? '取消静音轨道' : 'Unmute track') : (zh ? '静音轨道' : 'Mute track');
    const muteOperations: MovieEditOperation[] = mutable
      .filter(shot => Boolean(shot.clip?.muted) === muted)
      .map(shot => ({ op: 'update-clip', shotId: shot.id, changes: { muted: !muted } }));
    return {
      locked,
      muted,
      sound: audioLane || audible.length > 0,
      lockText,
      muteText,
      lock: trackCommand(`${lockText} ${lane.code}`, movieLockOperations(d, members, !locked)),
      mute: trackCommand(main ? muteText : `${muteText} ${lane.code}`, muteOperations),
    };
  };

  const insertText = (at: number, track: number) => {
    const id = crypto.randomUUID();
    void apply(zh ? '添加文字' : 'Add text', [
      { op: 'insert-text', text: zh ? '输入文字' : 'Your text', at, duration: MOVIE_TEXT_DURATION, track, newShotId: id },
    ]).then(ok => {
      if (ok) select(id, 'video');
    });
  };

  const toolbarCommands = clipCommands(selected, selectedLane, movieTargetShot(d, time, selectedId));

  /* ---- Gestures: scrubbing, moving, trimming, blade ---- */
  const seekTo = (clientX: number, bypass: boolean) => onSeek(snapTime(Math.min(total, timeAt(clientX)), { bypass }));
  const ruler = {
    down: (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      snapState.current = { currentProbeOffset: 0 };
      seeking.current = true;
      setScrubbing(true);
      queueHover(null);
      seekTo(event.clientX, event.shiftKey);
    },
    move: (event: PointerEvent<HTMLDivElement>) => {
      if (seeking.current) seekTo(event.clientX, event.shiftKey);
    },
    end: () => {
      seeking.current = false;
      setScrubbing(false);
      resetSnap();
    },
    key: (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 1 : 1 / fps;
      const next = event.key === 'ArrowLeft' ? time - step : event.key === 'ArrowRight' ? time + step : event.key === 'Home' ? 0 : event.key === 'End' ? total : null;
      if (next === null) return;
      event.preventDefault();
      onSeek(clamp(next, 0, total));
    },
  };

  const endMove = () => {
    moveGesture.current = null;
    setMovePreview(null);
    setGhost(null);
    resetSnap();
  };

  const gestures: ClipGestures = {
    pointerDown: (event, shot) => {
      skipClick.current = false;
      if (event.button !== 0 || disabled || bladeActive || shot.locked) return;
      const span = spanOf(shot.id);
      if (!span) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      snapState.current = { currentProbeOffset: 0 };
      moveGesture.current = {
        id: shot.id,
        item: shot.clip?.audioOnly ? 'audio' : 'visual',
        x: event.clientX,
        y: event.clientY,
        start: span.start,
        track: span.track,
        duration: shot.duration,
        moved: false,
        preview: null,
      };
    },
    pointerMove: event => {
      const gesture = moveGesture.current;
      if (!gesture) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.abs(dx) + Math.abs(dy) <= 3) return;
      gesture.moved = true;
      const target = resolveTarget(laneTarget(lanes, pointerY(event.clientY), gesture.item, false));
      const start = snapTime(gesture.start + dx / scale, { exclude: gesture.id, playhead: true, bypass: event.shiftKey, length: gesture.duration });
      gesture.preview = { id: gesture.id, start: Math.max(0, start), track: target.track, laneKey: target.laneKey };
      setGhost(target.ghost);
      setMovePreview(gesture.preview);
    },
    pointerUp: () => {
      const gesture = moveGesture.current;
      const preview = gesture?.moved ? gesture.preview : null;
      endMove();
      if (!gesture || !preview) return;
      skipClick.current = true;
      if (preview.start !== gesture.start || preview.track !== gesture.track) {
        void apply(zh ? '移动片段' : 'Move clip', [{ op: 'move-clip', shotId: gesture.id, at: preview.start, track: preview.track }]);
      }
    },
    pointerCancel: endMove,
    click: (event, shot, lane) => {
      if (skipClick.current) {
        skipClick.current = false;
        return;
      }
      select(shot.id, lane);
      // Keyboard activation (Enter/Space) has no pointer position: select only, keep the playhead, no blade split.
      if (event.detail === 0) return;
      const at = snapEditTime(Math.min(total, timeAt(event.clientX)), edges, scale, snap && !bladeActive && !event.shiftKey, fps);
      onSeek(at);
      const span = spanOf(shot.id);
      if (!bladeActive || disabled || shot.locked || !span) return;
      if (at > span.start + 1 / fps && at < span.end - 1 / fps) {
        void apply(zh ? '分割片段' : 'Split clip', movieCutOperations(d, shot, at - span.start, 'split', { magnet }));
      }
    },
    doubleClick: () => onOpenInspector?.(),
    trimDown: (event, shot, edge) => {
      event.stopPropagation();
      event.preventDefault();
      const span = spanOf(shot.id);
      if (!span) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      snapState.current = { currentProbeOffset: 0 };
      const { min, max } = trimBounds(shot, sourceOf(shot));
      trimGesture.current = { id: shot.id, edge, x: event.clientX, base: span.start, duration: shot.duration, start: 0, end: shot.duration, min, max };
      setTrim({ ...trimGesture.current });
    },
    trimMove: event => {
      const gesture = trimGesture.current;
      if (!gesture) return;
      const edgeTime = gesture.base + (gesture.edge === 'end' ? gesture.duration : 0);
      const delta = snapTime(edgeTime + (event.clientX - gesture.x) / scale, { exclude: gesture.id, playhead: true, bypass: event.shiftKey }) - edgeTime;
      if (gesture.edge === 'start') gesture.start = clamp(delta, gesture.min, gesture.duration - 1 / fps);
      else gesture.end = clamp(gesture.duration + delta, 1 / fps, gesture.max);
      setTrim({ ...gesture });
    },
    trimUp: () => {
      const gesture = trimGesture.current;
      trimGesture.current = null;
      setTrim(null);
      resetSnap();
      if (gesture && (gesture.start !== 0 || gesture.end !== gesture.duration)) {
        void apply(zh ? '裁剪片段' : 'Trim clip', [{ op: 'trim-clip', shotId: gesture.id, start: gesture.start, end: gesture.end }]);
      }
    },
    trimCancel: () => {
      trimGesture.current = null;
      setTrim(null);
      resetSnap();
    },
    seek: onSeek,
  };

  /*
   * Esc cancels a trim or move in progress: the gesture is dropped, its release commits nothing, and the selection
   * stays. The listener runs in the window capture phase and stops the event, so MovieStudio's Esc (deselect, which
   * would also unmount COMPACT's trim handles) never sees it, wherever focus is.
   */
  const cancelGesture = useLatest((event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Escape' || !(trimGesture.current || moveGesture.current?.moved)) return;
    event.preventDefault();
    event.stopPropagation();
    if (moveGesture.current) skipClick.current = true; // the release still clicks the clip: no select, seek or split
    trimGesture.current = null;
    setTrim(null);
    endMove();
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => cancelGesture.current(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [cancelGesture]);

  /* ---- Lane background: deselect and seek, drop media, context menu ---- */
  const clickLanes = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-shot-id], [data-caption], [data-junction]')) return;
    onSelect(null);
    onSeek(snapEditTime(Math.min(total, timeAt(event.clientX)), edges, scale, snap && !event.shiftKey, fps));
  };

  const acceptsSource = (event: ReactDragEvent<HTMLDivElement>) => {
    const types = event.dataTransfer?.types;
    return !disabled && (!types || Array.from(types).includes(SOURCE_MIME));
  };
  const clearDrop = () => {
    setDropTarget(null);
    setGhost(null);
  };
  const dragOverLanes = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!acceptsSource(event)) return;
    event.preventDefault();
    const target = resolveTarget(laneTarget(lanes, pointerY(event.clientY), dragItem.current ?? 'visual', true));
    if (event.dataTransfer) event.dataTransfer.dropEffect = target.rejected ? 'none' : 'copy';
    setGhost(target.ghost);
    setDropTarget(current => (current?.key === target.laneKey && current.rejected === target.rejected ? current : { key: target.laneKey, rejected: target.rejected }));
  };
  const dragLeaveLanes = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrop();
  };
  const dropOnLanes = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    clearDrop();
    if (disabled) return;
    const source = sourceById.get(event.dataTransfer.getData(SOURCE_MIME));
    if (!source) return;
    const target = resolveTarget(laneTarget(lanes, pointerY(event.clientY), source.kind === 'audio' ? 'audio' : 'visual', true));
    if (target.rejected) return;
    const start = Math.max(0, snapTime(timeAt(event.clientX), { bypass: event.shiftKey }));
    resetSnap();
    const before = spans.findIndex(span => start < span.start + span.shot.duration / 2);
    onAddSource(source, before < 0 ? d.shots.length : before, { start, track: target.track });
  };

  const openMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (target.closest('[data-caption], [data-junction]')) {
      event.preventDefault();
      return;
    }
    const id = target.closest<HTMLElement>('[data-shot-id]')?.dataset.shotId;
    if (id) {
      const lane = target.closest<HTMLElement>('[data-lane]')?.dataset.lane === 'audio' ? 'audio' : 'video';
      select(id, lane);
      setMenu({ type: 'clip', id, lane });
      return;
    }
    const y = pointerY(event.clientY);
    const lane = lanes.find(item => y >= item.top && y < item.top + item.height);
    const track = lane && (lane.kind === 'video' || lane.kind === 'text') && !lane.role ? lane.track : movieTextTrack(d);
    setMenu({ type: 'lane', time: Math.min(MOVIE_MAX_DURATION - MOVIE_TEXT_DURATION, timeAt(event.clientX)), track });
  };
  const menuShot = menu?.type === 'clip' ? d.shots.find(shot => shot.id === menu.id) : undefined;

  /* ---- Keyboard: view keys only (MovieStudio owns the editing keys) ---- */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || (event.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    if (key === '=' || key === '+') zoomTo(scale * TIMELINE_ZOOM.step);
    else if (key === '-' || key === '_') zoomTo(scale / TIMELINE_ZOOM.step);
    else if (!mod && (key === '\\' || (event.shiftKey && key.toLowerCase() === 'z'))) fit();
    else if (!mod && !event.shiftKey && full && key.toLowerCase() === 'b') setBlade(value => !value);
    else return;
    event.preventDefault();
  };

  /* ---- Overview strip ---- */
  const overviewVisible = total > 0 && xOf(total) > view.width;
  const overview = {
    down: (event: PointerEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      const strip = event.currentTarget.getBoundingClientRect();
      if (!el || strip.width <= 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const ratio = canvasWidth / strip.width;
      const width = el.clientWidth - geometry.header;
      const target = event.target as Element;
      if (!target.closest('[data-overview-window]')) el.scrollLeft = (event.clientX - strip.left) * ratio - width / 2;
      const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge;
      overviewDrag.current = {
        x: event.clientX,
        scrollLeft: el.scrollLeft,
        ratio,
        edge: edge === 'start' || edge === 'end' ? edge : null,
        from: Math.max(0, (el.scrollLeft - TIMELINE_ORIGIN) / scale),
        to: (el.scrollLeft + width - TIMELINE_ORIGIN) / scale,
        view: width,
        scale,
      };
    },
    move: (event: PointerEvent<HTMLDivElement>) => {
      const drag = overviewDrag.current;
      const el = scrollRef.current;
      if (!drag || !el) return;
      const dx = (event.clientX - drag.x) * drag.ratio;
      if (!drag.edge) {
        el.scrollLeft = drag.scrollLeft + dx;
        return;
      }
      const seconds = dx / drag.scale;
      if (drag.edge === 'end') {
        const to = Math.max(drag.from + 0.1, drag.to + seconds);
        zoomTo(drag.view / (to - drag.from), { time: drag.from, offset: TIMELINE_ORIGIN });
      } else {
        const from = clamp(drag.from + seconds, 0, drag.to - 0.1);
        zoomTo(drag.view / (drag.to - from), { time: drag.to, offset: drag.view });
      }
    },
    end: () => {
      overviewDrag.current = null;
    },
  };
  const overviewRows = lanes.filter(lane => lane.role !== 'ghost');
  const overviewBars: OverviewBar[] = overviewVisible
    ? spans.flatMap(span => {
        const row = overviewRows.findIndex(lane => lane.key === `${span.shot.clip?.audioOnly ? 'a' : 'v'}${span.track}`);
        const kind = overviewRows[row]?.kind ?? 'video';
        const bars: OverviewBar[] = row < 0 ? [] : [{ key: span.shot.id, row, kind, x: xOf(span.start), width: span.shot.duration * scale }];
        for (const [index, caption] of (span.shot.captions ?? []).entries()) {
          bars.push({ key: `${span.shot.id}:c${index}`, row: 0, kind: 'caption', x: xOf(span.start + caption.start), width: (caption.end - caption.start) * scale });
        }
        return bars;
      })
    : [];

  /* ---- Toolbar ---- */
  const fromCommand = (cmd: Command) => ({ disabled: cmd.disabled, reason: cmd.reason, onClick: cmd.run });
  const history: TimelineTool[] = [
    ...(onUndo ? [{ id: 'undo', icon: Undo2, label: zh ? '撤销' : 'Undo edit', shortcut: 'mod+z', disabled: !undoEnabled, onClick: onUndo }] : []),
    ...(onRedo ? [{ id: 'redo', icon: Redo2, label: zh ? '重做' : 'Redo edit', shortcut: 'mod+shift+z', disabled: !redoEnabled, onClick: onRedo }] : []),
  ];
  const cuts: TimelineTool[] = [
    { id: 'split', icon: Scissors, label: zh ? '在播放头分割' : 'Split at playhead', shortcut: 'mod+b', ...fromCommand(toolbarCommands.split) },
    { id: 'trim-before', icon: ArrowLeftToLine, label: zh ? '向左裁剪' : 'Trim left', hint: zh ? '向左裁剪：删掉播放头之前的部分' : 'Trim left: remove the part before the playhead', shortcut: 'q', ...fromCommand(toolbarCommands.trimBefore) },
    { id: 'trim-after', icon: ArrowRightToLine, label: zh ? '向右裁剪' : 'Trim right', hint: zh ? '向右裁剪：删掉播放头之后的部分' : 'Trim right: remove the part after the playhead', shortcut: 'w', ...fromCommand(toolbarCommands.trimAfter) },
    { id: 'delete', icon: Trash2, label: zh ? '删除片段' : 'Delete clip', shortcut: 'backspace', ...fromCommand(toolbarCommands.remove) },
  ];
  const fullTools: TimelineTool[][] = [
    history,
    [...cuts, { id: 'ripple', icon: FoldHorizontal, label: zh ? '删除并合拢' : 'Ripple delete', hint: zh ? '删除并合拢本轨空隙' : 'Delete and close the gap on this track', shortcut: 'shift+backspace', ...fromCommand(toolbarCommands.ripple) }],
    [
      { id: 'duplicate', icon: Copy, label: zh ? '复制片段' : 'Duplicate clip', hint: zh ? '复制到原片段之后' : 'Duplicate right after the clip', shortcut: 'mod+d', ...fromCommand(toolbarCommands.duplicate) },
      { id: 'detach', icon: Unlink, label: zh ? '分离音频' : 'Detach audio', ...fromCommand(toolbarCommands.detach) },
    ],
    [
      { id: 'lock', icon: selected?.locked ? Lock : LockOpen, label: zh ? '锁定片段' : 'Lock clip', shortcut: 'mod+l', pressed: Boolean(selected?.locked), ...fromCommand(toolbarCommands.lock) },
      { id: 'mute', icon: selected?.clip?.muted ? VolumeX : Volume2, label: zh ? '静音片段' : 'Mute clip', shortcut: 'm', pressed: Boolean(selected?.clip?.muted), ...fromCommand(toolbarCommands.mute) },
    ],
    [{ id: 'blade', icon: Slice, label: zh ? '刀片工具' : 'Blade tool', hint: zh ? '分割工具：点击片段即在该处分割' : 'Blade: click a clip to split it there', shortcut: 'b', pressed: blade, onClick: () => setBlade(value => !value) }],
  ];
  const leading = (full ? fullTools : [history, cuts]).filter(group => group.length > 0);
  const modes = [
    { key: 'magnet', icon: Magnet, label: zh ? '主轨磁吸' : 'Main track magnet', text: zh ? '主轨磁吸' : 'Magnet', hint: zh ? '主轨磁吸：主轨上删除或裁剪后自动合拢空隙' : 'Main track magnet: cuts on the main track close their gap', pressed: magnet, onToggle: () => setMagnet(!magnet) },
    { key: 'snap', icon: SeparatorVertical, label: zh ? '吸附' : 'Snapping', text: zh ? '吸附' : 'Snap', hint: zh ? '自动吸附到片段边缘和播放头（按住 Shift 暂不吸附）' : 'Snap to clip edges and the playhead (hold Shift to bypass)', shortcut: 'n', pressed: snap, onToggle: () => setSnap(!snap) },
    { key: 'skim', icon: ScanLine, label: zh ? '预览轴' : 'Skimming', text: zh ? '预览轴' : 'Skim', hint: zh ? '预览轴：暂停时悬停即可预览画面' : 'Skimming: hover the paused timeline to preview frames', shortcut: 's', pressed: skim, hideBelow: full ? undefined : (440 as const), onToggle: () => setSkim(!skim) },
  ];

  /* ---- Clips ---- */
  const viewFrom = Math.max(0, view.left - Math.max(view.width, 480));
  const viewTo = view.left + 2 * Math.max(view.width, 480) + VIEW_BUCKET;

  const clipModel = (span: ClipSpan): ClipModel | null => {
    const { shot } = span;
    const clip = shot.clip;
    const source = sourceOf(shot);
    const audioOnly = Boolean(clip?.audioOnly);
    const kind: ClipKind = audioOnly ? 'audio' : shot.kind === 'text' ? 'text' : 'video';
    const trimming = trim?.id === shot.id ? trim : null;
    const from = trimming?.start ?? 0;
    const length = (trimming?.end ?? shot.duration) - from;
    const moving = movePreview?.id === shot.id ? movePreview : null;
    const lane = (moving && laneByKey.get(moving.laneKey)) ?? laneByKey.get(`${audioOnly ? 'a' : 'v'}${span.track}`);
    if (!lane) return null;
    const width = Math.max(2, length * scale - 1);
    const box = { top: lane.top + geometry.inset, left: xOf((moving?.start ?? span.start) + from) + 0.5, width, height: lane.height - 2 * geometry.inset };
    const stripHeight = audioOnly ? geometry.audioStrip : kind === 'video' ? geometry.strip : 0;
    const strip = stripHeight && box.height >= stripHeight + 16 ? stripHeight : 0;
    const missing = Boolean(clip && sources.length > 0 && !source);
    const isSelected = shot.id === selectedId && (audioOnly || selectedLane === 'video');
    const badges: ClipBadge[] = [];
    if (clip && clip.rate !== 1) badges.push({ key: 'rate', text: `${Number(clip.rate.toFixed(2))}×`, label: zh ? `${Number(clip.rate.toFixed(2))} 倍速` : `${Number(clip.rate.toFixed(2))}× speed` });
    if (clip && !audioOnly && movieFilterPresetFor(movieClipColor(clip))?.id !== 'original') badges.push({ key: 'color', ...(zh ? { text: '调' } : { icon: SlidersHorizontal }), label: zh ? '已调色' : 'Color adjusted' });
    if (clip?.keyframes?.length) badges.push({ key: 'keys', icon: Diamond, label: zh ? '有关键帧' : 'Keyframes' });
    if (clip?.muted) badges.push({ key: 'muted', icon: VolumeX, label: zh ? '已静音' : 'Muted' });
    if (shot.locked) badges.push({ key: 'locked', icon: Lock, label: zh ? '已锁定' : 'Locked' });
    if (missing) badges.push({ key: 'missing', icon: TriangleAlert, text: zh ? '素材缺失' : 'Missing media', danger: true, label: zh ? '素材缺失' : 'Missing media' });
    const states = badges.filter(badge => badge.key !== 'rate').map(badge => ` · ${badge.label}`).join('');
    const label = audioOnly
      ? `${zh ? '音频' : 'Audio'} ${shot.title}${states}`
      : `${span.index + 1}. ${shot.title} · ${shot.duration.toFixed(2)}s${states}`;
    /** Every picture clip with sound keeps its audio row, so the frame/sound seam stays level along a track. */
    const linked = hasLinkedAudio(shot, source) && box.height >= strip + geometry.band + 8;
    /** Clips too narrow to aim at keep the row but neither draw nor take a click in it. */
    const bandHit = linked && width >= MIN_BAND_WIDTH;
    // The 波形 display is a FULL toolbar choice; the project pane always shows frames over the audio row.
    const expanded = full && clipDisplay === 'waveform';
    /** Frames and waveform rows live inside the 1 px body border, so they are drawn to its inner width. */
    const inner = Math.max(0, width - 2);
    const content = Math.max(0, box.height - strip - 2);
    const filmHeight = Math.max(0, content - (linked ? geometry.band : 0));
    /** The clip's sound over the visible part of a row `height` px tall, sampled on the ruler's own clock. */
    const waveDraw = (height: number, baseline: boolean): WaveDraw | undefined => {
      if (!clip || !source?.audioPeaks?.length) return undefined;
      const x0 = clamp(Math.floor(viewFrom - box.left - 1), 0, inner);
      const x1 = clamp(Math.ceil(viewTo - box.left - 1), x0, inner);
      const rowHeight = Math.max(1, Math.round(height));
      if (x1 <= x0) return undefined;
      const pps = scale / clip.rate;
      const start = clip.in + (from + (x0 + CLIP_CONTENT_X) / scale) * clip.rate;
      const d = cachedWaveform(source, start, (x1 - x0) / pps, clip.volume, x1 - x0, rowHeight, baseline, pps);
      return d ? { d, left: x0, width: x1 - x0, height: rowHeight } : undefined;
    };
    const fadeWidth = (seconds: number | undefined) => Math.min(seconds ?? 0, length / 2) * scale;
    const keys = isSelected && !moving && !trimming ? clip?.keyframes ?? [] : [];
    return {
      shot,
      kind,
      box,
      label,
      selected: isSelected,
      moving: moving !== null,
      changed: highlight.has(shot.id),
      missing,
      trimmable: !disabled && !shot.locked && Boolean(clip || shot.kind === 'text') && width >= MIN_TRIM_WIDTH && (full || shot.id === selectedId),
      trimLabel: edge => (zh ? `裁剪${edge === 'start' ? '开头' : '结尾'} ${shot.title}` : `Trim ${edge} ${shot.title}`),
      detail: width > LABEL_WIDTH ? 'full' : width >= BADGE_WIDTH ? 'badges' : 'none',
      strip,
      badges,
      duration: formatClipDuration(length),
      film: kind === 'video' && !(linked && expanded) ? (
        <Filmstrip
          shot={shot}
          source={source}
          from={from}
          width={inner}
          height={filmHeight}
          scale={scale}
          visible={[viewFrom - box.left - 1, viewTo - box.left - 1]}
          url={raw}
        />
      ) : undefined,
      wave: audioOnly ? waveDraw(content - 4, false) : undefined,
      band: linked
        ? {
            label: `${zh ? '原声' : 'Audio'} ${shot.title}`,
            // Collapsed: inside the 1 px top edge with 2 px headroom. Expanded: the content under the strip's edge.
            // A narrow clip's collapsed row stays blank; expanded, it is the clip's only picture of its sound.
            wave: bandHit || expanded ? waveDraw(expanded ? content - (strip ? 1 : 0) : geometry.band - 3, !expanded) : undefined,
            height: geometry.band,
            expanded,
            selected: bandSelected && shot.id === selectedId,
            inert: !bandHit,
            fades: { start: fadeWidth(clip?.audioFadeIn ?? clip?.fadeIn), end: fadeWidth(clip?.audioFadeOut ?? clip?.fadeOut), ramp: true },
          }
        : undefined,
      fades: audioOnly
        ? { start: fadeWidth(clip?.audioFadeIn), end: fadeWidth(clip?.audioFadeOut), ramp: true }
        : { start: fadeWidth(clip?.fadeIn), end: fadeWidth(clip?.fadeOut), ramp: false },
      keyframes: keys.map((key, index) => {
        const at = span.start + key.at * shot.duration;
        return { key: `${index}:${key.at}`, x: key.at * width, time: at, current: Math.abs(at - time) <= 0.5 / fps };
      }),
    };
  };
  const clipModels = spans.map(clipModel).filter((model): model is ClipModel => model !== null);
  const modelById = new Map(clipModels.map(model => [model.shot.id, model]));
  /** Vertical centre of a clip's picture: between its name strip and a collapsed audio row. */
  const pictureCentre = (model: ClipModel) => {
    const row = model.band && !model.band.expanded ? model.band.height : 0;
    return model.box.top + 1 + model.strip + (model.box.height - 2 - model.strip - row) / 2;
  };

  const captionChips = spans.flatMap(span => {
    const start = movePreview?.id === span.shot.id ? movePreview.start : span.start;
    return (span.shot.captions ?? []).map((caption, index) => (
      <button
        key={`${span.shot.id}:${caption.id ?? index}`}
        type="button"
        className={styles.caption}
        data-caption
        title={caption.text}
        style={{
          top: geometry.inset,
          height: geometry.caption - geometry.inset * 2,
          left: xOf(start + caption.start) + 0.5,
          width: Math.max(2, (caption.end - caption.start) * scale - 1),
        }}
        onClick={() => {
          select(span.shot.id, 'video');
          onSeek(span.start + caption.start);
          onRequestInspector?.({ tab: 'captions', ...(caption.id ? { cueId: caption.id } : {}) });
        }}
      >
        {caption.text}
      </button>
    ));
  });

  const junctionBadges = junctions.flatMap(({ span, transition }) => {
    const lane = laneByKey.get(`v${span.track}`);
    const busy = movePreview || trim;
    if (!lane || busy || (!transition && (!full || disabled || span.shot.locked))) return [];
    const model = modelById.get(span.shot.id);
    const glyph = transition === 'wipe' ? ArrowRightLeft : transition === 'iris' ? Aperture : transition ? Blend : Plus;
    return [
      <button
        key={span.shot.id}
        type="button"
        className={styles.junction}
        data-junction
        data-add={transition ? undefined : true}
        style={{ left: xOf(span.end), top: model ? pictureCentre(model) : lane.top + lane.height / 2 }}
        aria-label={transition
          ? (zh ? `转场 ${span.shot.title}` : `Transition after ${span.shot.title}`)
          : (zh ? `添加转场 ${span.shot.title}` : `Add transition after ${span.shot.title}`)}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => {
          select(span.shot.id, 'video');
          onRequestInspector?.({ tab: 'video', section: 'transition' });
        }}
      >
        <Icon icon={glyph} size={12} />
      </button>,
    ];
  });

  /** While trimming or moving, an ink bubble over the edited edge shows how far it has moved. */
  const gestureDelta = (() => {
    const id = movePreview?.id ?? trim?.id;
    const span = id ? spanOf(id) : undefined;
    const lane = movePreview ? laneByKey.get(movePreview.laneKey) : span && laneByKey.get(`${span.shot.clip?.audioOnly ? 'a' : 'v'}${span.track}`);
    if (!span || !lane) return null;
    const top = lane.top + geometry.inset;
    if (movePreview) return { left: xOf(movePreview.start), top, delta: movePreview.start - span.start };
    if (!trim) return null;
    const start = trim.edge === 'start';
    return { left: xOf(trim.base + (start ? trim.start : trim.end)), top, delta: start ? trim.start : trim.end - trim.duration };
  })();

  const changedRanges = spans.filter(span => highlight.has(span.shot.id)).map(span => ({ key: span.shot.id, start: span.start, end: span.end }));
  const mainLane = laneByKey.get(`v${MOVIE_MAIN_TRACK}`);
  const laneLabel = (lane: TimelineLane) => {
    if (dropTarget?.key === lane.key && dropTarget.rejected) return zh ? '音频轨道只放音频' : 'Audio tracks take sound only';
    if (lane.role === 'ghost') return lane.name;
    if (lane.role === 'drop') return zh ? '拖入音乐或音效' : 'Drop music or sound effects';
    return null;
  };

  const rootStyle = {
    '--track-header-width': `${geometry.header}px`,
    '--timeline-origin': `${TIMELINE_ORIGIN}px`,
    '--lane-inset': `${geometry.inset}px`,
  } as CSSProperties;

  return (
    <section
      className={styles.timeline}
      data-testid="movie-track-timeline"
      data-variant={variant}
      aria-label={zh ? '时间线' : 'Timeline'}
      tabIndex={-1}
      style={rootStyle}
      onKeyDown={onKeyDown}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={zh ? '时间线工具' : 'Timeline tools'}>
        <ToolGroups groups={leading} size={toolSize} />
        <span className={styles.spacer} />
        {full ? (
          <>
            <SegmentedIcons size="md" value={clipDisplay} aria-label={zh ? '片段显示' : 'Clip display'} onValueChange={value => setClipDisplay(value === 'waveform' ? 'waveform' : 'frames')}>
              <Tooltip label={zh ? '显示画面' : 'Show frames'} side="bottom">
                <SegmentedIconItem value="frames" aria-label={zh ? '画面' : 'Frames'}>
                  <Icon icon={Film} size="sm" />
                </SegmentedIconItem>
              </Tooltip>
              <Tooltip label={zh ? '显示波形，便于找到停顿' : 'Show waveforms to find pauses'} side="bottom">
                <SegmentedIconItem value="waveform" aria-label={zh ? '波形' : 'Waveform'}>
                  <Icon icon={AudioWaveform} size="sm" />
                </SegmentedIconItem>
              </Tooltip>
            </SegmentedIcons>
            <span className={styles.divider} />
          </>
        ) : null}
        <div className={styles.toolGroup}>
          {modes.map(({ key, ...mode }) => <ModeToggle key={key} size={toolSize} {...mode} />)}
        </div>
        <span className={styles.divider} />
        <ToolButton
          tool={{ id: 'fit', icon: MoveHorizontal, label: zh ? '适应时间线' : 'Fit timeline', shortcut: '\\', onClick: fit }}
          size={toolSize}
        />
        <ZoomControl scale={scale} size={toolSize} zh={zh} compact={!full} onZoom={zoomTo} />
      </div>
      {overviewVisible ? (
        <TimelineOverview
          bars={overviewBars}
          rows={overviewRows.length}
          height={geometry.overview}
          canvasWidth={canvasWidth}
          playheadX={xOf(Math.min(time, total))}
          windowRef={overviewWindowRef}
          onPointerDown={overview.down}
          onPointerMove={overview.move}
          onPointerEnd={overview.end}
        />
      ) : null}
      <div
        className={styles.scroll}
        ref={scrollRef}
        onScroll={() => {
          measureView();
          placeOverview();
        }}
        onPointerMove={skimMove}
        onPointerLeave={skimLeave}
      >
        <div className={styles.sheet} style={{ width: geometry.header + canvasWidth }}>
          <div className={styles.headers}>
            <div className={styles.corner} />
            {lanes.map(lane => (
              <TrackHeader key={lane.key} lane={lane} full={full} zh={zh} state={laneState(lane)} />
            ))}
          </div>
          <div className={styles.canvas} ref={canvasRef} style={{ width: canvasWidth }}>
            <TimelineRuler
              scale={scale}
              time={time}
              total={total}
              fps={fps}
              from={viewFrom}
              to={viewTo}
              label={zh ? '播放位置' : 'Playhead position'}
              marks={{ hover: hoverTime, snap: snapAt, changed: changedRanges }}
              scrubbing={scrubbing}
              onPointerDown={ruler.down}
              onPointerMove={ruler.move}
              onPointerEnd={ruler.end}
              onKeyDown={ruler.key}
            />
            <ContextMenu onOpenChange={open => { if (!open) setMenu(null); }}>
              <ContextMenuTrigger asChild disabled={disabled} onContextMenu={openMenu}>
                <div
                  className={styles.lanes}
                  ref={lanesRef}
                  data-testid="movie-timeline-lanes"
                  data-blade={bladeActive}
                  style={{ minHeight: lanesHeight }}
                  onClick={clickLanes}
                  onDragOver={dragOverLanes}
                  onDragLeave={dragLeaveLanes}
                  onDrop={dropOnLanes}
                >
                  {lanes.map(lane => {
                    const text = laneLabel(lane);
                    return (
                      <div
                        key={lane.key}
                        className={styles.lane}
                        data-kind={lane.kind}
                        data-main={(lane.kind === 'video' && lane.track === MOVIE_MAIN_TRACK && !lane.role) || undefined}
                        data-role={lane.role}
                        data-drop={dropTarget?.key === lane.key ? (dropTarget.rejected ? 'reject' : 'accept') : undefined}
                        style={{ top: lane.top, height: lane.height }}
                      >
                        {text ? (
                          <span className={styles.laneLabel}>
                            {lane.role === 'drop' && !(dropTarget?.key === lane.key && dropTarget.rejected) ? <Icon icon={Music} size="sm" /> : null}
                            {text}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {!d.shots.length && mainLane ? (
                    <div className={styles.emptyDrop} style={{ top: mainLane.top + geometry.inset, height: mainLane.height - 2 * geometry.inset }}>
                      <Icon icon={Film} size="sm" />
                      {zh ? '把素材拖到这里' : 'Drop media here'}
                    </div>
                  ) : null}
                  {captionChips}
                  {clipModels.map(model => <TimelineClip key={model.shot.id} model={model} gestures={gestures} zh={zh} />)}
                  {junctionBadges}
                  <div className={styles.playheadLine} style={{ left: xOf(Math.min(time, total)) }} />
                  {hoverTime === null ? null : <div className={styles.hoverGuide} style={{ left: xOf(hoverTime) }} />}
                  {snapAt === null ? null : <div className={styles.snapGuide} style={{ left: xOf(snapAt) }} />}
                  {gestureDelta && Math.abs(gestureDelta.delta) >= 0.5 / fps ? (
                    <div className={styles.gestureBubble} style={{ left: gestureDelta.left, top: gestureDelta.top }}>
                      {formatDelta(gestureDelta.delta, fps)}
                    </div>
                  ) : null}
                </div>
              </ContextMenuTrigger>
              {menu?.type === 'clip' && menuShot ? (
                <ClipMenu
                  zh={zh}
                  shot={menuShot}
                  commands={clipCommands(menuShot, menu.lane, menu.lane === 'audio' && !menuShot.clip?.audioOnly ? undefined : menuShot)}
                />
              ) : null}
              {menu?.type === 'lane' ? (
                <ContextMenuContent>
                  <MenuItem command={command(null, () => insertText(menu.time, menu.track))} icon={Type} text={zh ? '在此添加文字' : 'Add text here'} />
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
          </div>
        </div>
      </div>
    </section>
  );
}
