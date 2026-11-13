import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Download, Film, FolderOpen, MessageSquare,
  MoreHorizontal, Pause, Play, Plus, Scan, SkipBack, SkipForward, SlidersHorizontal, StepBack, StepForward, Type, X,
} from 'lucide-react';
import {
  movieDuration, movieEditingSkill, movieFps, movieFrameSize,
  type MovieDocument, type MovieEditOperation, type MovieEditReceipt as Receipt, type MovieVideoSource, type MovieExportOptions, type MovieRender,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceResourceUrl } from '../../collab/workspace-identity';
import { useI18n } from '../../i18n';
import { useFantayShell } from '../../fantay/shell/shell-context';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Icon,
  IconButton, isMacPlatform, Modal, ModalTitle, Popover, PopoverContent, PopoverTrigger, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue, Textarea,
} from '../../fantay/ui';
import styles from './MovieEditingWorkspace.module.css';
import { formatTimecode, parseTimecode } from './palmier/palmier-core';
import { MovieSourcePreview } from './MovieSourcePreview';
import { JianyingDraftDialog } from './JianyingDraftDialog';
import { MovieExportDialog } from './MovieExportDialog';
import { MovieEditReceipt } from './MovieEditReceipt';
import { MovieResourcePanel, type MovieResourceCategory } from './MovieResourcePanel';
import { MovieEditorActionsContext, MovieEditorLayoutContext, type MovieEditorActions } from './movie-editor-layout';

/** Pane width at which the project pane shows the complete workbench even without maximizing. */
const FULL_LAYOUT_MIN_WIDTH = 960;
const ASPECTS: MovieDocument['aspect'][] = ['16:9', '9:16', '1:1'];
/** Timeline fractions are per layout; null keeps that layout's default. */
const SIZES = { media: 320, inspector: 320, timeline: { compact: 0.35, full: 0.42 } } as const;
type TimelineLayout = keyof typeof SIZES.timeline;

/** An edit that reached the document from somewhere else (in practice the project chat's agent). */
export interface MovieExternalChange {
  receipt: Receipt;
  /** Index of the changed clip currently focused by ‹ ›, or -1 before navigation. */
  index: number;
}

export interface MovieEditingWorkspaceProps {
  document: MovieDocument;
  projectId: string;
  context?: WorkspaceCollabContext | null;
  sources: MovieVideoSource[];
  selectedShotId?: string;
  selectionKind?: 'video' | 'audio';
  preview: ReactNode;
  liveTools?: ReactNode;
  liveMarkers?: ReactNode;
  timeline: ReactNode;
  inspector: ReactNode;
  generation: ReactNode;
  /** Embedded presentation only: in the project pane the AI lives in the project chat beside the editor. */
  chat?: ReactNode;
  exportOptions?: ReactNode;
  time: number;
  playing: boolean;
  disabled: boolean;
  error: string;
  dirty: boolean;
  undoReason?: string;
  redoReason?: string;
  aiBusy: boolean;
  generationBusy: boolean;
  busyLabel?: string;
  externalChange?: MovieExternalChange | null;
  /** Transcription of the selected clip is running. */
  transcribing?: boolean;
  /** The inspector holds unapplied changes: its host must stay open until they are applied or cancelled. */
  inspectorDirty?: boolean;
  /** true in the project pane (compact until maximized or widened); false for the standalone embedded editor. */
  compact?: boolean;
  onExit?: () => void;
  onImport(): void;
  onUpload?(files: File[]): Promise<void>;
  onAddText?(): void;
  onAddSource(source: MovieVideoSource, range?: { in: number; duration: number }, mode?: 'append' | 'overlay'): void;
  onPlay(): void;
  onSeek(t: number): void;
  onUndo(): void;
  onRedo(): void;
  onExport(options: MovieExportOptions): Promise<MovieRender | null> | void;
  onSave(): void;
  onPlan(): void;
  onReview(): void;
  /** Embedded presentation only. */
  onAi?(request: string): Promise<boolean>;
  /** The shared atomic edit path (same as AI and the timeline). */
  onApply?(label: string, operations: MovieEditOperation[]): Promise<boolean>;
  onSelect?(shotId: string, kind?: 'video' | 'audio'): void;
  onTranscribe?(): void;
  onAspectChange?(aspect: MovieDocument['aspect']): void;
  onDismissError?(): void;
  onChangeNav?(direction: -1 | 1): void;
  onChangeDismiss?(): void;
}

type ResizeKind = 'media' | 'inspector' | 'timeline';

export function MovieEditingWorkspace(props: MovieEditingWorkspaceProps) {
  const {
    document: d, projectId, context, sources, selectedShotId, selectionKind, preview, timeline, inspector, generation, liveTools, liveMarkers,
    chat, exportOptions, time, playing, disabled, error, dirty, aiBusy, generationBusy, busyLabel,
    externalChange, transcribing, inspectorDirty = false, compact = false, onExit, onImport, onUpload, onAddText, onAddSource, onPlay, onSeek, onExport,
    onSave, onPlan, onReview, onAi, onApply, onSelect, onTranscribe, onAspectChange, onDismissError, onChangeNav,
    onChangeDismiss,
  } = props;
  const { locale, t } = useI18n();
  const zh = locale.startsWith('zh');
  const shell = useFantayShell();
  const root = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const inspectorDock = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [wide, setWide] = useState(false);
  const full = !compact || Boolean(shell?.workspaceMaximized) || wide;
  const [mediaOpen, setMediaOpen] = useState(full);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [category, setCategory] = useState<MovieResourceCategory>('media');
  const [sourcePreview, setSourcePreview] = useState<MovieVideoSource | null>(null);
  const [pendingSource, setPendingSource] = useState<MovieVideoSource | null>(null);
  const [generating, setGenerating] = useState(false);
  const [jianyingMode, setJianyingMode] = useState<'create' | 'edit' | null>(null);
  const aiAvailable = !compact && Boolean(chat || onAi);
  const [agentOpen, setAgentOpen] = useState(aiAvailable);
  const [prompt, setPrompt] = useState('');
  const [mediaWidth, setMediaWidth] = useState<number>(SIZES.media);
  const [inspectorWidth, setInspectorWidth] = useState<number>(SIZES.inspector);
  const [timelineFractions, setTimelineFractions] = useState<Record<TimelineLayout, number | null>>({ compact: null, full: null });
  const timelineLayout: TimelineLayout = full ? 'full' : 'compact';
  const timelineFraction = timelineFractions[timelineLayout] ?? SIZES.timeline[timelineLayout];
  const setTimelineFraction = (value: number | null | ((current: number) => number)) => setTimelineFractions(sizes => ({
    ...sizes,
    [timelineLayout]: typeof value === 'function' ? value(sizes[timelineLayout] ?? SIZES.timeline[timelineLayout]) : value,
  }));
  const [timeDraft, setTimeDraft] = useState('');
  const [editingTime, setEditingTime] = useState(false);
  const cancelTime = useRef(false);
  const [noticeHidden, setNoticeHidden] = useState(false);
  const resize = useRef<{ kind: ResizeKind; x: number; y: number; initial: number } | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= FULL_LAYOUT_MIN_WIDTH);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  // The workbench docks the resource panel; the compact pane keeps it as a drawer over the stage.
  useEffect(() => {
    setMediaOpen(full);
    // A dirty draft moving from the dock to the compact pane needs its popover open to stay reachable.
    setAdjustOpen(!full && inspectorDirty);
  }, [full]);
  useEffect(() => {
    const open = () => setGenerating(true);
    window.addEventListener('fantay-native-generation', open);
    return () => window.removeEventListener('fantay-native-generation', open);
  }, []);

  const fps = movieFps(d);
  const total = movieDuration(d);
  const frameSize = movieFrameSize(d);
  /** Always HH:MM:SS:FF (剪映 style); the input also accepts MM:SS:FF and plain seconds. */
  const format = (seconds: number) => formatTimecode(Math.max(0, Math.round(seconds * fps)), fps);
  useEffect(() => { if (!editingTime) setTimeDraft(format(time)); }, [time, fps, editingTime]);
  useEffect(() => setSourcePreview(null), [time]);
  useEffect(() => {
    if (!playing && pendingSource) { setSourcePreview(pendingSource); setPendingSource(null); }
  }, [playing, pendingSource]);
  useEffect(() => setNoticeHidden(false), [d.editorMigration?.warnings.join('\n')]);

  const actions = useMemo<MovieEditorActions>(() => ({
    openExport: () => setExportOpen(true),
    openJianying: mode => setJianyingMode(mode),
    openInspector: () => {
      if (!full) { setAdjustOpen(true); return; }
      const field = inspectorDock.current?.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled]),[role=tab][aria-selected=true]');
      field?.focus({ preventScroll: false });
    },
  }), [full]);

  const url = (path: string) => workspaceResourceUrl(`/api/projects/${projectId}/raw/${path}`, context);
  const importMedia = () => (onUpload ? fileInput.current?.click() : onImport());
  const inspectSource = (source: MovieVideoSource) => {
    if (playing) { setPendingSource(source); onPlay(); } else setSourcePreview(source);
    if (!full) setMediaOpen(false);
  };
  const addSource = (source: MovieVideoSource, mode: 'append' | 'overlay') => {
    onAddSource(source, undefined, mode);
    setSourcePreview(null);
    if (!full) setMediaOpen(false);
  };
  const commitTime = () => {
    if (cancelTime.current) { cancelTime.current = false; setEditingTime(false); return; }
    const text = timeDraft.trim();
    const fields = text.split(':').length;
    const value = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : (parseTimecode(fields === 3 ? `00:${text}` : text, fps) ?? NaN) / fps;
    if (Number.isFinite(value)) onSeek(Math.max(0, Math.min(total, value)));
    setEditingTime(false);
  };
  const sendAi = async () => {
    if (!onAi || !prompt.trim() || aiBusy) return;
    if (await onAi(prompt.trim())) setPrompt('');
  };
  const downloadSkill = () => {
    const href = URL.createObjectURL(new Blob([movieEditingSkill(d)], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = 'SKILL.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const beginResize = (e: PointerEvent<HTMLButtonElement>, kind: ResizeKind) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { kind, x: e.clientX, y: e.clientY, initial: kind === 'media' ? mediaWidth : kind === 'inspector' ? inspectorWidth : timelineFraction };
  };
  const moveResize = (e: PointerEvent<HTMLButtonElement>) => {
    const r = resize.current;
    const element = root.current;
    if (!r || !element) return;
    const width = element.clientWidth;
    if (r.kind === 'media') setMediaWidth(Math.max(260, Math.min(440, width - inspectorWidth - 400, r.initial + e.clientX - r.x)));
    else if (r.kind === 'inspector') setInspectorWidth(Math.max(280, Math.min(420, width - mediaWidth - 400, r.initial - e.clientX + r.x)));
    else setTimelineFraction(Math.max(0.2, Math.min(0.68, r.initial - (e.clientY - r.y) / element.clientHeight)));
  };
  const endResize = () => { resize.current = null; };
  const resetSize = (kind: ResizeKind) => {
    if (kind === 'media') setMediaWidth(SIZES.media);
    else if (kind === 'inspector') setInspectorWidth(SIZES.inspector);
    else setTimelineFraction(null);
  };
  /** Arrow keys resize from the keyboard (Shift for larger steps); Enter resets. */
  const nudgeSize = (e: KeyboardEvent<HTMLButtonElement>, kind: ResizeKind) => {
    const step = e.shiftKey ? 48 : 16;
    const width = root.current?.clientWidth ?? 0, height = root.current?.clientHeight || 1;
    if (e.key === 'Enter') { e.preventDefault(); resetSize(kind); return; }
    if (kind === 'timeline' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); e.stopPropagation();
      setTimelineFraction(value => Math.max(0.2, Math.min(0.68, value + (e.key === 'ArrowUp' ? step : -step) / height)));
    } else if (kind !== 'timeline' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopPropagation();
      const delta = (e.key === 'ArrowRight' ? step : -step) * (kind === 'media' ? 1 : -1);
      if (kind === 'media') setMediaWidth(value => Math.max(260, Math.min(440, width - inspectorWidth - 400, value + delta)));
      else setInspectorWidth(value => Math.max(280, Math.min(420, width - mediaWidth - 400, value + delta)));
    }
  };
  const gutter = (kind: ResizeKind, label: string) => (
    <button
      type="button" className={kind === 'timeline' ? styles.rowGutter : styles.gutter} aria-label={label}
      title={zh ? '拖动调整，双击恢复' : 'Drag to resize, double-click to reset'}
      onPointerDown={e => beginResize(e, kind)} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}
      onDoubleClick={() => resetSize(kind)}
      onKeyDown={e => nudgeSize(e, kind)}
    />
  );

  const layoutStyle = {
    '--media-width': `${mediaWidth}px`,
    '--inspector-width': `${inspectorWidth}px`,
    // Unset until dragged, so each layout's CSS default (35% compact, 42% full) applies.
    ...(timelineFractions[timelineLayout] === null ? {} : { '--timeline-height': `${timelineFraction * 100}%` }),
  } as CSSProperties;
  const stageStyle = { '--movie-ratio': String(frameSize.width / Math.max(1, frameSize.height)) } as CSSProperties;
  const mod = isMacPlatform() ? '⌘' : 'Ctrl+';
  const savedAt = (() => {
    const date = new Date(d.updatedAt);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(zh ? 'zh-CN' : undefined, { hour: '2-digit', minute: '2-digit' });
  })();

  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" tooltipSide="bottom" aria-label={zh ? '更多操作' : 'More actions'}><Icon icon={MoreHorizontal} size="sm" /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={disabled} onSelect={onImport}>{zh ? '从素材库导入视频' : 'Import from library'}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => setGenerating(true)}>{zh ? '生成视频素材' : 'Generate video'}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled} onSelect={() => setJianyingMode('create')}>{t('jianying.create')}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => setJianyingMode('edit')}>{t('jianying.edit')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled} onSelect={onPlan}>{zh ? '分镜' : 'Storyboard'}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={onReview}>{zh ? '审片' : 'Review'}</DropdownMenuItem>
        <DropdownMenuItem onSelect={downloadSkill}>{zh ? '导出剪辑 Skill' : 'Export editing Skill'}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const exportControls = (
    <div className={styles.exportGroup}>
      <Button size="sm" variant="primary" disabled={(!busyLabel && disabled) || !d.shots.length} onClick={() => setExportOpen(true)}>
        <Icon icon={Download} size="sm" />{busyLabel ? (zh ? '导出中…' : 'Exporting…') : (zh ? '导出' : 'Export')}
      </Button>
    </div>
  );

  const header = full ? (
    <header className={styles.header}>
      <div className={styles.identity}>
        {onExit ? <IconButton size="sm" tooltipSide="bottom" aria-label={zh ? '返回项目' : 'Back to project'} onClick={onExit}><Icon icon={ArrowLeft} size="sm" /></IconButton> : null}
        <strong className={styles.title} title={d.title}>{d.title}</strong>
        <span className={styles.persistence} data-dirty={dirty} role="status">
          {dirty ? (zh ? '未保存' : 'Unsaved') : `${zh ? '已保存' : 'Saved'}${savedAt ? ` ${savedAt}` : ''}`}
        </span>
      </div>
      <div className={styles.actions}>
        {aiAvailable ? (
          <Button size="sm" variant="bare" aria-pressed={agentOpen} onClick={() => setAgentOpen(open => !open)}>
            <Icon icon={MessageSquare} size="sm" />AI
          </Button>
        ) : null}
        {dirty ? <Button size="sm" variant="secondary" onClick={onSave}>{zh ? '保存' : 'Save'}</Button> : null}
        {moreMenu}
        <span className={styles.actionDivider} />
        {exportControls}
      </div>
    </header>
  ) : (
    <header className={styles.header}>
      <div className={styles.identity}>
        <strong className={styles.title} title={d.title}>{d.title}</strong>
        <span className={styles.saveDot} data-dirty={dirty} role="status" aria-label={dirty ? (zh ? '未保存' : 'Unsaved') : (zh ? '已保存' : 'Saved')} />
      </div>
      <div className={styles.actions}>
        <IconButton size="sm" tooltipSide="bottom" aria-label={zh ? '导入素材' : 'Import media'} disabled={disabled} onClick={importMedia}><Icon icon={Plus} size="sm" /></IconButton>
        {onAddText ? <IconButton size="sm" tooltipSide="bottom" aria-label={zh ? '添加文字' : 'Add text'} disabled={disabled} onClick={onAddText}><Icon icon={Type} size="sm" /></IconButton> : null}
        <IconButton size="sm" tooltipSide="bottom" aria-label={zh ? '素材与效果' : 'Media and effects'} on={mediaOpen} onClick={() => setMediaOpen(open => !open)}><Icon icon={FolderOpen} size="sm" /></IconButton>
        <Popover open={adjustOpen} onOpenChange={open => { if (!open && inspectorDirty) return; setAdjustOpen(open); }}>
          <PopoverTrigger asChild>
            <IconButton size="sm" tooltipSide="bottom" aria-label={zh ? '片段与项目调整' : 'Clip and project settings'} on={adjustOpen}><Icon icon={SlidersHorizontal} size="sm" /></IconButton>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" width={360}><div className={styles.adjustContent}>{adjustOpen ? inspector : null}</div></PopoverContent>
        </Popover>
        <span className={styles.actionDivider} />
        {moreMenu}
        {dirty ? <Button size="sm" variant="secondary" onClick={onSave}>{zh ? '保存' : 'Save'}</Button> : null}
        {/* Quiet text twin of the pane tab bar's maximize; hidden when narrow, where that one remains. */}
        {shell ? (
          <Button size="sm" variant="bare" className={styles.expandButton} onClick={() => shell.setWorkspaceMaximized(true)}>
            {zh ? '完整剪辑' : 'Full editor'}
          </Button>
        ) : null}
        {exportControls}
      </div>
    </header>
  );

  const changeChip = externalChange ? (
    <div className={styles.changeChip} role="status">
      <span className={styles.changeDot} aria-hidden />
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={styles.changeLabel}>
            {zh ? '来自对话：' : 'From chat: '}{externalChange.receipt.label}
            {` · ${externalChange.receipt.changedShotIds.length} ${zh ? '处' : 'changes'}`}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" width="lg"><MovieEditReceipt receipt={externalChange.receipt} /></PopoverContent>
      </Popover>
      {externalChange.receipt.changedShotIds.length > 1 ? (
        <>
          <IconButton size="xs" aria-label={zh ? '上一处改动' : 'Previous change'} onClick={() => onChangeNav?.(-1)}><Icon icon={ChevronLeft} size="sm" /></IconButton>
          <IconButton size="xs" aria-label={zh ? '下一处改动' : 'Next change'} onClick={() => onChangeNav?.(1)}><Icon icon={ChevronRight} size="sm" /></IconButton>
        </>
      ) : (
        <IconButton size="xs" aria-label={zh ? '定位改动' : 'Show change'} onClick={() => onChangeNav?.(1)}><Icon icon={ChevronRight} size="sm" /></IconButton>
      )}
      <IconButton size="xs" aria-label={zh ? '关闭改动提示' : 'Dismiss change'} onClick={onChangeDismiss}><Icon icon={X} size="sm" /></IconButton>
    </div>
  ) : null;

  const warnings = d.editorMigration?.warnings ?? [];
  const stage = sourcePreview ? (
    <MovieSourcePreview
      key={sourcePreview.assetId} source={sourcePreview} url={url} zh={zh} disabled={disabled}
      onClose={() => setSourcePreview(null)}
      onAdd={(range, mode) => { onAddSource(sourcePreview, range, mode); setSourcePreview(null); }}
    />
  ) : (
    <div className={styles.stage} style={stageStyle}>
      <div ref={frame} className={styles.frame}>{preview}</div>
      {!d.shots.length ? (
        <div className={styles.stageEmpty}>
          <Icon icon={Film} size={20} />
          <strong>{zh ? '导入视频，开始剪辑' : 'Import footage to begin'}</strong>
          <span>{full ? (zh ? '拖入素材，或从素材库添加' : 'Drop media here or add it from the library') : (zh ? '也可以在左侧对话里让 AI 帮你剪' : 'Or ask the project chat to cut it for you')}</span>
          <div className={styles.stageEmptyActions}>
            <Button size="sm" variant="secondary" disabled={disabled} onClick={importMedia}><Icon icon={Plus} size="sm" />{zh ? '导入视频或图片' : 'Import footage'}</Button>
            {onAddText ? <Button size="sm" variant="bare" disabled={disabled} onClick={onAddText}><Icon icon={Type} size="sm" />{zh ? '添加文字' : 'Add text'}</Button> : null}
          </div>
        </div>
      ) : null}
      {changeChip}
      {busyLabel ? <div className={styles.busyChip} role="status"><span className={styles.busySpinner} aria-hidden />{busyLabel}</div> : null}
      <div className={styles.stageBars}>
        {warnings.length && !noticeHidden ? (
          <p className={styles.noticeBar} role="status">
            <span>{warnings.join(' ')}</span>
            <IconButton size="xs" aria-label={zh ? '关闭提示' : 'Dismiss notice'} onClick={() => setNoticeHidden(true)}><Icon icon={X} size="sm" /></IconButton>
          </p>
        ) : null}
        {error ? (
          <p className={styles.errorBar} role="alert">
            <span>{error}</span>
            {onDismissError ? <IconButton size="xs" aria-label={zh ? '关闭错误' : 'Dismiss error'} onClick={onDismissError}><Icon icon={X} size="sm" /></IconButton> : null}
          </p>
        ) : null}
      </div>
    </div>
  );

  const playerBar = sourcePreview ? null : (
    <div className={styles.playerBar}>
      <div className={styles.playerSide}>
        <input
          className={styles.timecode} aria-label={zh ? '播放头时间码' : 'Playhead timecode'} value={timeDraft}
          onFocus={() => { setEditingTime(true); if (playing) onPlay(); }}
          onChange={e => setTimeDraft(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelTime.current = true; e.currentTarget.blur(); } }}
          onBlur={commitTime}
        />
        <span className={styles.totalTime}>/ {format(total)}</span>
      </div>
      <div className={styles.transport}>
        {full ? <IconButton size="sm" className={styles.skipButton} aria-label={zh ? '跳到开头' : 'Go to start'} shortcut="home" onClick={() => onSeek(0)}><Icon icon={SkipBack} size="sm" /></IconButton> : null}
        <IconButton size="sm" aria-label={zh ? '上一帧' : 'Previous frame'} shortcut="left" onClick={() => onSeek(Math.max(0, time - 1 / fps))}><Icon icon={StepBack} size="sm" /></IconButton>
        <IconButton size="md" shape="round" variant="primary" aria-label={zh ? (playing ? '暂停' : '播放') : (playing ? 'Pause' : 'Play')} shortcut="space" onClick={onPlay}>
          <Icon icon={playing ? Pause : Play} size="sm" />
        </IconButton>
        <IconButton size="sm" aria-label={zh ? '下一帧' : 'Next frame'} shortcut="right" onClick={() => onSeek(Math.min(total, time + 1 / fps))}><Icon icon={StepForward} size="sm" /></IconButton>
        {full ? <IconButton size="sm" className={styles.skipButton} aria-label={zh ? '跳到结尾' : 'Go to end'} shortcut="end" onClick={() => onSeek(total)}><Icon icon={SkipForward} size="sm" /></IconButton> : null}
      </div>
      <div className={`${styles.playerSide} ${styles.playerEnd}`}>
        {liveTools}
        {liveTools ? <span className={styles.playerDivider} aria-hidden /> : null}
        {onAspectChange ? (
          <Select value={d.aspect} disabled={disabled} onValueChange={value => onAspectChange(value as MovieDocument['aspect'])}>
            <SelectTrigger size="sm" className={styles.ratioTrigger} aria-label={zh ? '画幅比例' : 'Aspect ratio'}><SelectValue /></SelectTrigger>
            <SelectContent>{ASPECTS.map(aspect => <SelectItem key={aspect} value={aspect}>{aspect}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
        <IconButton size="sm" aria-label={zh ? '全屏预览' : 'Fullscreen preview'} onClick={() => { void frame.current?.requestFullscreen?.().catch(() => {}); }}><Icon icon={Scan} size="sm" /></IconButton>
      </div>
    </div>
  );

  const selected = d.shots.find(shot => shot.id === selectedShotId);
  const resourcePanel = (
    <MovieResourcePanel
      document={d} sources={sources} selectedShotId={selectedShotId} selectionKind={selectionKind} time={time}
      disabled={disabled} url={url} category={category} onCategoryChange={setCategory}
      onImport={importMedia} onGenerate={() => setGenerating(true)} onInspectSource={inspectSource} onAddSource={addSource}
      onApply={(label, operations) => onApply ? onApply(label, operations) : Promise.resolve(false)}
      onSeek={onSeek} onSelect={(id, kind) => onSelect?.(id, kind)} onTranscribe={onTranscribe} transcribing={transcribing}
      onClose={full ? undefined : () => setMediaOpen(false)}
    />
  );

  return (
    <MovieEditorLayoutContext.Provider value={full ? 'full' : 'compact'}>
      <MovieEditorActionsContext.Provider value={actions}>
        <section
          ref={root} style={layoutStyle} className={styles.workspace} data-testid="movie-editing-workspace"
          data-layout={full ? 'full' : 'compact'} data-workbench={full} data-compact={compact} data-media-open={mediaOpen}
          data-agent-open={aiAvailable && agentOpen}
          aria-label={zh ? '视频剪辑工作区' : 'Video editing workspace'}
          onKeyDown={e => { if (e.key === 'Escape' && !full && mediaOpen) { e.stopPropagation(); setMediaOpen(false); } }}
        >
          {header}
          <input
            ref={fileInput} hidden type="file" multiple
            accept="video/mp4,video/quicktime,video/webm,.m4v,audio/*,image/png,image/jpeg,image/webp,image/gif"
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void onUpload?.(files); }}
          />
          <div className={styles.body}>
            {aiAvailable ? (
              <aside className={styles.agentPanel} hidden={!agentOpen} aria-label={zh ? 'AI 剪辑对话' : 'AI editing chat'}>
                {chat ?? (
                  <form className={styles.composer} onSubmit={e => { e.preventDefault(); void sendAi(); }}>
                    <strong>{zh ? '描述你想做的修改' : 'Describe your edit'}</strong>
                    <Textarea rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} aria-label={zh ? 'AI 剪辑要求' : 'AI edit request'} />
                    <Button size="sm" variant="primary" disabled={aiBusy || !prompt.trim()} type="submit">{zh ? '发送' : 'Send'}</Button>
                  </form>
                )}
              </aside>
            ) : null}
            <aside className={styles.resources} aria-label={zh ? '素材与效果' : 'Media and effects'} aria-hidden={!full && !mediaOpen ? true : undefined}>
              {resourcePanel}
            </aside>
            {full ? gutter('media', zh ? '调整素材栏宽度' : 'Resize media panel') : null}
            <main className={styles.viewer}>
              {stage}
              {playerBar}
            </main>
            {full ? gutter('inspector', zh ? '调整检查器宽度' : 'Resize inspector') : null}
            {full ? (
              <aside ref={inspectorDock} className={styles.inspector} aria-label={zh ? '检查器' : 'Inspector'}>
                <div className={styles.inspectorBody}>{inspector}</div>
              </aside>
            ) : null}
          </div>
          {gutter('timeline', zh ? '调整时间线高度' : 'Resize timeline')}
          <div className={styles.timelineCard}>
            {liveMarkers}
            <div className={styles.timeline}>{timeline}</div>
            {full ? (
              <footer className={styles.status}>
                <span>{d.shots.length} {zh ? '个片段' : 'clips'} · {format(total)}{selected ? ` · ${zh ? '已选' : 'Selected'}：${selected.title}` : ''}</span>
                <span>{zh
                  ? `空格 播放 · ${mod}B 分割 · Q / W 裁剪 · ⌫ 删除 · S 预览轴 · ${mod}Z 撤销`
                  : `Space play · ${mod}B split · Q / W trim · ⌫ delete · S skim · ${mod}Z undo`}</span>
              </footer>
            ) : null}
          </div>
          <Modal open={generating} onClose={() => { if (!generationBusy) setGenerating(false); }} showClose={!generationBusy} size="2xl" aria-describedby={undefined}>
            <ModalTitle>{zh ? 'TokenToSea · 生成视频素材' : 'TokenToSea · Generate video'}</ModalTitle>{generation}
          </Modal>
          <JianyingDraftDialog open={jianyingMode !== null} mode={jianyingMode ?? 'create'} onClose={() => setJianyingMode(null)} projectId={projectId} context={context} document={d} sources={sources} />
          <MovieExportDialog open={exportOpen} onClose={() => setExportOpen(false)} document={d} projectId={projectId} context={context} rendererControl={exportOptions} progress={busyLabel} onExport={onExport} />
        </section>
      </MovieEditorActionsContext.Provider>
    </MovieEditorLayoutContext.Provider>
  );
}
