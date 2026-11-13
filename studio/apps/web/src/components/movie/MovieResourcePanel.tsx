import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Aperture,
  ArrowLeftToLine,
  ArrowRightToLine,
  Blend,
  Captions,
  Check,
  Clapperboard,
  Eraser,
  FileDown,
  FileUp,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Music2,
  Orbit,
  Plus,
  Search,
  Sparkles,
  Sunrise,
  Sunset,
  Type,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { movieNextShotIndex, type MovieDocument, type MovieEditOperation, type MovieShot, type MovieVideoSource } from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { Button, Icon, IconButton, Input, Segmented, SegmentedItem, cn } from '../../fantay/ui';
import {
  MOVIE_CAPTION_STYLE_PRESETS,
  MOVIE_CLIP_ANIMATIONS,
  MOVIE_DEFAULT_CAPTION_STYLE,
  MOVIE_FILTER_PRESETS,
  MOVIE_TEXT_ANIMATIONS,
  MOVIE_TEXT_PRESETS,
  MOVIE_TRANSITION_SECONDS,
  MOVIE_TRANSITIONS,
  isMovieVisualClip,
  movieApplyAllBlocked,
  movieCaptionEntries,
  movieCaptionStyle,
  movieCaptionStyleMatch,
  movieCaptionStyleOperations,
  movieCaptionTargets,
  movieCaptionTextOperations,
  movieClearClipAnimationOperations,
  movieClipAnimationFor,
  movieClipAnimationOperations,
  movieClipColor,
  movieColorFilter,
  movieFilterMatch,
  movieFilterOperations,
  movieFilterTargets,
  movieShotVisual,
  movieTextAnimationOperations,
  movieTextInsertOperations,
  movieTransitionKind,
  movieTransitionOperations,
  movieTransitionReady,
  movieTransitionTargets,
  type MovieBilingual,
  type MovieCaptionEntry,
  type MovieCaptionStylePreset,
  type MovieClipAnimationKind,
  type MovieLookMatch,
  type MovieTextAnimation,
  type MovieTextPreset,
  type MovieTransitionKind,
  type MovieVisualShot,
} from './movie-editor-presets';
import { movieSubtitlesText, parseMovieSubtitles } from './movie-subtitles';
import styles from './MovieResourcePanel.module.css';

export type MovieResourceCategory = 'media' | 'audio' | 'text' | 'captions' | 'transitions' | 'filters' | 'animation';

export interface MovieResourcePanelProps {
  document: MovieDocument;
  sources: MovieVideoSource[];
  selectedShotId?: string;
  selectionKind?: 'video' | 'audio';
  /** Playhead, output seconds. */
  time: number;
  disabled: boolean;
  /** Project raw resource URL for source frames. */
  url(path: string): string;
  category: MovieResourceCategory;
  onCategoryChange(category: MovieResourceCategory): void;
  /** Open the file picker. */
  onImport(): void;
  /** Open the media generation dialog. */
  onGenerate(): void;
  /** Single click: preview the source with in/out marks in the viewer. */
  onInspectSource(source: MovieVideoSource): void;
  /** Double-click or "+": append to the film; audio "add at playhead" uses 'overlay'. */
  onAddSource(source: MovieVideoSource, mode: 'append' | 'overlay'): void;
  onApply(label: string, operations: MovieEditOperation[]): Promise<boolean>;
  onSeek(time: number): void;
  onSelect(shotId: string, kind?: 'video' | 'audio'): void;
  /** Transcribe the selected clip's speech into captions. */
  onTranscribe?(): void;
  /** A transcription is running: its button shows a spinner. */
  transcribing?: boolean;
  /** Close button of the compact drawer; rendered only when provided. */
  onClose?(): void;
}

interface SectionProps extends MovieResourcePanelProps {
  zh: boolean;
}

const CATEGORIES: ReadonlyArray<{ id: MovieResourceCategory; icon: LucideIcon; name: MovieBilingual }> = [
  { id: 'media', icon: Clapperboard, name: { zh: '媒体', en: 'Media' } },
  { id: 'audio', icon: Music2, name: { zh: '音频', en: 'Audio' } },
  { id: 'text', icon: Type, name: { zh: '文本', en: 'Text' } },
  { id: 'captions', icon: Captions, name: { zh: '字幕', en: 'Captions' } },
  { id: 'transitions', icon: Blend, name: { zh: '转场', en: 'Transitions' } },
  { id: 'filters', icon: Aperture, name: { zh: '滤镜', en: 'Filters' } },
  { id: 'animation', icon: Orbit, name: { zh: '动画', en: 'Animation' } },
];

const SOURCE_DRAG_TYPE = 'application/x-fantay-source';
/** Look previews are ~120px wide; output blur is in 1080p pixels. */
const PREVIEW_BLUR_SCALE = 0.12;
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const pick = (zh: boolean, name: MovieBilingual) => (zh ? name.zh : name.en);

/**
 * The editor's resource card: a tab strip of categories over a title row and one scrolling body.
 * Every edit goes through `onApply` as one batch (one undo step), like the timeline and inspector.
 */
export function MovieResourcePanel(props: MovieResourcePanelProps) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const baseId = useId();
  const active = CATEGORIES.find(item => item.id === props.category) ?? CATEGORIES[0]!;
  const section: SectionProps = { ...props, zh };
  const { onClose } = props;
  const { count, actions } = titleMeta(section, active.id);
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !onClose) return;
    event.stopPropagation();
    onClose();
  };
  return (
    <section className={styles.panel} aria-label={zh ? '素材与效果' : 'Media and effects'} onKeyDown={closeOnEscape}>
      <CategoryTabs zh={zh} baseId={baseId} category={active.id} onChange={props.onCategoryChange} />
      <header className={styles.titleRow}>
        <h2 className={styles.title}>{pick(zh, active.name)}</h2>
        {count ? <span className={styles.count}>{count}</span> : null}
        <span className={styles.titleActions}>
          {actions}
          {onClose ? (
            <IconButton size="sm" aria-label={zh ? '关闭素材面板' : 'Close resource panel'} onClick={onClose}>
              <Icon icon={X} size="sm" />
            </IconButton>
          ) : null}
        </span>
      </header>
      <div className={styles.body} role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-${active.id}`}>
        {active.id === 'media' ? <MediaSection {...section} /> : null}
        {active.id === 'audio' ? <AudioSection {...section} /> : null}
        {active.id === 'text' ? <TextSection {...section} /> : null}
        {active.id === 'captions' ? <CaptionsSection {...section} /> : null}
        {active.id === 'transitions' ? <TransitionsSection {...section} /> : null}
        {active.id === 'filters' ? <FiltersSection {...section} /> : null}
        {active.id === 'animation' ? <AnimationSection {...section} /> : null}
      </div>
    </section>
  );
}

/** The title row's count and actions; an empty list carries its import action in its empty state. */
function titleMeta(props: SectionProps, category: MovieResourceCategory): { count?: number; actions?: ReactNode } {
  const { zh, document: d, sources, disabled, onImport } = props;
  switch (category) {
    case 'media':
      return sources.length ? { count: sources.length, actions: <ImportActions {...props} /> } : {};
    case 'audio': {
      const count = audioSources(sources).length;
      if (!count) return {};
      return { count, actions: <Button size="sm" disabled={disabled} onClick={onImport}><Icon icon={Upload} size="sm" />{zh ? '导入' : 'Import'}</Button> };
    }
    case 'captions':
      return { count: movieCaptionEntries(d).length };
    default:
      return {};
  }
}

function ImportActions({ zh, disabled, onImport, onGenerate }: SectionProps) {
  return (
    <>
      <Button size="sm" disabled={disabled} onClick={onImport}><Icon icon={Upload} size="sm" />{zh ? '导入' : 'Import'}</Button>
      <Button size="sm" disabled={disabled} onClick={onGenerate}><Icon icon={Sparkles} size="sm" />{zh ? '生成素材' : 'Generate'}</Button>
    </>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────────────────────────

const TAB_KEYS: Record<string, (index: number, last: number) => number> = {
  ArrowRight: (index, last) => (index === last ? 0 : index + 1),
  ArrowLeft: (index, last) => (index === 0 ? last : index - 1),
  Home: () => 0,
  End: (_, last) => last,
};

function CategoryTabs({ zh, baseId, category, onChange }: {
  zh: boolean;
  baseId: string;
  category: MovieResourceCategory;
  onChange(category: MovieResourceCategory): void;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = TAB_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    const next = step(index, CATEGORIES.length - 1);
    onChange(CATEGORIES[next]!.id);
    tabs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-orientation="horizontal" aria-label={zh ? '素材类别' : 'Resource categories'}>
      {CATEGORIES.map((item, index) => {
        const selected = item.id === category;
        return (
          <button
            key={item.id}
            ref={element => { tabs.current[index] = element; }}
            type="button"
            role="tab"
            id={`${baseId}-${item.id}`}
            aria-selected={selected}
            aria-controls={`${baseId}-panel`}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(item.id)}
            onKeyDown={event => move(event, index)}
          >
            <Icon icon={item.icon} size={18} />
            <span className={styles.tabLabel}>{pick(zh, item.name)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Media ───────────────────────────────────────────────────────────────────────────────────────

type MediaFilter = 'all' | 'video' | 'audio' | 'image';

const MEDIA_FILTERS: ReadonlyArray<{ id: MediaFilter; name: MovieBilingual }> = [
  { id: 'all', name: { zh: '全部', en: 'All' } },
  { id: 'video', name: { zh: '视频', en: 'Video' } },
  { id: 'audio', name: { zh: '音频', en: 'Audio' } },
  { id: 'image', name: { zh: '图片', en: 'Image' } },
];

function MediaSection(props: SectionProps) {
  const { zh, document: d, sources, disabled, url, onInspectSource, onAddSource, onClose } = props;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MediaFilter>('all');
  const used = useMemo(() => new Set(d.shots.map(shot => shot.clip?.assetId)), [d.shots]);
  if (!sources.length) {
    return (
      <EmptyNote icon={FolderOpen} title={zh ? '还没有素材' : 'No media yet'} detail={zh ? '导入视频、音频或图片，也可以生成新的素材。' : 'Import video, audio or images, or generate new media.'}>
        <ImportActions {...props} />
      </EmptyNote>
    );
  }
  const needle = query.trim().toLowerCase();
  const visible = sources.filter(source => source.label.toLowerCase().includes(needle) && (filter === 'all' || (source.kind ?? 'video') === filter));
  return (
    <>
      <div className={styles.section}>
        <label className={styles.search}>
          <Icon icon={Search} size="sm" />
          <Input
            variant="bare"
            inputSize="auto"
            className={styles.searchInput}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={zh ? '搜索素材' : 'Search media'}
            aria-label={zh ? '搜索素材' : 'Search media'}
          />
        </label>
        <Segmented size="sm" className={styles.segmented} aria-label={zh ? '素材类型' : 'Media type'} value={filter} onValueChange={value => setFilter(value as MediaFilter)}>
          {MEDIA_FILTERS.map(item => (
            <SegmentedItem key={item.id} className={styles.segmentedItem} value={item.id}>{pick(zh, item.name)}</SegmentedItem>
          ))}
        </Segmented>
      </div>
      {visible.length ? (
        <div className={styles.mediaGrid}>
          {visible.map(source => (
            <MediaCard
              key={source.assetId}
              zh={zh}
              source={source}
              used={used.has(source.assetId)}
              disabled={disabled}
              url={url}
              onInspect={onInspectSource}
              onAdd={onAddSource}
            />
          ))}
        </div>
      ) : (
        <p className={styles.hint}>{zh ? '没有符合条件的素材' : 'No media matches'}</p>
      )}
      {onClose ? <p className={styles.footnote}>{zh ? '单击预览 · 双击或拖入时间线添加' : 'Click to preview · double-click or drag to the timeline'}</p> : null}
    </>
  );
}

function MediaCard({ zh, source, used, disabled, url, onInspect, onAdd }: {
  zh: boolean;
  source: MovieVideoSource;
  used: boolean;
  disabled: boolean;
  url(path: string): string;
  onInspect(source: MovieVideoSource): void;
  onAdd(source: MovieVideoSource, mode: 'append' | 'overlay'): void;
}) {
  const frame = sourceFrame(source);
  const kind = source.kind ?? 'video';
  return (
    <div className={styles.mediaCard}>
      <button
        type="button"
        className={styles.mediaButton}
        aria-label={`${zh ? '素材' : 'Media'} ${source.label}`}
        title={source.label}
        disabled={disabled}
        draggable={!disabled}
        onDragStart={event => startSourceDrag(event, source)}
        onClick={() => onInspect(source)}
        onDoubleClick={() => onAdd(source, 'append')}
      >
        <span className={styles.thumb} data-kind={kind}>
          {frame ? <img className={styles.thumbImage} src={url(frame.path)} alt="" draggable={false} />
            : kind === 'audio' && source.audioPeaks?.length ? <Waveform peaks={source.audioPeaks} bars={32} className={styles.thumbWave} />
              : <Icon icon={sourceIcon(source)} size="lg" />}
          {used ? <span className={styles.usedBadge}><Icon icon={Check} size={10} />{zh ? '已添加' : 'Added'}</span> : null}
          {kind !== 'image' ? <span className={styles.durationBadge}>{formatClock(Math.round(source.duration))}</span> : null}
        </span>
        <span className={styles.cardName}>{source.label}</span>
      </button>
      <span className={styles.cardAdd}>
        <IconButton
          size="xs"
          variant="primary"
          shape="round"
          className={styles.cardAddButton}
          aria-label={`${zh ? '添加到时间线' : 'Add to timeline'} ${source.label}`}
          tooltip={zh ? '添加到时间线末尾' : 'Append to the timeline'}
          disabled={disabled}
          onClick={() => onAdd(source, 'append')}
        >
          <Icon icon={Plus} size={12} />
        </IconButton>
      </span>
    </div>
  );
}

// ─── Audio ───────────────────────────────────────────────────────────────────────────────────────

function AudioSection({ zh, sources, disabled, onImport, onInspectSource, onAddSource }: SectionProps) {
  const audio = audioSources(sources);
  if (!audio.length) {
    return (
      <EmptyNote icon={Music2} title={zh ? '还没有音频素材' : 'No audio yet'} detail={zh ? '导入的音乐、配音和音效会显示在这里。' : 'Imported music, voice-over and sound effects appear here.'}>
        <Button size="sm" disabled={disabled} onClick={onImport}><Icon icon={Upload} size="sm" />{zh ? '导入音频' : 'Import audio'}</Button>
      </EmptyNote>
    );
  }
  return (
    <ul className={styles.audioList}>
      {audio.map(source => (
        <AudioRow key={source.assetId} zh={zh} source={source} disabled={disabled} onInspect={onInspectSource} onAdd={onAddSource} />
      ))}
    </ul>
  );
}

function AudioRow({ zh, source, disabled, onInspect, onAdd }: {
  zh: boolean;
  source: MovieVideoSource;
  disabled: boolean;
  onInspect(source: MovieVideoSource): void;
  onAdd(source: MovieVideoSource, mode: 'append' | 'overlay'): void;
}) {
  return (
    <li className={styles.audioRow}>
      <button
        type="button"
        className={styles.audioMain}
        aria-label={`${zh ? '音频' : 'Audio'} ${source.label}`}
        title={source.label}
        disabled={disabled}
        draggable={!disabled}
        onDragStart={event => startSourceDrag(event, source)}
        onClick={() => onInspect(source)}
        onDoubleClick={() => onAdd(source, 'overlay')}
      >
        <span className={styles.audioGlyph}><Icon icon={Music2} size="sm" /></span>
        <span className={styles.audioText}>
          <span className={styles.audioName}>{source.label}</span>
          <span className={styles.audioMeta}>{formatClock(Math.round(source.duration))}</span>
        </span>
        <Waveform peaks={source.audioPeaks} bars={24} className={styles.audioWave} />
      </button>
      <IconButton
        size="sm"
        aria-label={`${zh ? '添加到播放头' : 'Add at playhead'} ${source.label}`}
        tooltip={zh ? '在播放头处添加到新轨道' : 'Add at the playhead on a new track'}
        disabled={disabled}
        onClick={() => onAdd(source, 'overlay')}
      >
        <Icon icon={Plus} size="sm" />
      </IconButton>
    </li>
  );
}

function Waveform({ peaks, bars, className }: { peaks?: number[]; bars: number; className?: string }) {
  const heights = useMemo(() => waveformBars(peaks, bars), [peaks, bars]);
  if (!heights.length) return <span className={cn(className, styles.waveformFlat)} aria-hidden="true" />;
  return (
    <svg className={cn(className, styles.waveform)} viewBox={`0 0 ${bars * 3} 16`} preserveAspectRatio="none" aria-hidden="true">
      {heights.map((peak, index) => {
        const height = Math.max(1.5, peak * 16);
        return <rect key={index} x={index * 3} y={(16 - height) / 2} width={1.6} height={height} rx={0.8} />;
      })}
    </svg>
  );
}

/** Peak (0..1) per bar, taking the loudest sample of each slice. */
function waveformBars(peaks: number[] | undefined, count: number): number[] {
  if (!peaks?.length) return [];
  return Array.from({ length: count }, (_, index) => {
    const from = Math.floor((index * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((index + 1) * peaks.length) / count));
    return Math.min(1, Math.max(0, ...peaks.slice(from, to)));
  });
}

// ─── Text ────────────────────────────────────────────────────────────────────────────────────────

function TextSection({ zh, document: d, sources, time, disabled, url, selectedShotId, selectionKind, onApply, onSelect }: SectionProps) {
  const image = previewImage(d, sources, url, resolveSelection(d, selectedShotId, selectionKind).visual);
  const add = async (preset: MovieTextPreset) => {
    const id = crypto.randomUUID();
    if (await onApply(zh ? '添加文字' : 'Add text', movieTextInsertOperations(d, preset, { text: pick(zh, preset.name), at: time, newShotId: id }))) onSelect(id);
  };
  return (
    <>
      <p className={styles.hint}>{zh ? '点击样式，在播放头处添加 3 秒文字。' : 'Click a style to add 3 seconds of text at the playhead.'}</p>
      <div className={styles.tileGrid}>
        {MOVIE_TEXT_PRESETS.map(preset => {
          const name = pick(zh, preset.name);
          return (
            <Tile key={preset.id} aria-label={`${zh ? '添加文字' : 'Add text'} ${name}`} disabled={disabled} onClick={() => void add(preset)}>
              <StageArt image={image} />
              <span className={styles.textSample} data-animation={preset.animation} style={textSampleStyle(preset)}>{name}</span>
            </Tile>
          );
        })}
      </div>
    </>
  );
}

function textSampleStyle(preset: MovieTextPreset): CSSProperties {
  return {
    '--sample-x': `${preset.copy.x}%`,
    '--sample-y': `${preset.copy.y}%`,
    '--sample-w': `${preset.copy.width}%`,
    '--sample-size': String(preset.copy.titleSize),
    textAlign: preset.copy.align,
    color: preset.foreground,
  } as CSSProperties;
}

// ─── Captions ────────────────────────────────────────────────────────────────────────────────────

function CaptionsSection(props: SectionProps) {
  const shot = resolveSelection(props.document, props.selectedShotId, props.selectionKind).visual;
  return (
    <>
      <TranscribeCard {...props} shot={shot} />
      <CaptionList {...props} />
      <CaptionStyles {...props} shot={shot} />
    </>
  );
}

/** Transcription and SRT import/export for the selected clip. */
function TranscribeCard({ zh, shot, sources, disabled, transcribing, onApply, onTranscribe }: SectionProps & { shot?: MovieVisualShot }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const captions = shot?.captions ?? [];
  const hasAudio = shot ? sources.find(source => source.assetId === shot.clip.assetId)?.hasAudio !== false : false;
  const blocked = !shot ? (zh ? '先在时间线上选择一个视频片段' : 'Select a video clip on the timeline first')
    : shot.locked ? lockedHint(zh)
      : undefined;
  const importFile = async (file: File) => {
    if (!shot) return;
    try {
      if (file.size > MAX_SUBTITLE_BYTES) throw new Error(zh ? '字幕文件须小于 2 MiB' : 'Subtitle file must be under 2 MiB');
      const cues = parseMovieSubtitles(await file.text(), shot.duration);
      if (await onApply(zh ? '导入所选片段字幕' : 'Import clip subtitles', [{ op: 'replace-captions', shotId: shot.id, captions: cues }])) setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.sectionHeading}>{zh ? '识别字幕' : 'Transcribe'}</h3>
        <span className={styles.cardTarget} title={shot?.title}>{shot ? shotName(zh, shot) : (zh ? '未选择片段' : 'No clip selected')}</span>
      </div>
      {onTranscribe ? (
        <Button
          size="sm"
          block
          loading={transcribing}
          disabled={disabled || Boolean(blocked) || !hasAudio}
          disabledReason={blocked ?? (shot && !hasAudio ? noSoundHint(zh) : undefined)}
          onClick={onTranscribe}
        >
          <Icon icon={Captions} size="sm" />{zh ? '从原声生成字幕' : 'Transcribe speech'}
        </Button>
      ) : null}
      <div className={styles.applyRow}>
        <Button size="sm" variant="bare" disabled={disabled || Boolean(blocked)} disabledReason={blocked} onClick={() => fileInput.current?.click()}>
          <Icon icon={FileUp} size="sm" />{zh ? '导入 SRT' : 'Import SRT'}
        </Button>
        <Button size="sm" variant="bare" disabled={!captions.length} onClick={() => shot && downloadSubtitles(shot)}>
          <Icon icon={FileDown} size="sm" />{zh ? '导出 SRT' : 'Export SRT'}
        </Button>
      </div>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".srt,text/plain"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />
      {error ? <p className={styles.error} role="alert">{error}</p>
        : shot && !hasAudio ? <p className={styles.hint}>{noSoundHint(zh)}</p>
          : <p className={styles.hint}>{zh ? 'SRT 时间从所选片段的起点算起。' : 'SRT times start at the beginning of the selected clip.'}</p>}
    </div>
  );
}

/** Every cue of the film; the playing one is marked and kept in view. Double-click edits a cue. */
function CaptionList({ zh, document: d, time, disabled, onApply, onSeek, onSelect }: SectionProps) {
  const entries = useMemo(() => movieCaptionEntries(d), [d]);
  const playing = entries.findIndex(entry => time >= entry.start && time < entry.end);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const box = list.current;
    const row = box?.children[playing];
    if (box && row instanceof HTMLElement) keepInView(box, row);
  }, [playing]);
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionHeading}>{zh ? '字幕列表' : 'Caption list'}</h3>
      {entries.length ? (
        <ol className={styles.captionList} ref={list}>
          {entries.map((entry, index) => (
            <CaptionRow
              key={`${entry.shot.id}-${entry.caption.id ?? index}`}
              zh={zh}
              entry={entry}
              playing={index === playing}
              editable={!disabled && !entry.shot.locked}
              onPick={() => { onSelect(entry.shot.id, 'video'); onSeek(entry.start); }}
              onEdit={text => void onApply(zh ? '修改字幕' : 'Edit caption', movieCaptionTextOperations(entry.shot, entry.caption, text))}
            />
          ))}
        </ol>
      ) : (
        <p className={styles.hint}>{zh ? '还没有字幕。可以从原声生成，或导入 SRT。' : 'No captions yet. Transcribe a clip, or import SRT.'}</p>
      )}
    </div>
  );
}

function CaptionRow({ zh, entry, playing, editable, onPick, onEdit }: {
  zh: boolean;
  entry: MovieCaptionEntry;
  playing: boolean;
  editable: boolean;
  onPick(): void;
  onEdit(text: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const time = <span className={styles.captionTime}>{formatClock(entry.start, true)}</span>;
  if (draft !== null) {
    const finish = () => {
      const text = draft.trim();
      const keep = !cancelled.current;
      cancelled.current = false;
      setDraft(null);
      if (keep && text && text !== entry.caption.text) onEdit(text);
    };
    return (
      <li className={styles.captionEdit}>
        {time}
        <Input
          autoFocus
          inputSize="sm"
          value={draft}
          maxLength={300}
          aria-label={zh ? '编辑字幕' : 'Edit caption'}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            cancelled.current = event.key === 'Escape';
            event.currentTarget.blur();
          }}
          onBlur={finish}
        />
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className={styles.captionRow}
        aria-current={playing ? 'true' : undefined}
        title={editable ? (zh ? '双击编辑' : 'Double-click to edit') : undefined}
        onClick={onPick}
        onDoubleClick={() => { if (editable) setDraft(entry.caption.text); }}
      >
        {time}
        <span className={styles.captionText}>{entry.caption.text || '—'}</span>
      </button>
    </li>
  );
}

function CaptionStyles({ zh, document: d, sources, disabled, url, shot, onApply }: SectionProps & { shot?: MovieVisualShot }) {
  const targets = useMemo(() => movieCaptionTargets(d), [d]);
  const match = shot ? movieCaptionStyleMatch(movieCaptionStyle(shot)) : undefined;
  const { pressed, chosen, choose } = usePresetChoice(MOVIE_CAPTION_STYLE_PRESETS, shot, match, preset => {
    if (shot && !shot.locked) void onApply(zh ? '调整字幕样式' : 'Style captions', movieCaptionStyleOperations([shot], preset));
  });
  const image = previewImage(d, sources, url, shot);
  const tooMany = movieApplyAllBlocked(targets.length, zh);
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionHeading}>{zh ? '字幕样式' : 'Caption style'}</h3>
      {!shot ? <p className={styles.hint}>{zh ? '选择片段后点击样式即可应用；也可以选好样式后应用到全部。' : 'Select a clip and click a style, or pick one and apply it to all.'}</p> : null}
      {shot?.locked ? <p className={styles.hint}>{lockedHint(zh)}</p> : null}
      <NearLookHint zh={zh} match={match} />
      <div className={styles.tileGrid}>
        {MOVIE_CAPTION_STYLE_PRESETS.map(preset => (
          <Tile
            key={preset.id}
            label={pick(zh, preset.name)}
            aria-pressed={pressed === preset.id}
            current={match?.preset.id === preset.id}
            disabled={disabled}
            onClick={() => choose(preset)}
          >
            <StageArt image={image} />
            <span className={styles.captionSample} style={captionSampleStyle(preset)}>{zh ? '字幕样式' : 'Caption'}</span>
          </Tile>
        ))}
      </div>
      <Button
        size="sm"
        block
        variant="bare"
        disabled={disabled || !targets.length || Boolean(tooMany)}
        disabledReason={tooMany}
        onClick={() => void onApply(zh ? '统一字幕样式' : 'Style all captions', movieCaptionStyleOperations(targets, chosen))}
      >
        {applyAllLabel(zh, targets.length, pick(zh, chosen.name))}
      </Button>
    </div>
  );
}

function captionSampleStyle(preset: MovieCaptionStylePreset): CSSProperties {
  const look = { ...MOVIE_DEFAULT_CAPTION_STYLE, ...preset.style };
  return {
    color: look.color,
    background: look.backgroundOpacity > 0 ? `color-mix(in srgb, ${look.background} ${Math.round(look.backgroundOpacity * 100)}%, transparent)` : 'transparent',
    fontSize: `${Math.max(9, Math.round(look.fontSize * 0.24))}px`,
    WebkitTextStroke: look.outline ? `${Math.min(1.5, look.outline * 0.4)}px rgba(0, 0, 0, 0.9)` : undefined,
  };
}

// ─── Transitions ─────────────────────────────────────────────────────────────────────────────────

function TransitionsSection({ zh, document: d, sources, url, disabled, selectedShotId, selectionKind, onApply }: SectionProps) {
  const selected = resolveSelection(d, selectedShotId, selectionKind).visual;
  const visual = selected ? movieShotVisual(d, selected) : undefined;
  const applied = visual ? movieTransitionKind(visual) : undefined;
  const [kind, setKind] = useState<MovieTransitionKind>(() => applied ?? 'crossfade');
  const [seconds, setSeconds] = useState<number>(() => visual?.transitionDuration ?? MOVIE_TRANSITION_SECONDS.default);
  // Follow the selected clip's own transition whenever the selection or its transition changes.
  const selectedId = selected?.id;
  const selectedSeconds = visual?.transitionDuration;
  useEffect(() => {
    if (!selectedId) return;
    if (applied) setKind(applied);
    setSeconds(selectedSeconds ?? MOVIE_TRANSITION_SECONDS.default);
  }, [selectedId, applied, selectedSeconds]);
  const targets = useMemo(() => movieTransitionTargets(d), [d]);
  const tooMany = movieApplyAllBlocked(targets.length, zh);
  const ready = selected ? movieTransitionReady(d, selected) : false;
  const blocked = !selected ? (zh ? '先选择一个画面片段' : 'Select a picture clip first')
    : selected.locked ? lockedHint(zh)
      : !ready ? (zh ? '没有相邻的下一片段' : 'No adjacent next clip')
        : undefined;
  const hint = !selected ? (zh ? '选择一个画面片段，转场作用在它和下一片段之间。' : 'Select a picture clip; the transition plays between it and the next clip.')
    : selected.locked ? lockedHint(zh)
      : !ready ? (zh ? '将下一片段贴到本轨末尾，转场就会生效。' : 'Place the next clip directly after this one on the same track.')
        : undefined;
  const from = previewImage(d, sources, url, selected);
  const next = selected ? d.shots[movieNextShotIndex(d, d.shots.indexOf(selected))] : undefined;
  const to = isMovieVisualClip(next) ? shotImage(sources, url, next) : undefined;
  return (
    <>
      <SelectionNote zh={zh} shot={selected} />
      <div className={styles.tileGrid}>
        {MOVIE_TRANSITIONS.map(transition => (
          <Tile
            key={transition.id}
            surface="schematic"
            label={pick(zh, transition.name)}
            aria-pressed={kind === transition.id}
            current={applied === transition.id}
            disabled={disabled}
            onClick={() => setKind(transition.id)}
          >
            <TransitionArt kind={transition.id} from={from} to={to} />
          </Tile>
        ))}
      </div>
      <SliderField
        label={zh ? '转场时长' : 'Duration'}
        value={seconds}
        min={MOVIE_TRANSITION_SECONDS.min}
        max={MOVIE_TRANSITION_SECONDS.max}
        step={0.05}
        unit={zh ? ' 秒' : 's'}
        disabled={disabled || kind === 'cut'}
        onChange={setSeconds}
      />
      <div className={styles.applyRow}>
        <Button
          size="sm"
          disabled={disabled || Boolean(blocked)}
          disabledReason={blocked}
          onClick={() => { if (selected) void onApply(zh ? '设置转场' : 'Set transition', movieTransitionOperations(d, [selected], kind, seconds)); }}
        >
          {zh ? '应用到所选' : 'Apply to selected'}
        </Button>
        <Button
          size="sm"
          variant="bare"
          disabled={disabled || !targets.length || Boolean(tooMany)}
          disabledReason={tooMany}
          onClick={() => void onApply(zh ? '统一片段转场' : 'Set all transitions', movieTransitionOperations(d, targets, kind, seconds))}
        >
          {applyAllLabel(zh, targets.length)}
        </Button>
      </div>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </>
  );
}

/**
 * Shot A under shot B, frozen mid-transition until hovered. B is the next clip's frame, or A's
 * frame mirrored and dimmed when both show the same footage.
 */
function TransitionArt({ kind, from, to }: { kind: MovieTransitionKind; from?: string; to?: string }) {
  const second = to && to !== from ? to : from;
  return (
    <span className={styles.transition} data-transition={kind}>
      <span className={styles.paneA}>{from ? <img className={styles.stageImage} src={from} alt="" draggable={false} /> : null}</span>
      <span className={styles.paneB} data-mirror={second === from ? '' : undefined}>
        {second ? <img className={styles.stageImage} src={second} alt="" draggable={false} /> : null}
      </span>
    </span>
  );
}

function SliderField({ label, value, min, max, step, unit, disabled, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <label className={styles.slider}>
      <span className={styles.sliderLabel}>{label}</span>
      <input
        type="range"
        className={styles.range}
        style={{ '--slider-fill': fill } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={event => onChange(Number(event.target.value))}
      />
      <span className={styles.sliderValue}>{value.toFixed(2)}{unit}</span>
    </label>
  );
}

// ─── Filters ─────────────────────────────────────────────────────────────────────────────────────

function FiltersSection({ zh, document: d, sources, disabled, url, selectedShotId, selectionKind, onApply }: SectionProps) {
  const selected = resolveSelection(d, selectedShotId, selectionKind).visual;
  const match = selected ? movieFilterMatch(movieClipColor(selected.clip)) : undefined;
  const { pressed, chosen, choose } = usePresetChoice(MOVIE_FILTER_PRESETS, selected, match, preset => {
    if (selected && !selected.locked) void onApply(zh ? '应用滤镜' : 'Apply filter', movieFilterOperations([selected], preset.color));
  });
  const targets = useMemo(() => movieFilterTargets(d), [d]);
  const tooMany = movieApplyAllBlocked(targets.length, zh);
  const image = previewImage(d, sources, url, selected);
  return (
    <>
      <SelectionNote zh={zh} shot={selected} empty={zh ? '选择画面片段后点击滤镜即可应用；也可以选好滤镜后应用到全部。' : 'Select a clip and click a filter, or pick one and apply it to all.'} />
      {selected?.locked ? <p className={styles.hint}>{lockedHint(zh)}</p> : null}
      <NearLookHint zh={zh} match={match} />
      <div className={styles.tileGrid} data-columns="3">
        {MOVIE_FILTER_PRESETS.map(preset => {
          const filter = movieColorFilter(preset.color, PREVIEW_BLUR_SCALE);
          return (
            <Tile
              key={preset.id}
              label={pick(zh, preset.name)}
              aria-pressed={pressed === preset.id}
              current={match?.preset.id === preset.id}
              disabled={disabled}
              onClick={() => choose(preset)}
            >
              {image ? <img className={styles.stageImage} src={image} alt="" draggable={false} style={{ filter }} /> : <span className={styles.filterSwatch} style={{ filter }} />}
            </Tile>
          );
        })}
      </div>
      <Button
        size="sm"
        block
        variant="bare"
        disabled={disabled || !targets.length || Boolean(tooMany)}
        disabledReason={tooMany}
        onClick={() => void onApply(zh ? '统一画面滤镜' : 'Apply filter to all', movieFilterOperations(targets, chosen.color))}
      >
        {applyAllLabel(zh, targets.length, pick(zh, chosen.name))}
      </Button>
    </>
  );
}

// ─── Animation ───────────────────────────────────────────────────────────────────────────────────

const MOTION_ICONS: Record<MovieClipAnimationKind, LucideIcon> = {
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  'slide-left': ArrowRightToLine,
  'slide-right': ArrowLeftToLine,
  'fade-in': Sunrise,
  'fade-out': Sunset,
};

function AnimationSection(props: SectionProps) {
  const { zh, document: d, selectedShotId, selectionKind } = props;
  const { visual, text } = resolveSelection(d, selectedShotId, selectionKind);
  if (text) return <TextEntrance {...props} shot={text} />;
  if (visual) return <ClipMotion {...props} shot={visual} />;
  return (
    <EmptyNote
      icon={Orbit}
      title={zh ? '选择要添加动画的片段' : 'Select a clip to animate'}
      detail={zh ? '在时间线上选择画面或文字片段。' : 'Select a picture or text clip on the timeline.'}
    />
  );
}

function ClipMotion({ zh, shot, document: d, sources, url, disabled, onApply }: SectionProps & { shot: MovieVisualShot }) {
  const current = movieClipAnimationFor(shot.clip);
  const keyframes = shot.clip.keyframes?.length ?? 0;
  const locked = Boolean(shot.locked);
  const image = previewImage(d, sources, url, shot);
  return (
    <>
      <SelectionNote zh={zh} shot={shot} />
      <div className={styles.tileGrid} data-columns="3">
        {MOVIE_CLIP_ANIMATIONS.map(animation => (
          <Tile
            key={animation.id}
            label={pick(zh, animation.name)}
            aria-pressed={current === animation.id}
            current={current === animation.id}
            disabled={disabled || locked}
            onClick={() => void onApply(zh ? '添加画面动画' : 'Animate clip', movieClipAnimationOperations(shot, animation.id))}
          >
            <span className={styles.motionPicture} data-motion={animation.id}>
              {image ? <img className={styles.stageImage} src={image} alt="" draggable={false} /> : null}
              <span className={styles.motionGlyph}><Icon icon={MOTION_ICONS[animation.id]} size={12} /></span>
            </span>
          </Tile>
        ))}
      </div>
      <Button
        size="sm"
        block
        variant="bare"
        disabled={disabled || locked || !keyframes}
        onClick={() => void onApply(zh ? '清除画面动画' : 'Clear clip animation', movieClearClipAnimationOperations(shot))}
      >
        <Icon icon={Eraser} size="sm" />{zh ? '清除动画' : 'Clear animation'}
      </Button>
      {locked ? <p className={styles.hint}>{lockedHint(zh)}</p> : null}
      {!locked && keyframes && !current ? (
        <p className={styles.hint}>{zh ? '片段已有自定义关键帧，应用预设会替换它们。' : 'This clip has custom keyframes; a preset replaces them.'}</p>
      ) : null}
    </>
  );
}

function TextEntrance({ zh, shot, document: d, sources, url, disabled, onApply }: SectionProps & { shot: MovieShot }) {
  const current: MovieTextAnimation = shot.textAnimation ?? 'none';
  const image = previewImage(d, sources, url, undefined);
  const locked = Boolean(shot.locked);
  return (
    <>
      <SelectionNote zh={zh} shot={shot} />
      <h3 className={styles.sectionHeading}>{zh ? '文字入场' : 'Text entrance'}</h3>
      <div className={styles.tileGrid} data-columns="3">
        {MOVIE_TEXT_ANIMATIONS.map(animation => (
          <Tile
            key={animation.id}
            label={pick(zh, animation.name)}
            aria-pressed={current === animation.id}
            current={current === animation.id}
            disabled={disabled || locked}
            onClick={() => void onApply(zh ? '文字入场动画' : 'Animate text', movieTextAnimationOperations(shot, animation.id))}
          >
            <StageArt image={image} />
            <span className={styles.textSample} data-animation={animation.id}>{zh ? '文字' : 'Text'}</span>
          </Tile>
        ))}
      </div>
      {locked ? <p className={styles.hint}>{lockedHint(zh)}</p> : null}
    </>
  );
}

// ─── Shared pieces ───────────────────────────────────────────────────────────────────────────────

type TileProps = ComponentPropsWithoutRef<'button'> & {
  /** Text under the frame; also the button's accessible name. */
  label?: string;
  /** What the selected clip has now: a check in the corner. `aria-pressed` marks the choice. */
  current?: boolean;
  /** `stage` stays dark like footage in both themes; `schematic` follows the theme. */
  surface?: 'stage' | 'schematic';
};

function Tile({ label, current, surface = 'stage', children, ...button }: TileProps) {
  return (
    <button type="button" className={styles.tile} title={label} aria-current={current ? 'true' : undefined} {...button}>
      <span className={styles.frame} data-surface={surface} aria-hidden="true">
        {children}
        {current ? <span className={styles.check}><Icon icon={Check} size={10} /></span> : null}
      </span>
      {label ? <span className={styles.tileLabel}>{label}</span> : null}
    </button>
  );
}

/** A footage frame behind look previews; the dark stage stands in when the project has no frames. */
function StageArt({ image }: { image?: string }) {
  return (
    <>
      {image ? <img className={styles.stageImage} src={image} alt="" draggable={false} /> : null}
      <span className={styles.stageScrim} />
    </>
  );
}

/**
 * Preset tiles that apply on click. While a clip is selected the pressed tile is the preset its
 * look shows as; the last choice is what "apply to all" applies. Clicking the preset a clip already
 * has exactly adds no undo step.
 */
function usePresetChoice<T extends { id: string }>(
  presets: readonly T[],
  shot: MovieShot | undefined,
  match: MovieLookMatch<T> | undefined,
  apply: (preset: T) => void,
) {
  const current = match?.preset.id;
  const [choice, setChoice] = useState(current ?? presets[0]!.id);
  useEffect(() => { if (current) setChoice(current); }, [current]);
  const choose = (preset: T) => {
    setChoice(preset.id);
    if (!(match?.exact && current === preset.id)) apply(preset);
  };
  return {
    pressed: shot ? current : choice,
    chosen: presets.find(preset => preset.id === choice) ?? presets[0]!,
    choose,
  };
}

/** Explains a check on a preset the clip only comes close to. */
function NearLookHint({ zh, match }: { zh: boolean; match?: MovieLookMatch<{ name: MovieBilingual }> }) {
  if (!match || match.exact) return null;
  const name = pick(zh, match.preset.name);
  return <p className={styles.hint}>{zh ? `当前效果接近「${name}」，点选会套用预设的数值。` : `The current look is close to “${name}”; choosing it applies the preset values.`}</p>;
}

/** Names the clip an action targets, or explains how to pick one. */
function SelectionNote({ zh, shot, empty }: { zh: boolean; shot?: MovieShot; empty?: string }) {
  if (!shot) return empty ? <p className={styles.hint}>{empty}</p> : null;
  return (
    <p className={styles.target}>
      <span className={styles.targetLabel}>{zh ? '所选片段' : 'Selected'}</span>
      <span className={styles.targetName} title={shot.title}>{shotName(zh, shot)}</span>
    </p>
  );
}

function EmptyNote({ icon, title, detail, children }: { icon: LucideIcon; title: string; detail: string; children?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <Icon icon={icon} size={20} className={styles.emptyIcon} />
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyDetail}>{detail}</p>
      {children ? <div className={styles.emptyActions}>{children}</div> : null}
    </div>
  );
}

function shotName(zh: boolean, shot: MovieShot): string {
  return shot.title || (zh ? '未命名片段' : 'Untitled clip');
}

function lockedHint(zh: boolean): string {
  return zh ? '此片段已锁定，解锁后才能修改。' : 'This clip is locked. Unlock it to change it.';
}

function noSoundHint(zh: boolean): string {
  return zh ? '所选片段没有原声。' : 'The selected clip has no sound.';
}

/** "Apply to all" with the clip count, naming the preset when there is room for it. */
function applyAllLabel(zh: boolean, count: number, name?: string): string {
  if (!name) return zh ? `应用到全部 · ${count}` : `Apply to all · ${count}`;
  return zh ? `全部应用「${name}」· ${count}` : `Apply “${name}” to all · ${count}`;
}

function resolveSelection(d: MovieDocument, selectedShotId: string | undefined, selectionKind: 'video' | 'audio' | undefined) {
  const shot = selectedShotId ? d.shots.find(item => item.id === selectedShotId) : undefined;
  return {
    /** A selected clip with a picture (not its linked audio, not detached audio). */
    visual: shot && selectionKind !== 'audio' && isMovieVisualClip(shot) ? shot : undefined,
    text: shot?.kind === 'text' ? shot : undefined,
  };
}

function audioSources(sources: MovieVideoSource[]): MovieVideoSource[] {
  return sources.filter(source => source.kind === 'audio');
}

/** The poster: the frame a quarter in, whether the daemon sampled 6 frames or 48 (none for audio). */
function sourceFrame(source: MovieVideoSource | undefined) {
  const frames = source?.frames ?? [];
  return frames[Math.floor(frames.length / 4)];
}

function shotImage(sources: MovieVideoSource[], url: (path: string) => string, shot: MovieVisualShot): string | undefined {
  const frame = sourceFrame(sources.find(source => source.assetId === shot.clip.assetId));
  return frame ? url(frame.path) : undefined;
}

/** A footage frame for look previews: the selected clip's source, else the film's first picture. */
function previewImage(d: MovieDocument, sources: MovieVideoSource[], url: (path: string) => string, selected: MovieVisualShot | undefined): string | undefined {
  const shots = [...(selected ? [selected] : []), ...d.shots.filter(isMovieVisualClip)];
  const fromFilm = shots.map(shot => shotImage(sources, url, shot)).find(Boolean);
  if (fromFilm) return fromFilm;
  const frame = sources.filter(source => source.kind !== 'audio').map(sourceFrame).find(Boolean);
  return frame ? url(frame.path) : undefined;
}

function sourceIcon(source: MovieVideoSource): LucideIcon {
  return source.kind === 'audio' ? Music2 : source.kind === 'image' ? ImageIcon : Film;
}

function startSourceDrag(event: DragEvent<HTMLElement>, source: MovieVideoSource) {
  event.dataTransfer.setData(SOURCE_DRAG_TYPE, source.assetId);
  event.dataTransfer.effectAllowed = 'copy';
}

function downloadSubtitles(shot: MovieShot) {
  const href = URL.createObjectURL(new Blob([movieSubtitlesText(shot.captions ?? [])], { type: 'application/x-subrip;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = `${(shot.title || 'captions').replace(/[\\/:*?"<>|]+/g, '-')}.srt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Scrolls `box` the least amount that shows all of `row` (a positioned child). */
function keepInView(box: HTMLElement, row: HTMLElement) {
  if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
}

/** `mm:ss` (or `h:mm:ss`), rounded down; `tenths` adds `.d` for caption times. */
function formatClock(seconds: number, tenths = false): string {
  const deciseconds = Math.floor(Math.max(0, seconds) * 10 + 1e-6);
  const total = Math.floor(deciseconds / 10);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const clock = `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  const whole = hours ? `${hours}:${clock}` : clock;
  return tenths ? `${whole}.${deciseconds % 10}` : whole;
}
