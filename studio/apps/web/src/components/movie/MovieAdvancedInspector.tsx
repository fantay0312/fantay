// Clip controls shared by both inspector layouts (the tabbed panel and the compact pane's fold-away stack).
// Every control commits through the same atomic edit and undo path as AI edits: one intention, one batch.
// A pose field the clip already animates is keyed at the playhead instead of set statically (auto-key).
import { createContext, useContext, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Diamond, Eraser, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  MOVIE_CLIP_ANIMATED_FIELDS,
  movieClipPose,
  movieDuration,
  movieFps,
  movieShotStarts,
  type MovieClipPose,
  type MovieDocument,
  type MovieEditOperation,
  type MovieShot,
  type MovieVisual,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { Button, Disclosure, Icon, IconButton, Input, Segmented, SegmentedItem, Switch } from '../../fantay/ui';
import {
  MOVIE_CLIP_ANIMATIONS,
  MOVIE_FILTER_PRESETS,
  MOVIE_ORIGINAL_COLOR,
  MOVIE_TRANSITIONS,
  MOVIE_TRANSITION_SECONDS,
  isMovieVisualClip,
  movieClipAnimationFor,
  movieClipAnimationOperations,
  movieClipColor,
  movieColorFilter,
  movieFilterPresetFor,
  movieShotVisual,
  movieTransitionReady,
  type MovieClipColor,
  type MovieFilterPreset,
  type MovieTransitionKind,
} from './movie-editor-presets';
import styles from './MovieCompactInspector.module.css';

type MovieClip = NonNullable<MovieShot['clip']>;
type MovieClipCrop = NonNullable<MovieClip['crop']>;
type MovieClipKeyframe = NonNullable<MovieClip['keyframes']>[number];
/** A pose field keyframes can animate. */
export type MoviePoseField = (typeof MOVIE_CLIP_ANIMATED_FIELDS)[number];
type PoseValues = Partial<Record<MoviePoseField, number>>;

export type MovieApplyEdit = (label: string, operations: MovieEditOperation[]) => Promise<boolean>;

/** What every clip section needs: the film, the clip's shot, the shared edit path and the playhead. */
export interface ClipSectionProps {
  document: MovieDocument;
  shot: MovieShot;
  disabled: boolean;
  zh: boolean;
  onApply: MovieApplyEdit;
  /** Playhead in output seconds: where auto-keys and keyframe toggles land. */
  time: number;
  /** The clip's output start. */
  start: number;
  onSeek?(time: number): void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function stepDecimals(step: number): number {
  const dot = String(step).indexOf('.');
  return dot < 0 ? 0 : Math.min(3, String(step).length - dot - 1);
}

const formatValue = (value: number, step: number) => String(Number(value.toFixed(stepDecimals(step))));

function updateClip(onApply: MovieApplyEdit, shot: MovieShot, label: string, changes: Partial<MovieClip>): Promise<boolean> {
  return onApply(label, [{ op: 'update-clip', shotId: shot.id, changes }]);
}

/**
 * Clip changes with the clip's own audio fades carried along. The edit API drops an audio fade when the picture
 * fade it pairs with changes without it (the sound follows the picture again), so a picture-fade edit sends the
 * audio fade the clip has set (`clip` holds the values to keep).
 */
export function movieKeepAudioFades(clip: MovieClip, changes: Partial<MovieClip>): Partial<MovieClip> {
  const next = { ...changes };
  if ('fadeIn' in next && !('audioFadeIn' in next) && clip.audioFadeIn !== undefined) next.audioFadeIn = clip.audioFadeIn;
  if ('fadeOut' in next && !('audioFadeOut' in next) && clip.audioFadeOut !== undefined) next.audioFadeOut = clip.audioFadeOut;
  return next;
}

const IMAGE_PATH = /\.(png|jpe?g|webp|gif|svg)$/i;

/** Still images have no sound and no speed. */
export function movieShotIsImage(d: MovieDocument, shot: MovieShot): boolean {
  const clip = shot.clip;
  if (!clip) return false;
  return IMAGE_PATH.test(shot.media ?? d.style.assets?.find(asset => asset.id === clip.assetId)?.path ?? '');
}

/* ------------------------------------------------------------------------------------------------
 * Keyframes at the playhead
 * ---------------------------------------------------------------------------------------------- */

/** The document model's limit on keys per clip. */
const MAX_KEYFRAMES = 64;

/** The playhead on a clip's keyframe axis (0..1 of its duration); keys within half a frame count as "at" it. */
export interface ClipPlayhead {
  at: number;
  tolerance: number;
  /** Whether the playhead is over the clip at all. */
  inside: boolean;
}

export function clipPlayhead(d: MovieDocument, shot: MovieShot, time: number, start: number): ClipPlayhead {
  const duration = Math.max(shot.duration, 1e-6);
  return {
    at: Math.round(clamp((time - start) / duration, 0, 1) * 1e6) / 1e6,
    tolerance: 0.5 / movieFps(d) / duration,
    inside: time >= start - 1e-6 && time <= start + shot.duration + 1e-6,
  };
}

const carries = (key: MovieClipKeyframe, fields: readonly MoviePoseField[]) => fields.some(field => key[field] !== undefined);
const keyIndexAt = (keys: readonly MovieClipKeyframe[], playhead: ClipPlayhead) => keys.findIndex(key => Math.abs(key.at - playhead.at) <= playhead.tolerance);
const pick = (pose: MovieClipPose, fields: readonly MoviePoseField[]): PoseValues => Object.fromEntries(fields.map(field => [field, pose[field]]));

/** Whether some key of the clip carries `field`. */
export function movieClipAnimates(clip: MovieClip, field: MoviePoseField): boolean {
  return Boolean(clip.keyframes?.some(key => key[field] !== undefined));
}

/** `values` written into the key under the playhead, or into a new key there. */
function keyedAt(keys: readonly MovieClipKeyframe[], playhead: ClipPlayhead, values: PoseValues): MovieClipKeyframe[] {
  const index = keyIndexAt(keys, playhead);
  if (index >= 0) return keys.map((key, i) => (i === index ? { ...key, ...values } : key));
  return [...keys, { at: playhead.at, ...values }].sort((a, b) => a.at - b.at);
}

/**
 * The key at `index` without `fields`. A key left empty is dropped, and a field that loses its last key
 * rests at the value it showed there, so the picture does not jump.
 */
function withoutFields(clip: MovieClip, index: number, fields: readonly MoviePoseField[]): Partial<MovieClip> {
  const keys = clip.keyframes ?? [];
  const pose = movieClipPose(clip, keys[index]!.at);
  const key = { ...keys[index]! };
  for (const field of fields) delete key[field];
  const keyframes = carries(key, MOVIE_CLIP_ANIMATED_FIELDS) ? keys.map((k, i) => (i === index ? key : k)) : keys.filter((_, i) => i !== index);
  const changes: Partial<MovieClip> = { keyframes };
  for (const field of fields) if (!keyframes.some(k => k[field] !== undefined)) changes[field] = pose[field];
  return changes;
}

/**
 * The `update-clip` changes that set pose fields at the playhead: a field the clip animates gets a key
 * there (auto-key); every other field changes its resting value.
 */
export function movieClipPoseChanges(clip: MovieClip, values: PoseValues, playhead: ClipPlayhead): Partial<MovieClip> {
  const changes: Partial<MovieClip> = {};
  const keyed: PoseValues = {};
  for (const [field, value] of Object.entries(values) as Array<[MoviePoseField, number]>) {
    if (movieClipAnimates(clip, field)) keyed[field] = value;
    else changes[field] = value;
  }
  if (Object.keys(keyed).length) changes.keyframes = keyedAt(clip.keyframes ?? [], playhead, keyed);
  return changes;
}

/** ◇: adds `fields` at their current pose to the key under the playhead, or removes them from it. */
export function movieClipKeyToggle(clip: MovieClip, fields: readonly MoviePoseField[], playhead: ClipPlayhead): Partial<MovieClip> {
  const keys = clip.keyframes ?? [];
  const index = keyIndexAt(keys, playhead);
  if (index >= 0 && carries(keys[index]!, fields)) return withoutFields(clip, index, fields);
  return { keyframes: keyedAt(keys, playhead, pick(movieClipPose(clip, playhead.at), fields)) };
}

/** The nearest key carrying one of `fields` before (-1) or after (1) the playhead. */
function neighbourKey(clip: MovieClip, fields: readonly MoviePoseField[], playhead: ClipPlayhead, direction: -1 | 1): MovieClipKeyframe | undefined {
  const keys = (clip.keyframes ?? []).filter(key => carries(key, fields));
  return direction < 0
    ? keys.filter(key => key.at < playhead.at - playhead.tolerance).at(-1)
    : keys.find(key => key.at > playhead.at + playhead.tolerance);
}

/** The pose rows of the 画面 tab; each keys its fields together. */
const POSE_GROUPS = {
  position: { fields: ['x', 'y'], zh: '位置', en: 'Position' },
  scale: { fields: ['width', 'height'], zh: '缩放', en: 'Scale' },
  rotation: { fields: ['rotation'], zh: '旋转', en: 'Rotation' },
  opacity: { fields: ['opacity'], zh: '不透明度', en: 'Opacity' },
} as const satisfies Record<string, { fields: readonly MoviePoseField[]; zh: string; en: string }>;

type PoseGroup = (typeof POSE_GROUPS)[keyof typeof POSE_GROUPS];

/** ‹ ◇ › at the end of an animatable row: previous key, the key toggle at the playhead, next key. */
function KeyframeGroup({ section, group }: { section: ClipSectionProps; group: PoseGroup }) {
  const { document: d, shot, zh, disabled, onApply, time, start, onSeek } = section;
  const clip = shot.clip;
  if (!clip) return null;
  const playhead = clipPlayhead(d, shot, time, start);
  const keys = clip.keyframes ?? [];
  const index = keyIndexAt(keys, playhead);
  const on = index >= 0 && carries(keys[index]!, group.fields);
  const name = zh ? group.zh : group.en;
  const previous = neighbourKey(clip, group.fields, playhead, -1);
  const next = neighbourKey(clip, group.fields, playhead, 1);
  const seek = (key: MovieClipKeyframe | undefined) => {
    if (key) onSeek?.(start + key.at * shot.duration);
  };
  const action = on ? (zh ? '删除关键帧' : 'Remove keyframe') : (zh ? '添加关键帧' : 'Add keyframe');
  return (
    <span className={styles.keys}>
      <IconButton size="xs" className={styles.keyStep} aria-label={zh ? `上一个${name}关键帧` : `Previous ${name.toLowerCase()} keyframe`} disabled={!previous || !onSeek} onClick={() => seek(previous)}>
        <Icon icon={ChevronLeft} size="xs" />
      </IconButton>
      <IconButton
        size="xs"
        className={styles.keyToggle}
        data-animated={group.fields.some(field => movieClipAnimates(clip, field)) || undefined}
        on={on}
        aria-label={zh ? `${name}关键帧` : `${name} keyframe`}
        tooltip={action}
        disabled={disabled || !playhead.inside || (index < 0 && keys.length >= MAX_KEYFRAMES)}
        disabledReason={!disabled && !playhead.inside ? (zh ? '播放头不在此片段内' : 'The playhead is outside this clip') : undefined}
        onClick={() => void updateClip(onApply, shot, action, movieClipKeyToggle(clip, group.fields, playhead))}
      >
        <Icon icon={Diamond} size="sm" fill={on ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton size="xs" className={styles.keyStep} aria-label={zh ? `下一个${name}关键帧` : `Next ${name.toLowerCase()} keyframe`} disabled={!next || !onSeek} onClick={() => seek(next)}>
        <Icon icon={ChevronRight} size="xs" />
      </IconButton>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Field primitives
 * ---------------------------------------------------------------------------------------------- */

/** A number shown as text while typed or dragged and committed once; a refused commit shows the value again. */
function useCommittedNumber(value: number, min: number, max: number, step: number, onCommit: (value: number) => void | Promise<boolean>) {
  const [draft, setDraft] = useState(value);
  const [text, setText] = useState(() => formatValue(value, step));
  const committed = useRef(value);

  useEffect(() => {
    setDraft(value);
    setText(formatValue(value, step));
    committed.current = value;
  }, [value, step]);

  const show = (next: number) => {
    setDraft(next);
    setText(formatValue(next, step));
  };

  const commit = (raw: number) => {
    const next = clamp(raw, min, max);
    show(next);
    if (Math.abs(next - committed.current) <= 1e-7) return;
    committed.current = next;
    void Promise.resolve(onCommit(next)).then(ok => {
      if (ok !== false) return;
      committed.current = value;
      show(value);
    });
  };

  const commitText = () => {
    const parsed = Number(text);
    if (!text.trim() || !Number.isFinite(parsed)) show(draft);
    else commit(parsed);
  };

  return { draft, text, setText, show, commit, commitText };
}

/** A ghost number: transparent until hovered, a hairline field while focused; Enter or blur commits. */
function GhostNumber({ id, label, prefix, unit, text, min, max, step, disabled, onText, onCommit }: {
  id?: string;
  /** Needed when no <label> points at the field. */
  label?: string;
  prefix?: string;
  unit?: string;
  text: string;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onText(text: string): void;
  onCommit(): void;
}) {
  return (
    <span className={styles.number} data-disabled={disabled || undefined}>
      {prefix ? <span className={styles.numberPrefix} aria-hidden="true">{prefix}</span> : null}
      <Input
        id={id}
        variant="bare"
        inputSize="auto"
        className={styles.numberInput}
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        onChange={e => onText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={onCommit}
      />
      {unit ? <span className={styles.unit} aria-hidden="true">{unit}</span> : null}
    </span>
  );
}

export interface InspectorNumberFieldProps {
  label: string;
  /** A dim letter before the number: 'X', 'Y'. */
  prefix?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled: boolean;
  /** Return false (or a promise of false) when the edit was refused, so the field shows the value again. */
  onCommit(value: number): void | Promise<boolean>;
}

export function InspectorNumberField({ label, prefix, value, min, max, step = 1, unit, disabled, onCommit }: InspectorNumberFieldProps) {
  const number = useCommittedNumber(value, min, max, step, onCommit);
  return (
    <GhostNumber
      label={label}
      prefix={prefix}
      unit={unit}
      text={number.text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onText={number.setText}
      onCommit={number.commitText}
    />
  );
}

export interface InspectorSliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown after the number: '%', 's', '°', '×'. */
  unit?: string;
  disabled: boolean;
  /** Double-clicking the label commits this value. */
  resetValue?: number;
  /** Trailing controls on the row, such as the keyframe group. */
  aside?: ReactNode;
  /** Return false (or a promise of false) when the edit was refused, so the field shows the value again. */
  onCommit(value: number): void | Promise<boolean>;
}

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * Label, slider and number on one row (the slider takes its own line when the inspector is narrow).
 * Dragging only previews the number; the edit is committed once — on pointer-up, key-up, blur or
 * Enter — so one drag is one undo step. The number is a spinbutton and the range a slider, both
 * named by the label.
 */
export function InspectorSliderField({ label, value, min, max, step = 1, unit, disabled, resetValue, aside, onCommit }: InspectorSliderFieldProps) {
  const id = useId();
  const { locale } = useI18n();
  const number = useCommittedNumber(value, min, max, step, onCommit);
  const fill = ((clamp(number.draft, min, max) - min) / (max - min || 1)) * 100;
  const reset = resetValue !== undefined && !disabled ? resetValue : undefined;
  return (
    <div className={styles.slider} data-disabled={disabled || undefined} data-aside={aside ? '' : undefined}>
      <label
        className={styles.rowLabel}
        htmlFor={id}
        title={reset === undefined ? undefined : locale.startsWith('zh') ? '双击恢复默认值' : 'Double-click to reset'}
        onDoubleClick={reset === undefined ? undefined : () => number.commit(reset)}
      >
        {label}
      </label>
      <input
        type="range"
        className={styles.range}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={clamp(number.draft, min, max)}
        disabled={disabled}
        style={{ '--slider-fill': `${fill}%` } as CSSProperties}
        onChange={e => number.show(Number(e.target.value))}
        onPointerDown={e => e.currentTarget.setPointerCapture?.(e.pointerId)}
        onPointerUp={e => number.commit(Number(e.currentTarget.value))}
        onKeyUp={(e: KeyboardEvent<HTMLInputElement>) => {
          if (SLIDER_KEYS.has(e.key)) number.commit(Number(e.currentTarget.value));
        }}
        onBlur={e => number.commit(Number(e.currentTarget.value))}
      />
      <GhostNumber
        id={id}
        unit={unit}
        text={number.text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onText={number.setText}
        onCommit={number.commitText}
      />
      {aside}
    </div>
  );
}

/** Two numbers on one row (X and Y), each committing on its own, with optional trailing controls. */
export function InspectorPairRow({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row} role="group" aria-label={label}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.pair}>
        {children}
        {aside}
      </span>
    </div>
  );
}

const HEX_COLOR = /^#?([0-9a-f]{6})$/i;

export interface InspectorSwatch {
  value: string;
  zh: string;
  en: string;
}

/**
 * A six-digit hex colour: optional swatches, then the picker and its editable hex code. The picker
 * commits when it closes (blur), not on every pointer move; each choice is one edit.
 */
export function InspectorColorField({ label, value, swatches, disabled, onCommit }: {
  label: string;
  value: string;
  swatches?: readonly InspectorSwatch[];
  disabled: boolean;
  onCommit(value: string): void | Promise<boolean>;
}) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value.toUpperCase());
  useEffect(() => setText(value.toUpperCase()), [value]);

  const commit = (next: string) => {
    const hex = next.toUpperCase();
    setText(hex);
    if (hex === value.toUpperCase()) return;
    void Promise.resolve(onCommit(hex)).then(ok => {
      if (ok !== false) return;
      setText(value.toUpperCase());
      if (picker.current) picker.current.value = value;
    });
  };

  const commitText = () => {
    const match = HEX_COLOR.exec(text.trim());
    if (match) commit(`#${match[1]}`);
    else setText(value.toUpperCase());
  };

  return (
    <div className={`${styles.row} ${styles.rowTop}`}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.colorField}>
        {swatches ? (
          <span className={styles.swatches} role="group" aria-label={zh ? `${label}预设` : `${label} presets`}>
            {swatches.map(swatch => (
              <button
                key={swatch.value}
                type="button"
                className={styles.swatch}
                aria-label={zh ? swatch.zh : swatch.en}
                aria-pressed={swatch.value.toLowerCase() === value.toLowerCase()}
                style={{ background: swatch.value }}
                disabled={disabled}
                onClick={() => commit(swatch.value)}
              />
            ))}
          </span>
        ) : null}
        <span className={styles.colorValue}>
          <input
            key={value}
            ref={picker}
            type="color"
            className={styles.colorPicker}
            aria-label={label}
            defaultValue={value}
            disabled={disabled}
            onBlur={e => commit(e.target.value)}
          />
          <Input
            variant="bare"
            inputSize="auto"
            className={styles.hexInput}
            aria-label={zh ? `${label}色值` : `${label} hex`}
            value={text}
            maxLength={7}
            spellCheck={false}
            disabled={disabled}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onBlur={commitText}
          />
        </span>
      </span>
    </div>
  );
}

/** A pressable preset: a short label that shows whether it matches the clip. */
export function InspectorChip({ pressed, disabled, onClick, children }: {
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.chip} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export type InspectorTileMotion =
  | 'zoom-in'
  | 'zoom-out'
  | 'slide-left'
  | 'slide-right'
  | 'fade-in'
  | 'fade-out'
  | 'clear'
  | 'text-none'
  | 'text-fade'
  | 'text-rise'
  | 'text-slide'
  | 'text-type'
  | 'cut'
  | 'crossfade'
  | 'wipe'
  | 'iris';

const TRANSITION_MOTIONS = new Set<InspectorTileMotion>(['cut', 'crossfade', 'wipe', 'iris']);

/** A visual choice: a small stage that plays the motion on hover, with its name below. */
export function InspectorTile({ label, motion, pressed, disabled, onClick }: {
  label: string;
  motion: InspectorTileMotion;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  const glyph = motion === 'clear'
    ? <Icon icon={Eraser} size="sm" className={styles.tileIcon} />
    : motion.startsWith('text-')
      ? <span className={styles.tileText}>T</span>
      : <span className={styles.tileFrame} />;
  return (
    <button type="button" className={styles.tile} data-motion={motion} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <span className={styles.tileStage} aria-hidden="true">
        {glyph}
        {TRANSITION_MOTIONS.has(motion) ? <span className={styles.tileFrameNext} /> : null}
      </span>
      <span className={styles.tileLabel}>{label}</span>
    </button>
  );
}

/** The four transitions as tiles; `active` is the transition shown as chosen. */
export function TransitionTiles({ zh, active, disabled, onPick }: {
  zh: boolean;
  active?: string;
  disabled: boolean;
  onPick(transition: MovieTransitionKind): void;
}) {
  return (
    <div className={styles.tileGrid} role="group" aria-label={zh ? '转场' : 'Transitions'}>
      {MOVIE_TRANSITIONS.map(item => (
        <InspectorTile
          key={item.id}
          motion={item.id}
          label={zh ? item.name.zh : item.name.en}
          pressed={active === item.id}
          disabled={disabled}
          onClick={() => onPick(item.id)}
        />
      ))}
    </div>
  );
}

/** The filter looks over a still of the clip (or a neutral sample scene); `active` gets a check. */
export function FilterTiles({ zh, frame, active, layout, disabled, onPick }: {
  zh: boolean;
  /** URL of a still frame to preview the looks on. */
  frame?: string;
  active?: string;
  /** strip: one scrolling row (the 调节 tab); grid: three columns (全片设置). */
  layout: 'strip' | 'grid';
  disabled: boolean;
  onPick(preset: MovieFilterPreset): void;
}) {
  return (
    <div className={layout === 'strip' ? styles.filterStrip : styles.filterGrid} role="group" aria-label={zh ? '滤镜' : 'Filters'}>
      {MOVIE_FILTER_PRESETS.map(preset => (
        <button key={preset.id} type="button" className={styles.filterTile} aria-pressed={active === preset.id} disabled={disabled} onClick={() => onPick(preset)}>
          <span className={styles.filterThumb} aria-hidden="true">
            {frame ? (
              <img className={styles.filterImage} src={frame} alt="" draggable={false} style={{ filter: movieColorFilter(preset.color, 0.15) }} />
            ) : (
              <span className={styles.filterSample} style={{ filter: movieColorFilter(preset.color, 0.15) }} />
            )}
            {active === preset.id ? (
              <span className={styles.filterCheck}>
                <Icon icon={Check} size={10} strokeWidth={2.5} />
              </span>
            ) : null}
          </span>
          <span className={styles.filterLabel}>{zh ? preset.name.zh : preset.name.en}</span>
        </button>
      ))}
    </div>
  );
}

/** Which sections of the tabbed inspector are folded; absent in the stack, where sections do not fold. */
export interface InspectorFolds {
  folded(name: string): boolean;
  toggle(name: string): void;
}

export const InspectorFoldContext = createContext<InspectorFolds | null>(null);

/**
 * A titled block of the tabbed inspector: a 32px header with the title, optional tools (reset) and a
 * fold chevron. `name` marks it as a scroll target for timeline requests (data-section).
 */
export function InspectorSection({ name, title, aside, children }: { name?: string; title: string; aside?: ReactNode; children: ReactNode }) {
  const folds = useContext(InspectorFoldContext);
  const { locale } = useI18n();
  const bodyId = useId();
  const foldable = Boolean(name && folds);
  const folded = Boolean(name && folds?.folded(name));
  return (
    <section className={styles.section} data-section={name} data-folded={folded || undefined}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {aside && !folded ? <span className={styles.sectionTools}>{aside}</span> : null}
        {foldable ? (
          <IconButton
            size="xs"
            aria-label={locale.startsWith('zh') ? `折叠${title}` : `Fold ${title}`}
            aria-expanded={!folded}
            aria-controls={bodyId}
            tooltip={folded ? (locale.startsWith('zh') ? '展开' : 'Expand') : (locale.startsWith('zh') ? '收起' : 'Collapse')}
            onClick={() => folds?.toggle(name!)}
          >
            <Icon icon={ChevronDown} size="sm" className={styles.foldIcon} />
          </IconButton>
        ) : null}
      </div>
      <div id={bodyId} className={styles.sectionBody} hidden={folded} data-section-body="">
        {children}
      </div>
    </section>
  );
}

/** A fold-away group of the compact inspector stack. */
export function InspectorDisclosure({ label, defaultOpen, children }: { label: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Disclosure
      label={label}
      defaultOpen={defaultOpen}
      className={styles.disclosure}
      triggerClassName={styles.disclosureTrigger}
      contentClassName={styles.disclosureBody}
    >
      {children}
    </Disclosure>
  );
}

export function InspectorHint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

/* ------------------------------------------------------------------------------------------------
 * Section resets (↺)
 * ---------------------------------------------------------------------------------------------- */

const NO_CROP: MovieClipCrop = { top: 0, right: 0, bottom: 0, left: 0 };
const REST_POSE = { x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1 } as const;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const sameCrop = (a: MovieClipCrop, b: MovieClipCrop) => (['top', 'right', 'bottom', 'left'] as const).every(edge => near(a[edge], b[edge]));

const RESETS = {
  pose: {
    zh: '重置位置与大小',
    en: 'Reset position and size',
    changes: (clip: MovieClip): Partial<MovieClip> => ({ ...REST_POSE, ...(clip.keyframes?.length ? { keyframes: [] } : {}) }),
    resting: (clip: MovieClip) => !clip.keyframes?.length && MOVIE_CLIP_ANIMATED_FIELDS.every(field => near(movieClipPose(clip, 0)[field], REST_POSE[field])),
  },
  crop: {
    zh: '重置裁切',
    en: 'Reset crop',
    changes: (): Partial<MovieClip> => ({ crop: NO_CROP }),
    resting: (clip: MovieClip) => sameCrop(clip.crop ?? NO_CROP, NO_CROP),
  },
  color: {
    zh: '重置调节',
    en: 'Reset adjustments',
    changes: (): Partial<MovieClip> => ({ color: MOVIE_ORIGINAL_COLOR }),
    resting: (clip: MovieClip) => movieFilterPresetFor(movieClipColor(clip))?.id === 'original',
  },
} as const;

/** ↺ in a section header: returns that part of the clip to its defaults, in one edit. */
export function ClipResetButton({ part, shot, disabled, zh, onApply }: ClipSectionProps & { part: keyof typeof RESETS }) {
  const clip = shot.clip;
  if (!clip) return null;
  const reset = RESETS[part];
  const label = zh ? reset.zh : reset.en;
  return (
    <IconButton size="xs" aria-label={label} disabled={disabled || reset.resting(clip)} onClick={() => void updateClip(onApply, shot, label, reset.changes(clip))}>
      <Icon icon={RotateCcw} size="sm" />
    </IconButton>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Picture: fit, pose, quick layouts, crop, fades
 * ---------------------------------------------------------------------------------------------- */

export function ClipFitField({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{zh ? '适配' : 'Fit'}</span>
      <Segmented
        size="sm"
        className={styles.segmented}
        aria-label={zh ? '画面适配' : 'Picture fit'}
        value={clip.fit}
        disabled={disabled}
        onValueChange={fit => void updateClip(onApply, shot, zh ? '调整画面适配' : 'Change fit', { fit: fit as MovieClip['fit'] })}
      >
        <SegmentedItem className={styles.segmentedItem} value="contain">{zh ? '适合' : 'Fit'}</SegmentedItem>
        <SegmentedItem className={styles.segmentedItem} value="cover">{zh ? '填充' : 'Fill'}</SegmentedItem>
      </Segmented>
    </div>
  );
}

const POSE_LIMIT = { min: -150, max: 250 } as const;

/** A new scale for the picture box, keeping its proportions and its centre. */
function scaledBox(pose: MovieClipPose, width: number): PoseValues {
  const height = clamp((width * pose.height) / pose.width, 1, 400);
  return {
    width,
    height,
    x: clamp(pose.x + (pose.width - width) / 2, POSE_LIMIT.min, POSE_LIMIT.max),
    y: clamp(pose.y + (pose.height - height) / 2, POSE_LIMIT.min, POSE_LIMIT.max),
  };
}

/** 位置 / 缩放 / 旋转 / 不透明度 at the playhead, each with its keyframe group, then the quick layouts. */
export function ClipPoseSection(section: ClipSectionProps) {
  const { document: d, shot, zh, disabled, onApply, time, start } = section;
  const clip = shot.clip;
  if (!clip) return null;
  const playhead = clipPlayhead(d, shot, time, start);
  const pose = movieClipPose(clip, playhead.at);
  const setPose = (label: string, values: PoseValues) => updateClip(onApply, shot, label, movieClipPoseChanges(clip, values, playhead));
  const keys = (group: PoseGroup) => <KeyframeGroup section={section} group={group} />;
  return (
    <>
      <InspectorPairRow label={zh ? '位置' : 'Position'} aside={keys(POSE_GROUPS.position)}>
        <InspectorNumberField label={zh ? '水平位置' : 'Position X'} prefix="X" unit="%" value={pose.x} min={POSE_LIMIT.min} max={POSE_LIMIT.max} step={0.1} disabled={disabled}
          onCommit={x => setPose(zh ? '移动画面' : 'Move picture', { x })} />
        <InspectorNumberField label={zh ? '垂直位置' : 'Position Y'} prefix="Y" unit="%" value={pose.y} min={POSE_LIMIT.min} max={POSE_LIMIT.max} step={0.1} disabled={disabled}
          onCommit={y => setPose(zh ? '移动画面' : 'Move picture', { y })} />
      </InspectorPairRow>
      <InspectorSliderField label={zh ? '缩放' : 'Scale'} unit="%" value={pose.width} min={1} max={400} resetValue={100} disabled={disabled} aside={keys(POSE_GROUPS.scale)}
        onCommit={width => setPose(zh ? '缩放画面' : 'Scale picture', scaledBox(pose, width))} />
      <InspectorSliderField label={zh ? '旋转' : 'Rotation'} unit="°" value={pose.rotation} min={-360} max={360} resetValue={0} disabled={disabled} aside={keys(POSE_GROUPS.rotation)}
        onCommit={rotation => setPose(zh ? '旋转画面' : 'Rotate picture', { rotation })} />
      <InspectorSliderField label={zh ? '不透明度' : 'Opacity'} unit="%" value={pose.opacity * 100} min={0} max={100} resetValue={100} disabled={disabled} aside={keys(POSE_GROUPS.opacity)}
        onCommit={value => setPose(zh ? '调整不透明度' : 'Change opacity', { opacity: value / 100 })} />
      <ClipQuickLayouts {...section} />
    </>
  );
}

const STACK_FIELDS = [
  { key: 'height', zh: '画面高度', en: 'Height', min: 1, max: 400, unit: '%', reset: 100 },
  { key: 'rotation', zh: '旋转', en: 'Rotation', min: -360, max: 360, unit: '°', reset: 0 },
] as const;

/** Height and rotation for the compact stack (its draft holds position, scale and opacity). */
export function ClipTransformFields(section: ClipSectionProps) {
  const { document: d, shot, zh, disabled, onApply, time, start } = section;
  const clip = shot.clip;
  if (!clip) return null;
  const playhead = clipPlayhead(d, shot, time, start);
  const pose = movieClipPose(clip, playhead.at);
  return (
    <>
      {STACK_FIELDS.map(field => (
        <InspectorSliderField
          key={field.key}
          label={zh ? field.zh : field.en}
          unit={field.unit}
          value={pose[field.key]}
          min={field.min}
          max={field.max}
          resetValue={field.reset}
          disabled={disabled}
          onCommit={value => updateClip(onApply, shot, zh ? `调整${field.zh}` : `Change ${field.en.toLowerCase()}`, movieClipPoseChanges(clip, { [field.key]: value }, playhead))}
        />
      ))}
    </>
  );
}

interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PIP = 34;
const PIP_MARGIN = 4;
const PIP_FAR = 100 - PIP - PIP_MARGIN;
const pipBox = (x: number, y: number): LayoutBox => ({ x, y, width: PIP, height: PIP });

/** 快速布局: where the picture box goes; `centred` keeps the current size. */
const QUICK_LAYOUTS: ReadonlyArray<{ id: string; zh: string; en: string; box(pose: MovieClipPose): LayoutBox; glyph: LayoutBox; fit?: MovieClip['fit'] }> = [
  { id: 'center', zh: '居中', en: 'Center', box: pose => ({ x: (100 - pose.width) / 2, y: (100 - pose.height) / 2, width: pose.width, height: pose.height }), glyph: { x: 22, y: 22, width: 56, height: 56 } },
  { id: 'fill', zh: '填充', en: 'Fill', box: () => ({ x: 0, y: 0, width: 100, height: 100 }), glyph: { x: 0, y: 0, width: 100, height: 100 }, fit: 'cover' },
  { id: 'top-left', zh: '左上', en: 'Top left', box: () => pipBox(PIP_MARGIN, PIP_MARGIN), glyph: pipBox(PIP_MARGIN, PIP_MARGIN) },
  { id: 'top-right', zh: '右上', en: 'Top right', box: () => pipBox(PIP_FAR, PIP_MARGIN), glyph: pipBox(PIP_FAR, PIP_MARGIN) },
  { id: 'bottom-left', zh: '左下', en: 'Bottom left', box: () => pipBox(PIP_MARGIN, PIP_FAR), glyph: pipBox(PIP_MARGIN, PIP_FAR) },
  { id: 'bottom-right', zh: '右下', en: 'Bottom right', box: () => pipBox(PIP_FAR, PIP_FAR), glyph: pipBox(PIP_FAR, PIP_FAR) },
];

/** The quick layout the clip is in. Any centred box matches 居中, so a more specific match wins. */
function activeLayout(clip: MovieClip, pose: MovieClipPose): string | undefined {
  const matching = QUICK_LAYOUTS.filter(layout => {
    const box = layout.box(pose);
    return near(pose.x, box.x) && near(pose.y, box.y) && near(pose.width, box.width) && near(pose.height, box.height) && (!layout.fit || clip.fit === layout.fit);
  });
  return (matching.find(layout => layout.id !== 'center') ?? matching[0])?.id;
}

export function ClipQuickLayouts({ document: d, shot, zh, disabled, onApply, time, start }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  const playhead = clipPlayhead(d, shot, time, start);
  const pose = movieClipPose(clip, playhead.at);
  const active = activeLayout(clip, pose);
  return (
    <div className={styles.layouts}>
      <span className={styles.layoutsLabel}>{zh ? '快速布局' : 'Quick layout'}</span>
      <div className={styles.layoutGrid} role="group" aria-label={zh ? '快速布局' : 'Quick layout'}>
        {QUICK_LAYOUTS.map(layout => (
          <button
            key={layout.id}
            type="button"
            className={styles.layoutChip}
            aria-pressed={active === layout.id}
            disabled={disabled}
            onClick={() => void updateClip(onApply, shot, zh ? '快速布局' : 'Apply layout', {
              ...movieClipPoseChanges(clip, layout.box(pose), playhead),
              ...(layout.fit ? { fit: layout.fit } : {}),
            })}
          >
            <span className={styles.layoutGlyph} aria-hidden="true">
              <span className={styles.layoutBox} style={{ left: `${layout.glyph.x}%`, top: `${layout.glyph.y}%`, width: `${layout.glyph.width}%`, height: `${layout.glyph.height}%` }} />
            </span>
            <span className={styles.layoutName}>{zh ? layout.zh : layout.en}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const PORTRAIT_CROP: MovieClipCrop = { top: 0, right: 0.34, bottom: 0, left: 0.34 };
const CROP_EDGES = [
  { edge: 'top', zh: '上边裁切', en: 'Crop top' },
  { edge: 'bottom', zh: '下边裁切', en: 'Crop bottom' },
  { edge: 'left', zh: '左边裁切', en: 'Crop left' },
  { edge: 'right', zh: '右边裁切', en: 'Crop right' },
] as const;

export function ClipCropSection({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  const crop = clip.crop ?? NO_CROP;
  return (
    <>
      {CROP_EDGES.map(({ edge, zh: zhLabel, en }) => (
        <InspectorSliderField
          key={edge}
          label={zh ? zhLabel : en}
          unit="%"
          value={crop[edge] * 100}
          min={0}
          max={45}
          step={0.5}
          resetValue={0}
          disabled={disabled}
          onCommit={value => updateClip(onApply, shot, zh ? '裁切画面' : 'Crop source', { crop: { ...crop, [edge]: value / 100 } })}
        />
      ))}
      <div className={styles.chips}>
        <InspectorChip pressed={sameCrop(crop, PORTRAIT_CROP)} disabled={disabled} onClick={() => void updateClip(onApply, shot, zh ? '中心竖向裁切' : 'Portrait crop', { crop: PORTRAIT_CROP })}>
          {zh ? '中心竖向' : 'Portrait center'}
        </InspectorChip>
      </div>
    </>
  );
}

/** Picture fade in/out, in seconds of the clip; an audio fade set on its own stays as it is. */
export function ClipFadeFields({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  return (
    <>
      <InspectorSliderField label={zh ? '画面淡入' : 'Fade in'} unit="s" value={clip.fadeIn ?? 0} min={0} max={shot.duration} step={0.1} resetValue={0} disabled={disabled}
        onCommit={fadeIn => updateClip(onApply, shot, zh ? '画面淡入' : 'Fade in', movieKeepAudioFades(clip, { fadeIn }))} />
      <InspectorSliderField label={zh ? '画面淡出' : 'Fade out'} unit="s" value={clip.fadeOut ?? 0} min={0} max={shot.duration} step={0.1} resetValue={0} disabled={disabled}
        onCommit={fadeOut => updateClip(onApply, shot, zh ? '画面淡出' : 'Fade out', movieKeepAudioFades(clip, { fadeOut }))} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Colour (调节)
 * ---------------------------------------------------------------------------------------------- */

const COLOR_FIELDS = [
  { key: 'exposure', zh: '曝光', en: 'Exposure', unit: 'EV', min: -3, max: 3, step: 0.1, scale: 1 },
  { key: 'contrast', zh: '对比度', en: 'Contrast', unit: '%', min: 0, max: 300, step: 5, scale: 100 },
  { key: 'saturation', zh: '饱和度', en: 'Saturation', unit: '%', min: 0, max: 300, step: 5, scale: 100 },
  { key: 'blur', zh: '模糊', en: 'Blur', unit: 'px', min: 0, max: 30, step: 0.5, scale: 1 },
  { key: 'grayscale', zh: '黑白', en: 'Grayscale', unit: '%', min: 0, max: 100, step: 5, scale: 100 },
] as const;

/** A strip of filter looks over the clip's frame, then the five colour sliders. */
export function ClipColorSection({ shot, disabled, zh, onApply, frame }: ClipSectionProps & { frame?: string }) {
  const clip = shot.clip;
  if (!clip) return null;
  const color = movieClipColor(clip);
  const setColor = (label: string, next: MovieClipColor) => updateClip(onApply, shot, label, { color: next });
  return (
    <>
      <FilterTiles
        zh={zh}
        frame={frame}
        active={movieFilterPresetFor(color)?.id}
        layout="strip"
        disabled={disabled}
        onPick={preset => void setColor(zh ? '应用滤镜' : 'Apply filter', preset.color)}
      />
      {COLOR_FIELDS.map(field => (
        <InspectorSliderField
          key={field.key}
          label={zh ? field.zh : field.en}
          unit={field.unit}
          value={color[field.key] * field.scale}
          min={field.min}
          max={field.max}
          step={field.step}
          resetValue={MOVIE_ORIGINAL_COLOR[field.key] * field.scale}
          disabled={disabled}
          onCommit={value => setColor(zh ? `调整${field.zh}` : `Change ${field.en.toLowerCase()}`, { ...color, [field.key]: value / field.scale })}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Transition to the next clip
 * ---------------------------------------------------------------------------------------------- */

export function ClipTransitionSection({ document: d, shot, disabled, zh, onApply }: ClipSectionProps) {
  const visual = movieShotVisual(d, shot);
  const setVisual = (label: string, changes: Partial<MovieVisual>) =>
    onApply(label, [{ op: 'update-shot', shotId: shot.id, changes: { visual: { ...visual, ...changes } } }]);
  return (
    <>
      <TransitionTiles zh={zh} active={visual.transition} disabled={disabled} onPick={transition => void setVisual(zh ? '调整片段转场' : 'Edit transition', { transition })} />
      <InspectorSliderField
        label={zh ? '转场时长' : 'Transition length'}
        unit="s"
        value={visual.transitionDuration ?? MOVIE_TRANSITION_SECONDS.default}
        min={MOVIE_TRANSITION_SECONDS.min}
        max={MOVIE_TRANSITION_SECONDS.max}
        step={0.05}
        resetValue={MOVIE_TRANSITION_SECONDS.default}
        disabled={disabled}
        onCommit={transitionDuration => setVisual(zh ? '调整转场时长' : 'Change transition length', { transitionDuration })}
      />
      {!movieTransitionReady(d, shot) ? (
        <InspectorHint>{zh ? '没有相邻的下一片段：把下一片段贴到本轨末尾，转场就会生效。' : 'No adjacent next clip: place one directly after this clip on the same track.'}</InspectorHint>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Animation: motion presets and the keyframe list
 * ---------------------------------------------------------------------------------------------- */

/** One-click motions that replace the clip's keyframes, plus clearing them (the pose at the playhead stays). */
export function ClipMotionPresets({ document: d, shot, disabled, zh, onApply, time, start }: ClipSectionProps) {
  if (!isMovieVisualClip(shot)) return null;
  const clip = shot.clip;
  const active = movieClipAnimationFor(clip);
  const playhead = clipPlayhead(d, shot, time, start);
  return (
    <div className={styles.tileGrid} role="group" aria-label={zh ? '动画预设' : 'Motion presets'}>
      {MOVIE_CLIP_ANIMATIONS.map(preset => (
        <InspectorTile
          key={preset.id}
          motion={preset.id}
          label={zh ? preset.name.zh : preset.name.en}
          pressed={active === preset.id}
          disabled={disabled}
          onClick={() => void onApply(zh ? '应用动画' : 'Apply motion', movieClipAnimationOperations(shot, preset.id))}
        />
      ))}
      <InspectorTile
        motion="clear"
        label={zh ? '清除动画' : 'Clear'}
        disabled={disabled || !clip.keyframes?.length}
        onClick={() => void updateClip(onApply, shot, zh ? '清除关键帧' : 'Clear animation', { ...movieClipPose(clip, playhead.at), keyframes: [] })}
      />
    </div>
  );
}

const keyFieldNames = (key: MovieClipKeyframe, zh: boolean) =>
  Object.values(POSE_GROUPS).filter(group => carries(key, group.fields)).map(group => (zh ? group.zh : group.en)).join(' · ') || '—';

/** The clip's keys: jump to one, retime it, see what it animates, delete it; add a full pose at the playhead. */
export function ClipKeyframeList({ document: d, shot, disabled, zh, onApply, time, start, onSeek }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  const keys = clip.keyframes ?? [];
  const playhead = clipPlayhead(d, shot, time, start);
  const current = keyIndexAt(keys, playhead);
  const save = (label: string, changes: Partial<MovieClip>) => updateClip(onApply, shot, label, changes);
  const retime = (index: number, seconds: number) => {
    const at = Math.round(clamp(seconds / shot.duration, 0, 1) * 1e6) / 1e6;
    if (keys.some((key, i) => i !== index && near(key.at, at))) return Promise.resolve(false);
    return save(zh ? '移动关键帧' : 'Move keyframe', { keyframes: keys.map((key, i) => (i === index ? { ...key, at } : key)).sort((a, b) => a.at - b.at) });
  };
  const local = clamp(time - start, 0, shot.duration);
  return (
    <>
      <div className={styles.keyframeBar}>
        <span className={styles.hint}>{zh ? `播放头 ${local.toFixed(2)} 秒` : `Playhead ${local.toFixed(2)}s`}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !playhead.inside || current >= 0 || keys.length >= MAX_KEYFRAMES}
          onClick={() => void save(zh ? '添加关键帧' : 'Add keyframe', { keyframes: keyedAt(keys, playhead, movieClipPose(clip, playhead.at)) })}
        >
          <Icon icon={Plus} size="sm" />
          {zh ? '在播放头添加' : 'Add at playhead'}
        </Button>
      </div>
      {keys.length ? (
        <ol className={styles.keyList} aria-label={zh ? '画面关键帧' : 'Clip keyframes'}>
          {keys.map((key, index) => {
            const n = index + 1;
            return (
              <li key={`${key.at}-${index}`} className={styles.keyRow} data-current={index === current || undefined}>
                <IconButton size="xs" className={styles.keyJump} aria-label={zh ? `跳到关键帧 ${n}` : `Go to keyframe ${n}`} disabled={!onSeek} onClick={() => onSeek?.(start + key.at * shot.duration)}>
                  <Icon icon={Diamond} size="xs" fill="currentColor" />
                </IconButton>
                <InspectorNumberField label={zh ? `关键帧 ${n} 时间` : `Keyframe ${n} time`} unit="s" value={key.at * shot.duration} min={0} max={shot.duration} step={0.01} disabled={disabled}
                  onCommit={seconds => retime(index, seconds)} />
                <span className={styles.keyFields}>{keyFieldNames(key, zh)}</span>
                <IconButton size="xs" aria-label={zh ? `删除关键帧 ${n}` : `Delete keyframe ${n}`} disabled={disabled}
                  onClick={() => void save(zh ? '删除关键帧' : 'Delete keyframe', withoutFields(clip, index, MOVIE_CLIP_ANIMATED_FIELDS))}>
                  <Icon icon={Trash2} size="sm" />
                </IconButton>
              </li>
            );
          })}
        </ol>
      ) : (
        <InspectorHint>{zh ? '还没有关键帧。选一个动画预设，或在播放头添加。' : 'No keyframes yet. Pick a motion or add one at the playhead.'}</InspectorHint>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Sound
 * ---------------------------------------------------------------------------------------------- */

export function ClipVolumeField({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  return (
    <InspectorSliderField
      label={zh ? '音量' : 'Volume'}
      unit="%"
      value={clip.volume * 100}
      min={0}
      max={100}
      resetValue={100}
      disabled={disabled}
      onCommit={value => updateClip(onApply, shot, zh ? '调整音量' : 'Change volume', { volume: value / 100 })}
    />
  );
}

export function ClipMuteSwitch({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const id = useId();
  const clip = shot.clip;
  if (!clip) return null;
  return (
    <div className={styles.row}>
      <label className={styles.rowLabel} htmlFor={id}>{zh ? '静音' : 'Mute'}</label>
      <span className={styles.switchCell}>
        <Switch
          id={id}
          size="sm"
          checked={Boolean(clip.muted)}
          disabled={disabled}
          onCheckedChange={muted => void updateClip(onApply, shot, muted ? (zh ? '静音' : 'Mute') : (zh ? '取消静音' : 'Unmute'), { muted })}
        />
      </span>
    </div>
  );
}

/** Mute and original volume as buttons, for the compact stack. */
export function ClipSoundButtons({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  return (
    <div className={styles.chips}>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void updateClip(onApply, shot, zh ? '切换原声' : 'Toggle sound', { muted: !clip.muted })}>
        {clip.muted ? (zh ? '恢复原声' : 'Unmute') : (zh ? '静音原声' : 'Mute')}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void updateClip(onApply, shot, zh ? '恢复音量' : 'Reset volume', { volume: 1, muted: false })}>
        {zh ? '原始音量' : 'Original volume'}
      </Button>
    </div>
  );
}

export function ClipAudioFades({ shot, disabled, zh, onApply }: ClipSectionProps) {
  const clip = shot.clip;
  if (!clip) return null;
  return (
    <>
      <InspectorSliderField label={zh ? '声音淡入' : 'Audio fade in'} unit="s" value={clip.audioFadeIn ?? clip.fadeIn ?? 0} min={0} max={shot.duration} step={0.1} resetValue={0} disabled={disabled}
        onCommit={audioFadeIn => updateClip(onApply, shot, zh ? '声音淡入' : 'Audio fade in', { audioFadeIn })} />
      <InspectorSliderField label={zh ? '声音淡出' : 'Audio fade out'} unit="s" value={clip.audioFadeOut ?? clip.fadeOut ?? 0} min={0} max={shot.duration} step={0.1} resetValue={0} disabled={disabled}
        onCommit={audioFadeOut => updateClip(onApply, shot, zh ? '声音淡出' : 'Audio fade out', { audioFadeOut })} />
    </>
  );
}

const MAX_REPEATS = 45;

/**
 * Duplicates a detached audio clip after itself until the film ends: one batch, one undo step. The last copy is
 * trimmed to the film end, which keeps its fades (and keys) inside its shorter length.
 */
export function ClipRepeatButton({ document: d, shot, disabled, zh, onApply }: ClipSectionProps) {
  if (!shot.clip?.audioOnly) return null;
  const start = movieShotStarts(d)[d.shots.findIndex(s => s.id === shot.id)] ?? 0;
  const filmEnd = movieDuration(d);
  const remaining = filmEnd - start - shot.duration;
  const repeat = () => {
    const operations: MovieEditOperation[] = [];
    let cursor = start + shot.duration;
    for (let copies = 0; cursor < filmEnd - 0.02 && copies < MAX_REPEATS; copies++) {
      const id = crypto.randomUUID();
      const duration = Math.min(shot.duration, filmEnd - cursor);
      operations.push({ op: 'duplicate-clip', shotId: shot.id, at: cursor, track: shot.placement?.track ?? 0, newShotId: id });
      if (duration < shot.duration - 1e-9) operations.push({ op: 'trim-clip', shotId: id, start: 0, end: duration });
      cursor += duration;
    }
    if (operations.length) void onApply(zh ? '重复音频至片尾' : 'Repeat audio to film end', operations);
  };
  return (
    <Button size="sm" variant="ghost" disabled={disabled || remaining <= 0.02 || Math.ceil(remaining / shot.duration) > MAX_REPEATS} onClick={repeat}>
      {zh ? '循环到片尾' : 'Loop to film end'}
    </Button>
  );
}

/* ------------------------------------------------------------------------------------------------
 * The compact stack's clip groups
 * ---------------------------------------------------------------------------------------------- */

/** The clip groups of the compact inspector stack, each a fold-away disclosure. */
export function MovieAdvancedInspector({ document: d, shot, time, disabled, zh, onApply, onSeek }: {
  document: MovieDocument;
  shot: MovieShot;
  time: number;
  disabled: boolean;
  zh: boolean;
  onApply: MovieApplyEdit;
  onSeek?(time: number): void;
}) {
  const clip = shot.clip;
  if (!clip) return null;
  const start = movieShotStarts(d)[d.shots.findIndex(s => s.id === shot.id)] ?? 0;
  const section: ClipSectionProps = { document: d, shot, disabled, zh, onApply, time, start, onSeek };
  return (
    <>
      {!movieShotIsImage(d, shot) ? (
        <InspectorDisclosure label={zh ? '音频与原声' : 'Audio and sound'}>
          <ClipSoundButtons {...section} />
          <ClipAudioFades {...section} />
          <ClipRepeatButton {...section} />
        </InspectorDisclosure>
      ) : null}
      {!clip.audioOnly ? (
        <>
          <InspectorDisclosure label={zh ? '画面布局与旋转' : 'Layout and rotation'}>
            <ClipQuickLayouts {...section} />
            <ClipTransformFields {...section} />
          </InspectorDisclosure>
          <InspectorDisclosure label={zh ? '画面裁切' : 'Source crop'}>
            <ClipCropSection {...section} />
          </InspectorDisclosure>
          <InspectorDisclosure label={zh ? '调色与画面效果' : 'Color and image effects'}>
            <ClipColorSection {...section} />
          </InspectorDisclosure>
          <InspectorDisclosure label={zh ? '片段末尾转场' : 'Transition to next clip'}>
            <ClipTransitionSection {...section} />
          </InspectorDisclosure>
          <InspectorDisclosure label={`${zh ? '画面关键帧' : 'Clip keyframes'} · ${clip.keyframes?.length ?? 0}`}>
            <ClipMotionPresets {...section} />
            <ClipKeyframeList {...section} />
          </InspectorDisclosure>
        </>
      ) : null}
    </>
  );
}
