// Layout adapted from Palmier InspectorRow.swift; see THIRD_PARTY_NOTICES.md.
// The clip inspector, in two layouts over one draft:
//  - 'tabs': the editor's panel in both editor layouts (docked in FULL, the 调整 popover in COMPACT). Its
//    tabs follow the selection (画面 · 音频 · 变速 · 动画 · 调节 · 字幕 for a video clip, 文本 · 动画 for
//    text …) and remember the last tab per selection type; with nothing selected it is 全片设置.
//  - 'stack' (default): fold-away groups, kept for the embedded presentation and older callers.
// Name, timing and caption cues are a draft applied as one edit (应用/取消); every other control commits
// on its own through the same edit path, one intention per undo step.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ChevronLeft, ChevronRight, Link2, Lock, Plus, Trash2, type LucideIcon } from 'lucide-react';
import {
  movieDuration,
  movieFps,
  movieFrameSize,
  movieShotStarts,
  type MovieCaption,
  type MovieCaptionStyle,
  type MovieDocument,
  type MovieEditOperation,
  type MovieSettings,
  type MovieShot,
  type MovieVideoSource,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import {
  Button,
  Icon,
  IconButton,
  Input,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  cn,
} from '../../fantay/ui';
import { selectionEditOperations } from './MovieSelectionEditor';
import styles from './MovieCompactInspector.module.css';
import { formatTimecode, parseTimecode } from './palmier/palmier-core';
import {
  ClipAudioFades,
  ClipColorSection,
  ClipCropSection,
  ClipFadeFields,
  ClipFitField,
  ClipKeyframeList,
  ClipMotionPresets,
  ClipMuteSwitch,
  ClipPoseSection,
  ClipRepeatButton,
  ClipResetButton,
  ClipTransitionSection,
  ClipVolumeField,
  FilterTiles,
  InspectorColorField,
  InspectorDisclosure,
  InspectorFoldContext,
  InspectorHint,
  InspectorNumberField,
  InspectorPairRow,
  InspectorSection,
  InspectorSliderField,
  InspectorTile,
  MovieAdvancedInspector,
  TransitionTiles,
  clipPlayhead,
  movieClipPoseChanges,
  movieKeepAudioFades,
  movieShotIsImage,
  type ClipSectionProps,
  type InspectorFolds,
  type InspectorSwatch,
  type InspectorTileMotion,
  type MovieApplyEdit,
} from './MovieAdvancedInspector';
import {
  MOVIE_CAPTION_STYLE_PRESETS,
  MOVIE_DEFAULT_CAPTION_STYLE,
  MOVIE_FILTER_PRESETS,
  MOVIE_TRANSITIONS,
  MOVIE_TRANSITION_SECONDS,
  movieApplyAllBlocked,
  movieCaptionStyle,
  movieCaptionStyleOperations,
  movieCaptionStylePresetFor,
  movieCaptionTargets,
  movieClipColor,
  movieFilterOperations,
  movieFilterPresetFor,
  movieFilterTargets,
  movieShotVisual,
  movieTransitionKind,
  movieTransitionOperations,
  movieTransitionTargets,
  type MovieCaptionStylePreset,
} from './movie-editor-presets';
import type { MovieInspectorRequest } from './movie-editor-layout';
import { parseMovieSubtitles, movieSubtitlesText } from './movie-subtitles';

type MovieClip = NonNullable<MovieShot['clip']>;
type MovieVisual = NonNullable<MovieShot['visual']>;
type SelectionKind = 'video' | 'audio';

export function editorTimecode(seconds: number, fps = 30): string {
  return formatTimecode(Math.max(0, Math.round(seconds * fps)), fps);
}

export function parseEditorTimecode(text: string, fps = 30): number | null {
  if (/^\d+(?:\.\d+)?$/.test(text.trim())) return Number(text);
  const frames = parseTimecode(text.trim(), fps);
  return frames === null ? null : frames / fps;
}

/** HH:MM:SS:FF at every length: the player bar's format. */
function filmTimecode(seconds: number, fps: number): string {
  return editorTimecode(seconds, fps);
}

const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/i;
const textColorOf = (shot: MovieShot) => (SIX_DIGIT_HEX.test(shot.visual?.foreground ?? '') ? shot.visual!.foreground! : '#FFFFFF');

/** The draft fields: what the 应用 button turns into one edit. */
function formFor(shot: MovieShot, fps = 30) {
  return {
    title: shot.title,
    duration: editorTimecode(shot.duration, fps),
    in: editorTimecode(shot.clip?.in ?? 0, fps),
    rate: String(shot.clip?.rate ?? 1),
    volume: Math.round((shot.clip?.volume ?? 1) * 100),
    fit: shot.clip?.fit ?? 'contain',
    x: shot.clip?.x ?? 0,
    y: shot.clip?.y ?? 0,
    width: shot.clip?.width ?? 100,
    opacity: shot.clip?.opacity ?? 1,
    fadeIn: shot.clip?.fadeIn ?? 0,
    fadeOut: shot.clip?.fadeOut ?? 0,
    rotation: shot.clip?.rotation ?? 0,
    textX: shot.visual?.copy.x ?? 10,
    textY: shot.visual?.copy.y ?? 78,
    textSize: shot.visual?.copy.titleSize ?? 3.5,
    textColor: textColorOf(shot),
  };
}

type ClipDraft = ReturnType<typeof formFor>;

const FADE_KEYS = ['fadeIn', 'fadeOut', 'audioFadeIn', 'audioFadeOut'] as const;
/** Draft pose fields: keyed at the playhead when the clip animates them, like every other pose edit. */
const DRAFT_POSE_KEYS = ['x', 'y', 'width', 'opacity', 'rotation'] as const;
const DRAFT_FADE_KEYS = ['fadeIn', 'fadeOut'] as const;

/** Caption cues cut at the end of a clip `duration` seconds long; a cue left empty is dropped. */
function fitCaptions(captions: MovieCaption[], duration: number): MovieCaption[] {
  return captions
    .map(c => (c.end > duration ? { ...c, start: Math.min(c.start, duration), end: duration } : c))
    .filter(c => c.end > c.start);
}

/**
 * Caption cues follow a clip whose output length changed by `factor` to `duration`; float error never puts a
 * cue past the new end.
 */
function scaleCaptions(captions: MovieCaption[], factor: number, duration: number): MovieCaption[] {
  return fitCaptions(captions.map(c => ({ ...c, start: c.start * factor, end: c.end * factor })), duration);
}

/** Fades keep their share of a clip whose output length changed by `factor`, never past its end. */
function scaleFades(clip: MovieClip, factor: number, duration: number): MovieClip {
  const next = { ...clip };
  for (const key of FADE_KEYS) {
    const value = next[key];
    if (value !== undefined) next[key] = Math.min(duration, value * factor);
  }
  return next;
}

/** The edit from `before` to `after`; a picture-fade change keeps the audio fades `after` has set. */
function clipEditOperations(before: MovieShot, after: MovieShot): MovieEditOperation[] {
  return selectionEditOperations(before, after).map(op =>
    (op.op === 'update-clip' && after.clip ? { ...op, changes: movieKeepAudioFades(after.clip, op.changes) } : op));
}

/**
 * A speed change that keeps the clip's source interval: output duration, caption timing and fades
 * scale together, in one batch.
 */
export function movieSpeedOperations(shot: MovieShot, rate: number): MovieEditOperation[] {
  const clip = shot.clip;
  if (!clip || !(rate > 0)) return [];
  const duration = (shot.duration * clip.rate) / rate;
  const factor = duration / shot.duration;
  return clipEditOperations(shot, {
    ...shot,
    duration,
    captions: scaleCaptions(shot.captions ?? [], factor, duration),
    clip: scaleFades({ ...clip, rate }, factor, duration),
  });
}

export interface MovieCompactInspectorProps {
  document: MovieDocument;
  /** In the tabs layout, undefined shows 全片设置; the stack falls back to the first clip. */
  selectedShotId?: string;
  selectionKind?: SelectionKind;
  /** 'stack' (default): fold-away groups; 'tabs': the editor's tabbed panel. */
  layout?: 'stack' | 'tabs';
  busy: boolean;
  readOnly: boolean;
  onApply: MovieApplyEdit;
  onDirtyChange(value: boolean): void;
  onAudioDetached?(id: string): void;
  onProjectSettings?(settings: MovieSettings, aspect: MovieDocument['aspect']): void;
  onTranscribe?(): void;
  time?: number;
  onSeek?(time: number): void;
  /** The project's sources: they tell whether a video has sound and give the filter tiles a frame. */
  sources?: readonly MovieVideoSource[];
  /** Project-relative path → URL, for source frames. */
  assetUrl?(path: string): string;
  /** Tabs layout: open a tab and scroll to a section or caption cue (timeline badges and caption chips). */
  requested?: MovieInspectorRequest | null;
  /** 全片设置 › 导出: open the export settings. */
  onOpenExport?(): void;
  /** 全片设置 › 剪映草稿: create a draft, or edit a copy of an existing one. */
  onOpenJianying?(mode: 'create' | 'edit'): void;
}

/** Everything both layouts read: the selection, its draft, and the shared actions. */
interface InspectorModel {
  zh: boolean;
  document: MovieDocument;
  shot?: MovieShot;
  /** Output start of the selected clip. */
  start: number;
  fps: number;
  selectionKind: SelectionKind;
  /** The audio lane of a video clip: it shares the video's timing until detached. */
  linkedAudio: boolean;
  form: ClipDraft | null;
  patchForm(changes: Partial<ClipDraft>): void;
  captions: MovieCaption[];
  setCaptions(captions: MovieCaption[]): void;
  dirty: boolean;
  /** Busy or read-only: nothing can be edited. */
  locked: boolean;
  error: string;
  setError(message: string): void;
  apply(): Promise<void>;
  cancel(): void;
  detachAudio(): void;
  /** The props every clip section takes; instant controls rest while a draft is pending. */
  sectionFor(shot: MovieShot): ClipSectionProps;
  sourceOf(shot: MovieShot | undefined): MovieVideoSource | undefined;
  /** A still of the clip's source near its in point, for filter tiles. */
  frameOf(shot: MovieShot | undefined): string | undefined;
  props: MovieCompactInspectorProps;
}

function useInspectorModel(props: MovieCompactInspectorProps): InspectorModel {
  const { document: d, selectedShotId, selectionKind = 'video', layout = 'stack', busy, readOnly, onApply, onDirtyChange, onAudioDetached, time = 0, onSeek, sources, assetUrl } = props;
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const shot = layout === 'tabs'
    ? (selectedShotId ? d.shots.find(s => s.id === selectedShotId) : undefined)
    : (d.shots.find(s => s.id === selectedShotId) ?? d.shots[0]);
  const fps = movieFps(d);
  const [form, setForm] = useState(() => (shot ? formFor(shot, fps) : null));
  const [captions, setCaptions] = useState(() => structuredClone(shot?.captions ?? []));
  const [error, setError] = useState('');

  // A new selection, a new document revision (any applied edit, undo or redo) or a new frame rate
  // replaces the draft. It is replaced while rendering, so React re-renders before committing and the
  // stale draft never reaches the dirty report below.
  const draftKey = `${shot?.id ?? ''}:${d.contentRevision}:${fps}`;
  const [formKey, setFormKey] = useState(draftKey);
  if (formKey !== draftKey) {
    setFormKey(draftKey);
    setForm(shot ? formFor(shot, fps) : null);
    setCaptions(structuredClone(shot?.captions ?? []));
    setError('');
  }

  const dirty = Boolean(shot && form && (
    JSON.stringify(form) !== JSON.stringify(formFor(shot, fps))
    || JSON.stringify(captions) !== JSON.stringify(shot.captions ?? [])
  ));
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const locked = busy || readOnly;
  const linkedAudio = selectionKind === 'audio' && Boolean(shot?.clip) && !shot?.clip?.audioOnly;
  const index = shot ? d.shots.findIndex(s => s.id === shot.id) : -1;
  const start = index >= 0 ? movieShotStarts(d)[index] ?? 0 : 0;

  const apply = async () => {
    if (!shot || !form || locked) return;
    const before = formFor(shot, fps);
    let duration = form.duration === before.duration ? shot.duration : parseEditorTimecode(form.duration, fps);
    const sourceIn = form.in === before.in ? shot.clip?.in ?? 0 : parseEditorTimecode(form.in, fps);
    const rate = Number(form.rate);
    if (duration === null || sourceIn === null || !Number.isFinite(rate)) {
      setError(zh ? '时间格式：00:00:00:00，或输入秒数' : 'Use HH:MM:SS:FF or seconds');
      return;
    }
    let nextCaptions = captions;
    // A new speed with an untouched duration keeps the source interval, as the speed chips do.
    if (shot.clip && form.rate !== before.rate && form.duration === before.duration && rate > 0) {
      duration = (shot.duration * shot.clip.rate) / rate;
      nextCaptions = scaleCaptions(captions, duration / shot.duration, duration);
    } else if (duration < shot.duration) {
      // A shorter clip cuts its captions at the new end, as a trim does.
      nextCaptions = fitCaptions(captions, duration);
    }
    const next: MovieShot = { ...shot, title: form.title, duration, captions: nextCaptions };
    if (shot.kind === 'text' && shot.visual) {
      next.visual = {
        ...shot.visual,
        foreground: form.textColor,
        copy: { ...shot.visual.copy, x: form.textX, y: form.textY, titleSize: form.textSize },
      };
    }
    if (shot.clip) {
      const changed = <K extends keyof ClipDraft>(keys: readonly K[]) =>
        Object.fromEntries(keys.filter(key => form[key] !== before[key]).map(key => [key, form[key]]));
      next.clip = {
        ...shot.clip,
        in: sourceIn,
        rate,
        volume: form.volume === before.volume ? shot.clip.volume : form.volume / 100,
        fit: form.fit as MovieClip['fit'],
        ...changed(DRAFT_FADE_KEYS),
        ...movieClipPoseChanges(shot.clip, changed(DRAFT_POSE_KEYS), clipPlayhead(d, shot, time, start)),
      };
      if (duration !== shot.duration) next.clip = scaleFades(next.clip, duration / shot.duration, duration);
    }
    if (await onApply(zh ? '调整片段' : 'Edit clip', clipEditOperations(shot, next))) setError('');
  };

  const cancel = () => {
    if (!shot) return;
    setForm(formFor(shot, fps));
    setCaptions(structuredClone(shot.captions ?? []));
  };

  const detachAudio = () => {
    if (!shot) return;
    const id = crypto.randomUUID();
    const track = Math.min(7, 1 + Math.max(0, ...d.shots.map(s => s.placement?.track ?? 0)));
    void onApply(zh ? '分离音频' : 'Detach audio', [
      { op: 'duplicate-clip', shotId: shot.id, newShotId: id, at: start, track },
      { op: 'update-clip', shotId: id, changes: { audioOnly: true, muted: false } },
      { op: 'replace-captions', shotId: id, captions: [] },
      { op: 'update-clip', shotId: shot.id, changes: { muted: true } },
    ]).then(ok => {
      if (ok) onAudioDetached?.(id);
    });
  };

  const sourceOf = (target: MovieShot | undefined) => {
    const clip = target?.clip;
    return clip ? sources?.find(source => source.assetId === clip.assetId) : undefined;
  };

  const frameOf = (target: MovieShot | undefined) => {
    const frames = sourceOf(target)?.frames ?? [];
    const at = target?.clip?.in ?? 0;
    const nearest = frames.reduce<(typeof frames)[number] | undefined>(
      (best, frame) => (!best || Math.abs(frame.time - at) < Math.abs(best.time - at) ? frame : best),
      undefined,
    );
    return nearest && assetUrl ? assetUrl(nearest.path) : undefined;
  };

  return {
    zh,
    document: d,
    shot,
    start,
    fps,
    selectionKind,
    linkedAudio,
    form,
    patchForm: changes => setForm(current => (current ? { ...current, ...changes } : current)),
    captions,
    setCaptions,
    dirty,
    locked,
    error,
    setError,
    apply,
    cancel,
    detachAudio,
    sectionFor: target => ({ document: d, shot: target, disabled: locked || dirty, zh, onApply, time, start, onSeek }),
    sourceOf,
    frameOf,
    props,
  };
}

export function MovieCompactInspector(props: MovieCompactInspectorProps) {
  const model = useInspectorModel(props);
  return props.layout === 'tabs' ? <TabsInspector m={model} /> : <StackInspector m={model} />;
}

/* ------------------------------------------------------------------------------------------------
 * Shared pieces
 * ---------------------------------------------------------------------------------------------- */

/** One draft text field; Enter applies the draft. */
function DraftRow({ label, value, disabled, numeric, onChange, onSubmit }: {
  label: string;
  value: string;
  disabled: boolean;
  numeric?: boolean;
  onChange(value: string): void;
  onSubmit(): void;
}) {
  const id = useId();
  return (
    <label className={styles.row} htmlFor={id}>
      <span className={styles.rowLabel}>{label}</span>
      <Input
        id={id}
        inputSize="sm"
        className={cn(styles.control, numeric && styles.numeric)}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onSubmit();
        }}
      />
    </label>
  );
}

/** One draft number of the compact stack. */
function DraftNumberRow({ label, value, disabled, min, max, step, onChange }: {
  label: string;
  value: number;
  disabled: boolean;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <Input
        inputSize="sm"
        className={cn(styles.control, styles.numeric)}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Name, duration and source in: the draft every clip has. */
function DraftBasics({ m, titleLabel, sourceIn }: { m: InspectorModel; titleLabel: string; sourceIn: boolean }) {
  const { zh, form, locked, linkedAudio } = m;
  if (!form) return null;
  const submit = () => void m.apply();
  return (
    <>
      <DraftRow label={titleLabel} value={form.title} disabled={locked} onChange={title => m.patchForm({ title })} onSubmit={submit} />
      <DraftRow label={zh ? '时长' : 'Duration'} numeric value={form.duration} disabled={locked || linkedAudio} onChange={duration => m.patchForm({ duration })} onSubmit={submit} />
      {sourceIn ? (
        <DraftRow label={zh ? '源片入点' : 'Source in'} numeric value={form.in} disabled={locked || linkedAudio} onChange={value => m.patchForm({ in: value })} onSubmit={submit} />
      ) : null}
    </>
  );
}

function Notice({ tone, icon, children, action }: { tone: 'warning' | 'info'; icon: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.notice} data-tone={tone}>
      <Icon icon={icon} size="sm" className={styles.noticeIcon} />
      <span className={styles.noticeText}>{children}</span>
      {action}
    </div>
  );
}

function LockedNotice({ zh }: { zh: boolean }) {
  return (
    <Notice tone="warning" icon={Lock}>
      {zh ? '此片段已锁定，AI 和人工编辑都会保留它。可在时间线解锁。' : 'This clip is locked for manual and AI edits. Unlock it on the timeline.'}
    </Notice>
  );
}

function LinkedAudioNotice({ m }: { m: InspectorModel }) {
  const { zh } = m;
  return (
    <Notice
      tone="info"
      icon={Link2}
      action={(
        <Button size="sm" variant="ghost" disabled={m.locked || (m.props.layout === 'tabs' && m.dirty)} onClick={m.detachAudio}>
          {zh ? '分离音频' : 'Detach audio'}
        </Button>
      )}
    >
      {zh ? '与视频关联' : 'Linked to video'}
    </Notice>
  );
}

function ApplyBar({ m, sticky }: { m: InspectorModel; sticky?: boolean }) {
  const { zh } = m;
  return (
    <div className={sticky ? styles.applyBar : styles.actions}>
      {sticky ? <span className={styles.applyHint}>{zh ? '有未应用的修改' : 'Unapplied changes'}</span> : null}
      <Button size="sm" variant="ghost" disabled={m.locked} onClick={m.cancel}>{zh ? '取消' : 'Cancel'}</Button>
      <Button size="sm" variant="primary" disabled={m.locked} onClick={() => void m.apply()}>{zh ? '应用' : 'Apply'}</Button>
    </div>
  );
}

/** "应用到全部": one batch over every target, with how many clips it changes; never split past the edit limit. */
function ApplyToAll({ m, count, empty, label, operations }: {
  m: InspectorModel;
  count: number;
  /** Shown when there is nothing to change. */
  empty: string;
  label: string;
  /** Undefined until a choice is made. */
  operations?: MovieEditOperation[];
}) {
  const { zh } = m;
  const tooMany = movieApplyAllBlocked(count, zh);
  return (
    <div className={styles.applyAll}>
      <span className={styles.hint}>{count ? (zh ? `将修改 ${count} 个片段` : `Changes ${count} ${count === 1 ? 'clip' : 'clips'}`) : empty}</span>
      <Button
        size="sm"
        disabled={m.locked || m.dirty || !count || !operations || Boolean(tooMany)}
        disabledReason={tooMany}
        onClick={() => { if (operations) void m.props.onApply(label, operations); }}
      >
        {zh ? '应用到全部' : 'Apply to all'}
      </Button>
    </div>
  );
}

function ProjectFacts({ document: d, zh }: { document: MovieDocument; zh: boolean }) {
  const fps = movieFps(d);
  const size = movieFrameSize(d);
  const facts: Array<[string, string]> = [
    [zh ? '名称' : 'Name', d.title],
    [zh ? '时长' : 'Duration', editorTimecode(movieDuration(d), fps)],
    [zh ? '分辨率' : 'Resolution', `${size.width} × ${size.height}`],
    [zh ? '帧率' : 'Frame rate', `${fpsLabel(fps)} fps`],
    [zh ? '比例' : 'Aspect ratio', d.aspect],
    [zh ? '片段数' : 'Clips', String(d.shots.length)],
  ];
  return <Facts items={facts} />;
}

function Facts({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className={styles.facts}>
      {items.map(([label, value]) => (
        <Fragment key={label}>
          <dt className={styles.factLabel}>{label}</dt>
          <dd className={styles.factValue} title={value}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const fpsLabel = (fps: number) => String(Number(fps.toFixed(3)));

const ASPECTS: Array<MovieDocument['aspect']> = ['16:9', '9:16', '1:1'];
const FRAME_RATES = [24, 25, 30, 30000 / 1001, 60];

function aspectSize(aspect: MovieDocument['aspect']): { width: number; height: number } {
  if (aspect === '9:16') return { width: 1080, height: 1920 };
  if (aspect === '1:1') return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

/** The canvas as a segmented choice, each with a frame glyph of its shape. */
function AspectSegmented({ m, size }: { m: InspectorModel; size: 'sm' | 'md' }) {
  const { zh, document: d } = m;
  const { onProjectSettings } = m.props;
  const frameRate = d.settings?.frameRate ?? { numerator: 30, denominator: 1 };
  return (
    <Segmented
      size={size}
      className={styles.segmented}
      aria-label={zh ? '项目画幅' : 'Project aspect'}
      value={d.aspect}
      disabled={m.locked || m.dirty || !onProjectSettings}
      onValueChange={value => {
        const aspect = value as MovieDocument['aspect'];
        onProjectSettings?.({ ...aspectSize(aspect), frameRate }, aspect);
      }}
    >
      {ASPECTS.map(aspect => (
        <SegmentedItem key={aspect} className={styles.segmentedItem} value={aspect}>
          <span className={styles.aspectGlyph} data-aspect={aspect} aria-hidden="true" />
          {aspect}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

function FrameRateSelect({ m }: { m: InspectorModel }) {
  const { zh, document: d, fps } = m;
  const { onProjectSettings } = m.props;
  const rates = FRAME_RATES.some(rate => Math.abs(rate - fps) < 1e-6) ? FRAME_RATES : [...FRAME_RATES, fps].sort((a, b) => a - b);
  return (
    <Select
      value={String(rates.find(rate => Math.abs(rate - fps) < 1e-6) ?? fps)}
      disabled={m.locked || m.dirty || !onProjectSettings}
      onValueChange={value => {
        const rate = Number(value);
        const next = Math.abs(rate - 30000 / 1001) < 1e-9 ? { numerator: 30000, denominator: 1001 } : { numerator: rate, denominator: 1 };
        onProjectSettings?.({ ...movieFrameSize(d), frameRate: next }, d.aspect);
      }}
    >
      <SelectTrigger size="sm" className={styles.select} aria-label={zh ? '项目帧率' : 'Project frame rate'}><SelectValue /></SelectTrigger>
      <SelectContent>
        {rates.map(rate => <SelectItem key={rate} value={String(rate)}>{fpsLabel(rate)} fps</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const ALIGNMENTS: Array<{ value: MovieCaptionStyle['align']; icon: LucideIcon; zh: string; en: string }> = [
  { value: 'left', icon: AlignLeft, zh: '左对齐', en: 'Align left' },
  { value: 'center', icon: AlignCenter, zh: '居中', en: 'Center' },
  { value: 'right', icon: AlignRight, zh: '右对齐', en: 'Align right' },
];

function AlignmentRow({ zh, label, value, disabled, onChange }: {
  zh: boolean;
  label: string;
  value: MovieCaptionStyle['align'];
  disabled: boolean;
  onChange(value: MovieCaptionStyle['align']): void;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{zh ? '对齐' : 'Align'}</span>
      <Segmented size="sm" className={styles.segmented} aria-label={label} value={value} disabled={disabled} onValueChange={next => onChange(next as MovieCaptionStyle['align'])}>
        {ALIGNMENTS.map(item => (
          <SegmentedItem key={item.value} className={styles.segmentedItem} value={item.value} aria-label={zh ? item.zh : item.en}>
            <Icon icon={item.icon} size="sm" />
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}

type CaptionLook = MovieCaptionStylePreset['style'];

const captionLook = ({ fontSize, color, background, backgroundOpacity, outline }: MovieCaptionStyle): CaptionLook => ({ fontSize, color, background, backgroundOpacity, outline });

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** A caption look drawn small: its colour, box and outline over a dark sample stage. */
function captionSampleStyle(style: CaptionLook): CSSProperties {
  const look = { ...MOVIE_DEFAULT_CAPTION_STYLE, ...style };
  return {
    color: look.color,
    background: look.backgroundOpacity > 0 ? rgba(look.background, look.backgroundOpacity) : 'transparent',
    textShadow: look.outline ? `0 0 ${Math.max(1, look.outline / 1.5)}px rgba(0, 0, 0, .95), 0 0 1px rgba(0, 0, 0, .95)` : undefined,
    fontSize: `${Math.round(Math.min(15, Math.max(10, look.fontSize / 4)))}px`,
  };
}

function CaptionStyleTiles({ zh, active, disabled, onPick }: {
  zh: boolean;
  active?: string;
  disabled: boolean;
  onPick(preset: MovieCaptionStylePreset): void;
}) {
  return (
    <div className={styles.styleGrid} role="group" aria-label={zh ? '字幕样式' : 'Caption styles'}>
      {MOVIE_CAPTION_STYLE_PRESETS.map(preset => (
        <button key={preset.id} type="button" className={styles.styleTile} aria-pressed={active === preset.id} disabled={disabled} onClick={() => onPick(preset)}>
          <span className={styles.styleStage} aria-hidden="true">
            <span className={styles.styleSample} style={captionSampleStyle(preset.style)}>{zh ? '字幕' : 'Aa'}</span>
          </span>
          <span className={styles.tileLabel}>{zh ? preset.name.zh : preset.name.en}</span>
        </button>
      ))}
    </div>
  );
}

/** Caption look of the selected clip; each change is one edit, and 应用到全部 copies it to every captioned clip. */
function CaptionTypography({ m, shot }: { m: InspectorModel; shot: MovieShot }) {
  const { zh } = m;
  const style = movieCaptionStyle(shot);
  const disabled = m.locked || m.dirty;
  const setStyle = (changes: Partial<MovieCaptionStyle>) =>
    m.props.onApply(zh ? '调整字幕样式' : 'Style captions', [{ op: 'update-shot', shotId: shot.id, changes: { captionStyle: { ...style, ...changes } } }]);
  const others = movieCaptionTargets(m.document).filter(target => target.id !== shot.id);
  const current: MovieCaptionStylePreset = { id: 'current', name: { zh: '当前样式', en: 'Current style' }, style: captionLook(style) };
  const defaults = MOVIE_DEFAULT_CAPTION_STYLE;
  return (
    <>
      <CaptionStyleTiles zh={zh} active={movieCaptionStylePresetFor(style)?.id} disabled={disabled} onPick={preset => void setStyle(preset.style)} />
      <AlignmentRow zh={zh} label={zh ? '字幕对齐' : 'Caption alignment'} value={style.align} disabled={disabled} onChange={align => void setStyle({ align })} />
      <InspectorSliderField label={zh ? '字号' : 'Font size'} value={style.fontSize} min={12} max={160} resetValue={defaults.fontSize} disabled={disabled} onCommit={fontSize => setStyle({ fontSize })} />
      <InspectorSliderField label={zh ? '垂直位置' : 'Position Y'} unit="%" value={style.y} min={0} max={95} resetValue={defaults.y} disabled={disabled} onCommit={y => setStyle({ y })} />
      <InspectorSliderField
        label={zh ? '底色强度' : 'Background'}
        unit="%"
        value={style.backgroundOpacity * 100}
        min={0}
        max={100}
        resetValue={defaults.backgroundOpacity * 100}
        disabled={disabled}
        onCommit={value => setStyle({ backgroundOpacity: value / 100 })}
      />
      <InspectorSliderField label={zh ? '描边' : 'Outline'} unit="px" value={style.outline} min={0} max={6} resetValue={defaults.outline} disabled={disabled} onCommit={outline => setStyle({ outline })} />
      <InspectorColorField label={zh ? '文字颜色' : 'Text color'} value={style.color} disabled={disabled} onCommit={color => setStyle({ color })} />
      <InspectorColorField label={zh ? '底色' : 'Background color'} value={style.background} disabled={disabled} onCommit={background => setStyle({ background })} />
      <ApplyToAll
        m={m}
        count={others.length}
        empty={zh ? '没有其他带字幕的片段' : 'No other clip has captions'}
        label={zh ? '统一字幕样式' : 'Style all captions'}
        operations={movieCaptionStyleOperations(others, current)}
      />
    </>
  );
}

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

/** The selected clip's caption cues as a draft, plus transcription and SRT import/export. */
function CaptionsEditor({ m, shot }: { m: InspectorModel; shot: MovieShot }) {
  const { zh, captions, locked, dirty } = m;
  const { onApply, onTranscribe, onSeek, time } = m.props;
  const fileInput = useRef<HTMLInputElement>(null);

  const importFile = async (file: File) => {
    try {
      if (file.size > MAX_SUBTITLE_BYTES) throw new Error(zh ? '字幕文件须小于 2 MiB' : 'Subtitle file must be under 2 MiB');
      const cues = parseMovieSubtitles(await file.text(), shot.duration);
      await onApply(zh ? '导入所选片段字幕' : 'Import clip subtitles', [{ op: 'replace-captions', shotId: shot.id, captions: cues }]);
      m.setError('');
    } catch (cause) {
      m.setError((cause as Error).message);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([movieSubtitlesText(captions)], { type: 'application/x-subrip;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'captions.srt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const update = (index: number, changes: Partial<MovieCaption>) =>
    m.setCaptions(captions.map((caption, i) => (i === index ? { ...caption, ...changes } : caption)));
  const lastEnd = captions.at(-1)?.end ?? 0;
  const add = () => m.setCaptions([...captions, { id: crypto.randomUUID(), start: lastEnd, end: Math.min(shot.duration, lastEnd + 2), text: '' }]);
  const local = time === undefined ? undefined : time - m.start;

  return (
    <>
      <div className={styles.chips}>
        {shot.clip && onTranscribe ? (
          <Button size="sm" disabled={locked || dirty} onClick={onTranscribe}>{zh ? '从原声生成字幕' : 'Transcribe captions'}</Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={locked || dirty} onClick={() => fileInput.current?.click()}>{zh ? '导入 SRT' : 'Import SRT'}</Button>
        <Button size="sm" variant="ghost" disabled={!captions.length} onClick={download}>{zh ? '下载 SRT' : 'Download SRT'}</Button>
      </div>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".srt,text/plain"
        onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
      <InspectorHint>{zh ? 'SRT 时间相对于所选片段起点。' : 'SRT times start at the beginning of the selected clip.'}</InspectorHint>
      {captions.length ? (
        <div className={styles.captionList}>
          {captions.map((caption, index) => (
            <CaptionCard
              key={caption.id ?? index}
              caption={caption}
              index={index}
              zh={zh}
              disabled={locked}
              playing={local !== undefined && local >= caption.start && local < caption.end}
              onChange={changes => update(index, changes)}
              onRemove={() => m.setCaptions(captions.filter((_, i) => i !== index))}
              onSeek={onSeek ? () => onSeek(m.start + caption.start) : undefined}
            />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>{zh ? '当前片段没有字幕' : 'No captions in this clip'}</p>
      )}
      <div className={styles.chips}>
        <Button size="sm" variant="ghost" disabled={locked || lastEnd >= shot.duration} onClick={add}>
          <Icon icon={Plus} size="sm" />
          {zh ? '添加字幕' : 'Add caption'}
        </Button>
      </div>
    </>
  );
}

function CaptionCard({ caption, index, zh, disabled, playing, onChange, onRemove, onSeek }: {
  caption: MovieCaption;
  index: number;
  zh: boolean;
  disabled: boolean;
  /** The playhead is inside this cue. */
  playing: boolean;
  onChange(changes: Partial<MovieCaption>): void;
  onRemove(): void;
  onSeek?(): void;
}) {
  const n = index + 1;
  return (
    <div className={styles.caption} data-playing={playing || undefined}>
      <div className={styles.captionHead}>
        {onSeek ? (
          <button type="button" className={styles.captionIndex} aria-label={zh ? `跳到字幕 ${n}` : `Go to caption ${n}`} onClick={onSeek}>{n}</button>
        ) : (
          <span className={styles.captionIndex}>{n}</span>
        )}
        {(['start', 'end'] as const).map(key => (
          <Input
            key={key}
            inputSize="sm"
            className={cn(styles.control, styles.numeric, styles.captionTime)}
            type="number"
            min={0}
            step={1 / 30}
            aria-label={`${zh ? (key === 'start' ? '字幕开始' : '字幕结束') : key} ${n}`}
            value={caption[key]}
            disabled={disabled}
            onChange={e => onChange({ [key]: Number(e.target.value) })}
          />
        ))}
        <IconButton size="xs" aria-label={`${zh ? '删除字幕' : 'Remove caption'} ${n}`} disabled={disabled} onClick={onRemove}>
          <Icon icon={Trash2} size="sm" />
        </IconButton>
      </div>
      <Textarea
        aria-label={`${zh ? '字幕' : 'Caption'} ${n}`}
        rows={2}
        className={styles.captionText}
        data-cue={caption.id}
        value={caption.text}
        disabled={disabled}
        onChange={e => onChange({ text: e.target.value })}
      />
    </div>
  );
}

const TEXT_ENTRANCES: Array<{ value: NonNullable<MovieShot['textAnimation']>; zh: string; en: string; motion: InspectorTileMotion }> = [
  { value: 'none', zh: '直接出现', en: 'None', motion: 'text-none' },
  { value: 'fade', zh: '淡入', en: 'Fade', motion: 'text-fade' },
  { value: 'rise', zh: '向上进入', en: 'Rise', motion: 'text-rise' },
  { value: 'slide', zh: '从左进入', en: 'Slide', motion: 'text-slide' },
  { value: 'typewriter', zh: '逐字出现', en: 'Typewriter', motion: 'text-type' },
];

const setTextAnimation = (m: InspectorModel, shot: MovieShot, textAnimation: MovieShot['textAnimation']) =>
  m.props.onApply(m.zh ? '文字入场动画' : 'Animate text', [{ op: 'update-shot', shotId: shot.id, changes: { textAnimation } }]);

/* ------------------------------------------------------------------------------------------------
 * Stack layout (compact pane)
 * ---------------------------------------------------------------------------------------------- */

function StackInspector({ m }: { m: InspectorModel }) {
  const { zh, document: d, shot, form, captions, locked, dirty, error, selectionKind } = m;
  const { onProjectSettings, time = 0, onSeek, onApply } = m.props;
  return (
    <div className={styles.stack}>
      {shot?.locked ? <LockedNotice zh={zh} /> : null}
      <InspectorDisclosure label={zh ? '项目' : 'Project'}>
        <ProjectFacts document={d} zh={zh} />
      </InspectorDisclosure>
      {shot && form ? (
        <InspectorDisclosure defaultOpen label={selectionKind === 'audio' ? (zh ? '音频片段' : 'Audio clip') : (zh ? '所选片段' : 'Selected clip')}>
          <StackClipFields m={m} shot={shot} form={form} />
        </InspectorDisclosure>
      ) : (
        <p className={styles.empty}>{zh ? '在时间线上选择片段' : 'Select a timeline clip'}</p>
      )}
      {shot?.clip && form ? (
        <InspectorDisclosure label={zh ? '淡入淡出' : 'Fades'}>
          {DRAFT_FADE_KEYS.map(key => (
            <DraftNumberRow
              key={key}
              label={key === 'fadeIn' ? (zh ? '淡入 秒' : 'Fade in (s)') : (zh ? '淡出 秒' : 'Fade out (s)')}
              value={form[key]}
              min={0}
              max={shot.duration}
              step={0.1}
              disabled={locked}
              onChange={value => m.patchForm({ [key]: value })}
            />
          ))}
        </InspectorDisclosure>
      ) : null}
      {selectionKind !== 'audio' && shot?.clip && form ? (
        <InspectorDisclosure label={zh ? '变换与叠加' : 'Transform'}>
          {(['x', 'y', 'width', 'opacity'] as const).map(key => (
            <DraftNumberRow
              key={key}
              label={{ x: zh ? '水平位置 %' : 'X %', y: zh ? '垂直位置 %' : 'Y %', width: zh ? '缩放 %' : 'Scale %', opacity: zh ? '不透明度 %' : 'Opacity %' }[key]}
              value={key === 'opacity' ? form.opacity * 100 : form[key]}
              disabled={locked}
              onChange={value => m.patchForm({ [key]: key === 'opacity' ? value / 100 : value })}
            />
          ))}
        </InspectorDisclosure>
      ) : null}
      {shot && selectionKind !== 'audio' ? (
        <InspectorDisclosure label={`${zh ? '字幕' : 'Captions'} · ${captions.length}`}>
          <CaptionsEditor m={m} shot={shot} />
        </InspectorDisclosure>
      ) : null}
      {shot && selectionKind !== 'audio' ? (
        <InspectorDisclosure label={zh ? '字幕排版与样式' : 'Caption typography'}>
          <CaptionTypography m={m} shot={shot} />
        </InspectorDisclosure>
      ) : null}
      {shot?.clip ? <MovieAdvancedInspector document={d} shot={shot} time={time} disabled={locked || dirty} zh={zh} onApply={onApply} onSeek={onSeek} /> : null}
      {onProjectSettings ? (
        <InspectorDisclosure label={zh ? '画幅与帧率' : 'Canvas and frame rate'}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{zh ? '画幅' : 'Canvas'}</span>
            <AspectSegmented m={m} size="sm" />
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{zh ? '帧率' : 'Frame rate'}</span>
            <FrameRateSelect m={m} />
          </div>
        </InspectorDisclosure>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {dirty ? <ApplyBar m={m} /> : null}
    </div>
  );
}

/** The selected clip's draft in the compact stack, as it has always been laid out. */
function StackClipFields({ m, shot, form }: { m: InspectorModel; shot: MovieShot; form: ClipDraft }) {
  const { zh, locked, dirty, linkedAudio, selectionKind } = m;
  const volumeId = useId();
  const text = shot.kind === 'text';
  const submit = () => void m.apply();
  const timing = (label: string, key: 'duration' | 'in' | 'rate') => (
    <DraftRow label={label} numeric value={form[key]} disabled={locked || linkedAudio} onChange={value => m.patchForm({ [key]: value })} onSubmit={submit} />
  );
  return (
    <>
      {linkedAudio ? <LinkedAudioNotice m={m} /> : null}
      <DraftRow label={text ? (zh ? '文字内容' : 'Text') : (zh ? '名称' : 'Name')} value={form.title} disabled={locked} onChange={title => m.patchForm({ title })} onSubmit={submit} />
      {text ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{zh ? '文字入场' : 'Text entrance'}</span>
          <Select value={shot.textAnimation ?? 'none'} disabled={locked || dirty} onValueChange={value => void setTextAnimation(m, shot, value as MovieShot['textAnimation'])}>
            <SelectTrigger size="sm" className={styles.select} aria-label={zh ? '文字入场' : 'Text entrance'}><SelectValue /></SelectTrigger>
            <SelectContent>
              {TEXT_ENTRANCES.map(item => <SelectItem key={item.value} value={item.value}>{zh ? item.zh : item.en}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {text ? (
        <label className={styles.row}>
          <span className={styles.rowLabel}>{zh ? '文字颜色' : 'Text color'}</span>
          <span className={styles.colorValue}>
            <input
              className={styles.colorPicker}
              aria-label={zh ? '文字颜色' : 'Text color'}
              type="color"
              value={form.textColor}
              disabled={locked}
              onChange={e => m.patchForm({ textColor: e.target.value })}
            />
            <span className={styles.hex}>{form.textColor.toUpperCase()}</span>
          </span>
        </label>
      ) : null}
      {timing(zh ? '时长' : 'Duration', 'duration')}
      {text ? (['textX', 'textY', 'textSize'] as const).map(key => (
        <DraftNumberRow
          key={key}
          label={{ textX: zh ? '水平位置 %' : 'X %', textY: zh ? '垂直位置 %' : 'Y %', textSize: zh ? '字号 %' : 'Font size %' }[key]}
          value={form[key]}
          step={0.1}
          disabled={locked}
          onChange={value => m.patchForm({ [key]: value })}
        />
      )) : null}
      {shot.clip ? (
        <>
          {timing(zh ? '源片入点' : 'Source in', 'in')}
          {timing(zh ? '速度' : 'Speed', 'rate')}
          <label className={styles.row} htmlFor={volumeId}>
            <span className={styles.rowLabel}>{zh ? '音量' : 'Volume'}</span>
            <span className={styles.volume}>
              <input
                id={volumeId}
                className={styles.range}
                aria-label={zh ? '音量' : 'Volume'}
                type="range"
                min={0}
                max={100}
                disabled={locked}
                value={form.volume}
                style={{ '--slider-fill': `${form.volume}%` } as CSSProperties}
                onChange={e => m.patchForm({ volume: Number(e.target.value) })}
              />
              <output className={styles.volumeValue}>{form.volume}%</output>
            </span>
          </label>
          {selectionKind !== 'audio' ? (
            <div className={styles.row}>
              <span className={styles.rowLabel}>{zh ? '画面' : 'Frame'}</span>
              <Select value={form.fit} disabled={locked} onValueChange={fit => m.patchForm({ fit: fit as MovieClip['fit'] })}>
                <SelectTrigger size="sm" className={styles.select} aria-label={zh ? '画面适配' : 'Picture fit'}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contain">{zh ? '适合' : 'Fit'}</SelectItem>
                  <SelectItem value="cover">{zh ? '填充' : 'Fill'}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Tabs layout
 * ---------------------------------------------------------------------------------------------- */

type InspectorTab = 'video' | 'basic' | 'audio' | 'speed' | 'animation' | 'adjust' | 'captions' | 'text';
/** What kind of thing is selected; each remembers its own last tab. */
type SelectionType = 'video' | 'image' | 'audio' | 'linkedAudio' | 'text';

const TAB_LABELS: Record<InspectorTab, { zh: string; en: string }> = {
  video: { zh: '画面', en: 'Video' },
  basic: { zh: '基础', en: 'Basics' },
  audio: { zh: '音频', en: 'Audio' },
  speed: { zh: '变速', en: 'Speed' },
  animation: { zh: '动画', en: 'Animation' },
  adjust: { zh: '调节', en: 'Adjust' },
  captions: { zh: '字幕', en: 'Captions' },
  text: { zh: '文本', en: 'Text' },
};

const TABS_BY_TYPE: Record<SelectionType, InspectorTab[]> = {
  video: ['video', 'audio', 'speed', 'animation', 'adjust', 'captions'],
  image: ['video', 'animation', 'adjust', 'captions'],
  audio: ['basic', 'audio', 'speed'],
  linkedAudio: ['audio'],
  text: ['text', 'animation'],
};

function selectionType(m: InspectorModel, shot: MovieShot): SelectionType {
  if (shot.kind === 'text') return 'text';
  if (!shot.clip) return 'video';
  if (m.linkedAudio) return 'linkedAudio';
  if (m.selectionKind === 'audio' || shot.clip.audioOnly) return 'audio';
  if (movieShotIsImage(m.document, shot) || m.sourceOf(shot)?.kind === 'image') return 'image';
  return 'video';
}

/** The tabs a selection offers, CapCut-style: what can be changed about this kind of clip. */
function inspectorTabs(m: InspectorModel, shot: MovieShot, type: SelectionType): InspectorTab[] {
  if (type === 'video' && !shot.clip) return ['basic', 'captions'];
  if (type === 'video' && m.sourceOf(shot)?.hasAudio === false) return TABS_BY_TYPE.video.filter(tab => tab !== 'audio');
  return TABS_BY_TYPE[type];
}

const withoutItem = (set: ReadonlySet<string>, item: string): ReadonlySet<string> => {
  const next = new Set(set);
  next.delete(item);
  return next;
};

/** Requests already honoured or dropped, so a remounted inspector (the COMPACT popover) does not replay one. */
const settledRequests = new WeakSet<MovieInspectorRequest>();

/**
 * Hands a timeline request to `open` once its tab is offered. The selection it targets may land in the
 * same render or the next; a request the new selection cannot honour is dropped.
 */
function useInspectorRequest(requested: MovieInspectorRequest | null | undefined, shotId: string | undefined, tabs: readonly InspectorTab[], open: (request: MovieInspectorRequest) => void) {
  const pending = useRef<{ request: MovieInspectorRequest; shotId?: string } | null>(null);
  useEffect(() => {
    if (requested && !settledRequests.has(requested)) pending.current = { request: requested, shotId };
  }, [requested]);
  useEffect(() => {
    const current = pending.current;
    if (!current) return;
    if (tabs.includes(current.request.tab)) open(current.request);
    else if (current.shotId === shotId) return;
    pending.current = null;
    settledRequests.add(current.request);
  });
}

/** Scrolls a requested caption cue or section into view and focuses it (a section's chosen or first control). */
function revealRequest(root: HTMLElement, request: MovieInspectorRequest) {
  if (request.cueId) {
    const cue = [...root.querySelectorAll<HTMLElement>('[data-cue]')].find(element => element.dataset.cue === request.cueId);
    cue?.scrollIntoView?.({ block: 'center' });
    cue?.focus({ preventScroll: true });
    return;
  }
  const section = request.section ? root.querySelector<HTMLElement>(`[data-section="${request.section}"]`) : null;
  if (!section) return;
  section.scrollIntoView?.({ block: 'start' });
  const body = section.querySelector<HTMLElement>('[data-section-body]');
  const control = body?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? body?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)');
  control?.focus({ preventScroll: true });
}

function TabsInspector({ m }: { m: InspectorModel }) {
  const { shot } = m;
  const [lastTab, setLastTab] = useState<Partial<Record<SelectionType, InspectorTab>>>({});
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [reveal, setReveal] = useState<MovieInspectorRequest | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const type = shot ? selectionType(m, shot) : undefined;
  const tabs = shot && type ? inspectorTabs(m, shot, type) : [];
  const remembered = type ? lastTab[type] : undefined;
  const active = remembered && tabs.includes(remembered) ? remembered : tabs[0];
  const choose = (tab: InspectorTab) => {
    if (type) setLastTab(current => ({ ...current, [type]: tab }));
  };

  useInspectorRequest(m.props.requested, shot?.id, tabs, request => {
    choose(request.tab);
    const section = request.cueId ? 'captions' : request.section;
    if (section) setFolded(current => withoutItem(current, section));
    setReveal(request);
  });

  useEffect(() => {
    if (reveal && root.current) revealRequest(root.current, reveal);
  }, [reveal]);

  const folds = useMemo<InspectorFolds>(() => ({
    folded: name => folded.has(name),
    toggle: name => setFolded(current => (current.has(name) ? withoutItem(current, name) : new Set(current).add(name))),
  }), [folded]);

  return (
    <div ref={root} className={styles.inspector}>
      <InspectorFoldContext.Provider value={folds}>
        {shot && active ? <ClipTabs m={m} shot={shot} tabs={tabs} active={active} onChoose={choose} /> : <ProjectSettings m={m} />}
      </InspectorFoldContext.Provider>
    </div>
  );
}

function ClipTabs({ m, shot, tabs, active, onChoose }: {
  m: InspectorModel;
  shot: MovieShot;
  tabs: readonly InspectorTab[];
  active: InspectorTab;
  onChoose(tab: InspectorTab): void;
}) {
  const { zh, error, dirty } = m;
  return (
    <Tabs className={styles.tabs} value={active} onValueChange={value => onChoose(value as InspectorTab)}>
      <div className={styles.tabBar}>
        <TabsList variant="line" className={styles.tabList} aria-label={zh ? '检查器' : 'Inspector'}>
          {tabs.map(value => (
            <TabsTrigger key={value} value={value} className={styles.tabTrigger}>
              {zh ? TAB_LABELS[value].zh : TAB_LABELS[value].en}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className={styles.tabBody}>
        {shot.locked || m.linkedAudio ? (
          <div className={styles.notices}>
            {shot.locked ? <LockedNotice zh={zh} /> : null}
            {m.linkedAudio ? <LinkedAudioNotice m={m} /> : null}
          </div>
        ) : null}
        {/* Only the active panel, keyed: it mounts with its content (so a requested cue or section is
            there to reveal in the same commit) and replays the tab fade. */}
        <TabsContent key={active} value={active} className={styles.tabPanel}>
          <ClipPanel tab={active} m={m} shot={shot} />
        </TabsContent>
      </div>
      {error || dirty ? (
        <div className={styles.footer}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {dirty ? <ApplyBar m={m} sticky /> : null}
        </div>
      ) : null}
    </Tabs>
  );
}

/* ---- 全片设置 ---- */

type ProjectPage = 'aspect' | 'frameRate' | 'captionStyle' | 'transitions' | 'filters' | 'jianying';

const PAGE_TITLES: Record<ProjectPage, { zh: string; en: string }> = {
  aspect: { zh: '画幅', en: 'Canvas' },
  frameRate: { zh: '帧率', en: 'Frame rate' },
  captionStyle: { zh: '字幕样式', en: 'Caption style' },
  transitions: { zh: '转场', en: 'Transitions' },
  filters: { zh: '滤镜', en: 'Filters' },
  jianying: { zh: '剪映草稿', en: 'Jianying draft' },
};

/** The value every item shares, or undefined when they differ or there are none. */
function shared<T, V>(items: readonly T[], value: (item: T) => V): V | undefined {
  const values = new Set(items.map(value));
  return values.size === 1 ? [...values][0] : undefined;
}

function captionSummary(d: MovieDocument, zh: boolean): string {
  const targets = movieCaptionTargets(d);
  if (!targets.length) return zh ? '暂无字幕' : 'No captions';
  if (!shared(targets, shot => JSON.stringify(captionLook(movieCaptionStyle(shot))))) return zh ? '多种样式' : 'Mixed';
  const style = movieCaptionStyle(targets[0]!);
  const preset = movieCaptionStylePresetFor(style);
  return `${preset ? (zh ? preset.name.zh : preset.name.en) : (zh ? '自定义' : 'Custom')} · ${style.fontSize}`;
}

const filterIdOf = (shot: MovieShot) => (shot.clip ? movieFilterPresetFor(movieClipColor(shot.clip))?.id : undefined);

function presetSummary(name: { zh: string; en: string } | undefined, zh: boolean): string {
  return name ? (zh ? name.zh : name.en) : (zh ? '统一设置' : 'Set for all');
}

function SettingRow({ label, value, focusOnEnter, onClick }: { label: string; value?: string; focusOnEnter?: boolean; onClick(): void }) {
  return (
    <button type="button" className={styles.settingRow} data-focus-on-enter={focusOnEnter || undefined} onClick={onClick}>
      <span className={styles.settingLabel}>{label}</span>
      {value ? <span className={styles.settingValue}>{value}</span> : null}
      <Icon icon={ChevronRight} size="sm" className={styles.settingChevron} />
    </button>
  );
}

/** Nothing selected: the film's settings as a list; each row drills into a page of its controls. */
function ProjectSettings({ m }: { m: InspectorModel }) {
  const { zh, document: d, fps } = m;
  const { onOpenExport, onOpenJianying } = m.props;
  const [view, setView] = useState<{ page?: ProjectPage; motion?: 'forward' | 'back'; from?: ProjectPage }>({});
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view.motion) root.current?.querySelector<HTMLElement>('[data-focus-on-enter]')?.focus({ preventScroll: true });
  }, [view]);

  if (view.page) {
    const page = view.page;
    return (
      <div ref={root} key={page} className={styles.page} data-motion={view.motion}>
        <div className={styles.pageHead}>
          <Button size="sm" variant="bare" className={styles.back} data-focus-on-enter="" onClick={() => setView({ motion: 'back', from: page })}>
            <Icon icon={ChevronLeft} size="sm" />
            {zh ? '全片设置' : 'Project'}
          </Button>
          <h3 className={styles.pageTitle}>{zh ? PAGE_TITLES[page].zh : PAGE_TITLES[page].en}</h3>
        </div>
        <div className={styles.pageBody}>
          <ProjectPageBody m={m} page={page} />
        </div>
      </div>
    );
  }

  const size = movieFrameSize(d);
  const transitionKind = shared(movieTransitionTargets(d), shot => movieTransitionKind(movieShotVisual(d, shot)));
  const filterId = shared(movieFilterTargets(d), filterIdOf);
  const rows: Array<{ page: ProjectPage; label: string; value: string }> = [
    { page: 'aspect', label: zh ? '画幅' : 'Canvas', value: d.aspect },
    { page: 'frameRate', label: zh ? '帧率' : 'Frame rate', value: `${fpsLabel(fps)} fps` },
    { page: 'captionStyle', label: zh ? '字幕样式' : 'Caption style', value: captionSummary(d, zh) },
    { page: 'transitions', label: zh ? '转场' : 'Transitions', value: presetSummary(MOVIE_TRANSITIONS.find(item => item.id === transitionKind)?.name, zh) },
    { page: 'filters', label: zh ? '滤镜' : 'Filters', value: presetSummary(MOVIE_FILTER_PRESETS.find(item => item.id === filterId)?.name, zh) },
  ];
  const clips = d.shots.length;
  return (
    <div ref={root} key="list" className={styles.page} data-motion={view.motion}>
      <header className={styles.projectHead}>
        <h2 className={styles.projectTitle}>{zh ? '全片设置' : 'Project settings'}</h2>
        <p className={styles.projectSummary}>
          {`${filmTimecode(movieDuration(d), fps)} · ${zh ? `${clips} 个片段` : `${clips} ${clips === 1 ? 'clip' : 'clips'}`} · ${size.width}×${size.height}`}
        </p>
      </header>
      <div className={styles.settings}>
        {rows.map(row => (
          <SettingRow key={row.page} label={row.label} value={row.value} focusOnEnter={view.from === row.page} onClick={() => setView({ page: row.page, motion: 'forward' })} />
        ))}
        {onOpenExport || onOpenJianying ? <div className={styles.settingDivider} role="separator" /> : null}
        {onOpenExport ? <SettingRow label={zh ? '导出' : 'Export'} value={`MP4 · ${size.width}×${size.height}`} onClick={onOpenExport} /> : null}
        {onOpenJianying ? (
          <SettingRow label={zh ? '剪映草稿' : 'Jianying draft'} value={zh ? '新建 / 更新' : 'New / update'} focusOnEnter={view.from === 'jianying'} onClick={() => setView({ page: 'jianying', motion: 'forward' })} />
        ) : null}
      </div>
      <p className={styles.projectFoot}>
        {zh ? '在时间线上选择片段，即可调整画面、音频、变速、动画与字幕。' : 'Select a clip on the timeline to adjust its picture, sound, speed, animation and captions.'}
      </p>
    </div>
  );
}

function ProjectPageBody({ m, page }: { m: InspectorModel; page: ProjectPage }) {
  const { zh, document: d } = m;
  const { t } = useI18n();
  switch (page) {
    case 'aspect': {
      const size = movieFrameSize(d);
      return (
        <>
          <AspectSegmented m={m} size="md" />
          <InspectorHint>{zh ? `输出 ${size.width} × ${size.height}。改画幅不会裁掉素材，片段按各自的适配方式重新排布。` : `Renders at ${size.width} × ${size.height}. Changing the canvas keeps every clip; each re-fits by its own fit setting.`}</InspectorHint>
        </>
      );
    }
    case 'frameRate':
      return (
        <>
          <FrameRateSelect m={m} />
          <InspectorHint>{zh ? '帧率决定时间码的帧位与导出的每秒帧数。' : 'The frame rate sets timecode frames and the exported frames per second.'}</InspectorHint>
        </>
      );
    case 'captionStyle':
      return <CaptionStylePage m={m} />;
    case 'transitions':
      return <TransitionsPage m={m} />;
    case 'filters':
      return <FiltersPage m={m} />;
    case 'jianying':
      return (
        <>
          <div className={styles.options}>
            <SettingRow label={t('jianying.create')} onClick={() => m.props.onOpenJianying?.('create')} />
            <SettingRow label={t('jianying.edit')} onClick={() => m.props.onOpenJianying?.('edit')} />
          </div>
          <InspectorHint>{t('jianying.preserve')}</InspectorHint>
        </>
      );
  }
}

function CaptionStylePage({ m }: { m: InspectorModel }) {
  const { zh } = m;
  const targets = movieCaptionTargets(m.document);
  const [picked, setPicked] = useState(() => shared(targets, shot => movieCaptionStylePresetFor(movieCaptionStyle(shot))?.id));
  const preset = MOVIE_CAPTION_STYLE_PRESETS.find(item => item.id === picked);
  return (
    <>
      <CaptionStyleTiles zh={zh} active={picked} disabled={m.locked} onPick={item => setPicked(item.id)} />
      <ApplyToAll
        m={m}
        count={targets.length}
        empty={zh ? '还没有带字幕的片段' : 'No clip has captions yet'}
        label={zh ? '统一字幕样式' : 'Style all captions'}
        operations={preset ? movieCaptionStyleOperations(targets, preset) : undefined}
      />
    </>
  );
}

function TransitionsPage({ m }: { m: InspectorModel }) {
  const { zh, document: d } = m;
  const targets = movieTransitionTargets(d);
  const [kind, setKind] = useState(() => shared(targets, shot => movieTransitionKind(movieShotVisual(d, shot))));
  const [seconds, setSeconds] = useState(() => shared(targets, shot => movieShotVisual(d, shot).transitionDuration ?? MOVIE_TRANSITION_SECONDS.default) ?? MOVIE_TRANSITION_SECONDS.default);
  return (
    <>
      <TransitionTiles zh={zh} active={kind} disabled={m.locked} onPick={setKind} />
      <InspectorSliderField
        label={zh ? '转场时长' : 'Transition length'}
        unit="s"
        value={seconds}
        min={MOVIE_TRANSITION_SECONDS.min}
        max={MOVIE_TRANSITION_SECONDS.max}
        step={0.05}
        resetValue={MOVIE_TRANSITION_SECONDS.default}
        disabled={m.locked}
        onCommit={setSeconds}
      />
      <ApplyToAll
        m={m}
        count={targets.length}
        empty={zh ? '没有前后相接的片段' : 'No clips meet end to start'}
        label={zh ? '统一转场' : 'Set all transitions'}
        operations={kind ? movieTransitionOperations(d, targets, kind, seconds) : undefined}
      />
    </>
  );
}

function FiltersPage({ m }: { m: InspectorModel }) {
  const { zh } = m;
  const targets = movieFilterTargets(m.document);
  const [picked, setPicked] = useState(() => shared(targets, filterIdOf));
  const preset = MOVIE_FILTER_PRESETS.find(item => item.id === picked);
  return (
    <>
      <FilterTiles zh={zh} frame={m.frameOf(targets[0])} active={picked} layout="grid" disabled={m.locked} onPick={item => setPicked(item.id)} />
      <ApplyToAll
        m={m}
        count={targets.length}
        empty={zh ? '还没有画面片段' : 'No picture clips yet'}
        label={zh ? '统一滤镜' : 'Set all filters'}
        operations={preset ? movieFilterOperations(targets, preset.color) : undefined}
      />
    </>
  );
}

/* ---- Clip panels ---- */

interface PanelProps {
  m: InspectorModel;
  shot: MovieShot;
}

function ClipPanel({ tab, m, shot }: PanelProps & { tab: InspectorTab }) {
  switch (tab) {
    case 'video': return <VideoPanel m={m} shot={shot} />;
    case 'basic': return <BasicPanel m={m} shot={shot} />;
    case 'audio': return <AudioPanel m={m} shot={shot} />;
    case 'speed': return <SpeedPanel m={m} shot={shot} />;
    case 'animation': return <AnimationPanel m={m} shot={shot} />;
    case 'adjust': return <AdjustPanel m={m} shot={shot} />;
    case 'captions': return <CaptionsPanel m={m} shot={shot} />;
    case 'text': return <TextPanel m={m} shot={shot} />;
  }
}

function VideoPanel({ m, shot }: PanelProps) {
  const { zh } = m;
  const section = m.sectionFor(shot);
  return (
    <>
      <InspectorSection name="basics" title={zh ? '基础' : 'Basics'}>
        <DraftBasics m={m} titleLabel={zh ? '名称' : 'Name'} sourceIn={!movieShotIsImage(m.document, shot)} />
        <ClipFitField {...section} />
      </InspectorSection>
      <InspectorSection name="transform" title={zh ? '位置与大小' : 'Position and size'} aside={<ClipResetButton part="pose" {...section} />}>
        <ClipPoseSection {...section} />
      </InspectorSection>
      <InspectorSection name="crop" title={zh ? '裁切' : 'Crop'} aside={<ClipResetButton part="crop" {...section} />}>
        <ClipCropSection {...section} />
      </InspectorSection>
      <InspectorSection name="fades" title={zh ? '淡入淡出' : 'Fades'}>
        <ClipFadeFields {...section} />
      </InspectorSection>
      <InspectorSection name="transition" title={zh ? '转场' : 'Transition'}>
        <ClipTransitionSection {...section} />
      </InspectorSection>
    </>
  );
}

function BasicPanel({ m, shot }: PanelProps) {
  return (
    <InspectorSection name="basics" title={m.zh ? '基础' : 'Basics'}>
      <DraftBasics m={m} titleLabel={m.zh ? '名称' : 'Name'} sourceIn={Boolean(shot.clip)} />
    </InspectorSection>
  );
}

function AudioPanel({ m, shot }: PanelProps) {
  const { zh } = m;
  const section = m.sectionFor(shot);
  return (
    <>
      <InspectorSection name="volume" title={zh ? '音量' : 'Volume'}>
        <ClipVolumeField {...section} />
        <ClipMuteSwitch {...section} />
      </InspectorSection>
      <InspectorSection name="audio-fades" title={zh ? '淡入淡出' : 'Fades'}>
        <ClipAudioFades {...section} />
      </InspectorSection>
      {shot.clip?.audioOnly ? (
        <InspectorSection name="loop" title={zh ? '循环' : 'Loop'}>
          <InspectorHint>{zh ? '把这段音频接续复制到影片结尾。' : 'Copies this audio after itself until the film ends.'}</InspectorHint>
          <div className={styles.chips}>
            <ClipRepeatButton {...section} />
          </div>
        </InspectorSection>
      ) : !m.linkedAudio ? (
        <InspectorSection name="detach" title={zh ? '分离音频' : 'Detach audio'}>
          <InspectorHint>{zh ? '把原声拆到独立音频轨，原片段静音，便于单独剪辑。' : 'Moves the sound to its own audio track and mutes the video clip.'}</InspectorHint>
          <div className={styles.chips}>
            <Button size="sm" variant="ghost" disabled={section.disabled} onClick={m.detachAudio}>{zh ? '分离音频' : 'Detach audio'}</Button>
          </div>
        </InspectorSection>
      ) : null}
    </>
  );
}

const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3];

function SpeedPanel({ m, shot }: PanelProps) {
  const { zh, fps } = m;
  const clip = shot.clip;
  if (!clip) return null;
  const disabled = m.locked || m.dirty || m.linkedAudio;
  const setRate = (rate: number) => {
    const operations = movieSpeedOperations(shot, rate);
    return operations.length ? m.props.onApply(zh ? '调整速度' : 'Change speed', operations) : Promise.resolve(true);
  };
  const preset = SPEED_PRESETS.find(rate => Math.abs(rate - clip.rate) < 1e-6);
  return (
    <InspectorSection name="speed" title={zh ? '常规变速' : 'Speed'}>
      <Segmented
        className={styles.segmented}
        aria-label={zh ? '速度预设' : 'Speed presets'}
        value={preset === undefined ? '' : String(preset)}
        disabled={disabled}
        onValueChange={value => void setRate(Number(value))}
      >
        {SPEED_PRESETS.map(rate => <SegmentedItem key={rate} className={styles.segmentedItem} value={String(rate)}>{rate}×</SegmentedItem>)}
      </Segmented>
      <InspectorSliderField label={zh ? '速度' : 'Speed'} unit="×" value={clip.rate} min={0.25} max={4} step={0.05} resetValue={1} disabled={disabled} onCommit={setRate} />
      <Facts
        items={[
          [zh ? '源片段' : 'Source span', editorTimecode(shot.duration * clip.rate, fps)],
          [zh ? '输出时长' : 'Output', editorTimecode(shot.duration, fps)],
        ]}
      />
      <InspectorHint>
        {zh ? '变速保留所选源片段，时长、字幕与淡入淡出随之缩放。' : 'Speed keeps the source interval; duration, captions and fades scale with it.'}
      </InspectorHint>
    </InspectorSection>
  );
}

function AnimationPanel({ m, shot }: PanelProps) {
  const { zh } = m;
  if (shot.kind === 'text') {
    const current = shot.textAnimation ?? 'none';
    return (
      <InspectorSection name="entrance" title={zh ? '入场动画' : 'Entrance'}>
        <div className={styles.tileGrid} role="group" aria-label={zh ? '文字入场' : 'Text entrance'}>
          {TEXT_ENTRANCES.map(item => (
            <InspectorTile
              key={item.value}
              motion={item.motion}
              label={zh ? item.zh : item.en}
              pressed={current === item.value}
              disabled={m.locked || m.dirty}
              onClick={() => void setTextAnimation(m, shot, item.value)}
            />
          ))}
        </div>
      </InspectorSection>
    );
  }
  const section = m.sectionFor(shot);
  return (
    <>
      <InspectorSection name="motion" title={zh ? '动画预设' : 'Motion'}>
        <ClipMotionPresets {...section} />
      </InspectorSection>
      <InspectorSection name="keyframes" title={`${zh ? '关键帧' : 'Keyframes'} · ${shot.clip?.keyframes?.length ?? 0}`}>
        <ClipKeyframeList {...section} />
      </InspectorSection>
    </>
  );
}

function AdjustPanel({ m, shot }: PanelProps) {
  const section = m.sectionFor(shot);
  return (
    <InspectorSection name="adjust" title={m.zh ? '调节' : 'Adjust'} aside={<ClipResetButton part="color" {...section} />}>
      <ClipColorSection {...section} frame={m.frameOf(shot)} />
    </InspectorSection>
  );
}

function CaptionsPanel({ m, shot }: PanelProps) {
  const { zh } = m;
  return (
    <>
      <InspectorSection name="captions" title={`${zh ? '字幕' : 'Captions'} · ${m.captions.length}`}>
        <CaptionsEditor m={m} shot={shot} />
      </InspectorSection>
      <InspectorSection name="caption-style" title={zh ? '样式' : 'Style'}>
        <CaptionTypography m={m} shot={shot} />
      </InspectorSection>
    </>
  );
}

const TEXT_SWATCHES: readonly InspectorSwatch[] = [
  { value: '#FFFFFF', zh: '白色', en: 'White' },
  { value: '#181818', zh: '黑色', en: 'Black' },
  { value: '#FFD54A', zh: '黄色', en: 'Yellow' },
  { value: '#FF6B57', zh: '红色', en: 'Red' },
  { value: '#4D81EF', zh: '蓝色', en: 'Blue' },
  { value: '#2FD47C', zh: '绿色', en: 'Green' },
];

function TextPanel({ m, shot }: PanelProps) {
  const { zh, form } = m;
  const contentId = useId();
  if (!form) return null;
  const visual = shot.visual;
  const disabled = m.locked || m.dirty;
  const setVisual = (label: string, changes: Partial<MovieVisual>) =>
    visual ? m.props.onApply(label, [{ op: 'update-shot', shotId: shot.id, changes: { visual: { ...visual, ...changes } } }]) : Promise.resolve(false);
  const setCopy = (label: string, copy: Partial<MovieVisual['copy']>) => (visual ? setVisual(label, { copy: { ...visual.copy, ...copy } }) : Promise.resolve(false));
  return (
    <>
      <InspectorSection name="text" title={zh ? '文本' : 'Text'}>
        <div className={styles.field}>
          <label className={styles.rowLabel} htmlFor={contentId}>{zh ? '文字内容' : 'Text'}</label>
          <Textarea id={contentId} rows={3} className={styles.textContent} value={form.title} disabled={m.locked} onChange={e => m.patchForm({ title: e.target.value })} />
        </div>
        <DraftRow label={zh ? '时长' : 'Duration'} numeric value={form.duration} disabled={m.locked} onChange={duration => m.patchForm({ duration })} onSubmit={() => void m.apply()} />
      </InspectorSection>
      {visual ? (
        <InspectorSection name="text-style" title={zh ? '样式' : 'Style'}>
          <InspectorColorField
            label={zh ? '文字颜色' : 'Text color'}
            swatches={TEXT_SWATCHES}
            value={textColorOf(shot)}
            disabled={disabled}
            onCommit={foreground => setVisual(zh ? '调整文字颜色' : 'Change text color', { foreground })}
          />
          <InspectorSliderField
            label={zh ? '字号' : 'Font size'}
            unit="%"
            value={visual.copy.titleSize}
            min={1}
            max={20}
            step={0.1}
            resetValue={3.5}
            disabled={disabled}
            onCommit={titleSize => setCopy(zh ? '调整字号' : 'Change font size', { titleSize })}
          />
          <AlignmentRow zh={zh} label={zh ? '文字对齐' : 'Text alignment'} value={visual.copy.align} disabled={disabled} onChange={align => void setCopy(zh ? '调整文字对齐' : 'Align text', { align })} />
          <InspectorPairRow label={zh ? '位置' : 'Position'}>
            <InspectorNumberField label={zh ? '水平位置' : 'Position X'} prefix="X" unit="%" value={visual.copy.x} min={-20} max={100} step={0.5} disabled={disabled}
              onCommit={x => setCopy(zh ? '移动文字' : 'Move text', { x })} />
            <InspectorNumberField label={zh ? '垂直位置' : 'Position Y'} prefix="Y" unit="%" value={visual.copy.y} min={-20} max={100} step={0.5} disabled={disabled}
              onCommit={y => setCopy(zh ? '移动文字' : 'Move text', { y })} />
          </InspectorPairRow>
        </InspectorSection>
      ) : null}
    </>
  );
}
