// SPDX-License-Identifier: AGPL-3.0-only
// The board's motion node body (spec 07 §3.4, plan R5/R6): a film card with a static cover (strip
// frame / sample image / poster), a live preview while hovered, selected or playing — only when
// the board grants a live slot — and a footer with play, time, scrub, a menu (render, download,
// capture to chat) and Open. The footer is a `data-board-interactive` region.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Camera, Download, Film, Pause, Play } from 'lucide-react';
import { MOVIE_DOCUMENT_FILE, movieDuration } from '@open-design/contracts';

import { useProjectCollabContext } from '../../collab/collab-context';
import { useT } from '../../i18n';
import { movieRequest } from '../../providers/movie';
import { BOARD_INTERACTIVE_ATTR, type BoardMotionBodyProps } from '../board/extensions';
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FX,
  Icon,
  IconButton,
  MenuItemIcon,
  MoreHorizontalIcon,
  Spinner,
  VisuallyHidden,
  cn,
  toast,
} from '../ui';
import { captureMotionFrame, sendFrameToChat } from './capture-frame';
import { openMotionCreate } from './motion-create-store';
import {
  formatMotionTime,
  latestDoneRender,
  motionCaptureCapability,
  motionRenderCapability,
  motionStatus,
  motionStatusLabel,
  movieRawUrl,
  resolveMotionCover,
  type MotionNodeData,
  type MovieAspect,
} from './motion-model';
import { MotionCover } from './MotionCover';
import { MoviePreviewFrame, type MoviePreviewFrameHandle } from './MoviePreviewFrame';
import { Scrubber } from './Scrubber';
import { useMovieDocument } from './useMovieDocument';
import { useMoviePreviewClock } from './useMoviePreviewClock';
import { useMovieStrip } from './useMovieStrip';
import styles from './MotionNode.module.css';

export type { MotionNodeData, MovieAspect } from './motion-model';

export interface MotionNodeProps {
  nodeId: string;
  data: MotionNodeData;
  /** Node box in world px (CSS px at zoom 1); the node fills it. */
  width: number;
  height: number;
  selected: boolean;
  /** Board-granted live slot (≤ 4 live iframes/videos board-wide). */
  live: boolean;
  /** 07: ask for / release a live slot on hover, selection and play (changes only). */
  onLiveIntent?: (wantsLive: boolean) => void;
  /** Playback started/stopped (changes only); the board pins the live slot while playing (`requestLive`). */
  onPlayingChange?: (playing: boolean) => void;
  /** movie-studio.json mtime; a change refetches the film. */
  fileVersion?: number;
  onOpenEditor: () => void;
  /** Persists title/aspect into the board record (R5: no cover persistence). */
  onDataChange?: (patch: { title?: string; aspect?: MovieAspect }) => void;
}

const interactive = { [BOARD_INTERACTIVE_ATTR]: '' } as Record<string, string>;

function stopPointer(event: PointerEvent) {
  event.stopPropagation();
}

/** Calls `callback(value)` when `value` changes after mount. */
function useOnChange<T>(value: T, callback: ((value: T) => void) | undefined) {
  const previous = useRef(value);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    latest.current?.(value);
  }, [value]);
}

export function MotionNode({
  nodeId,
  data,
  width,
  height,
  selected,
  live,
  onLiveIntent,
  onPlayingChange,
  fileVersion,
  onOpenEditor,
  onDataChange,
}: MotionNodeProps) {
  const t = useT();
  const { workspaceContext } = useProjectCollabContext();
  const { projectId } = data;
  const movie = useMovieDocument(projectId, { enabled: true, workspaceContext, version: fileVersion });
  const doc = movie.status === 'ready' ? movie.doc : null;
  const title = doc?.title || data.title || t('motion.node.label');
  const aspect: MovieAspect = doc?.aspect ?? data.aspect ?? '16:9';
  const duration = doc ? movieDuration(doc) : 0;
  const posterTime = duration * 0.4;
  const latest = doc ? latestDoneRender(doc) : null;
  const strip = useMovieStrip(projectId, latest?.render.id ?? null, { enabled: latest !== null, workspaceContext });
  const cover = useMemo(
    () => resolveMotionCover({ projectId, doc, strip, cached: data.cover, workspaceContext }),
    [projectId, doc, strip, data.cover, workspaceContext],
  );

  const frameRef = useRef<MoviePreviewFrameHandle>(null);
  const clock = useMoviePreviewClock({
    duration,
    loop: false,
    initialTime: posterTime,
    onPlay: (time) => {
      frameRef.current?.seek(time);
      frameRef.current?.play({ loop: false });
    },
    onPause: (time) => {
      frameRef.current?.pause();
      frameRef.current?.seek(time);
    },
    onSeek: (time) => frameRef.current?.seek(time),
  });
  const clockState = useRef({ time: clock.time, playing: clock.playing });
  clockState.current = { time: clock.time, playing: clock.playing };

  // The clock starts before the film is known; park it on the poster time once.
  const parked = useRef(false);
  useEffect(() => {
    if (parked.current || !(duration > 0)) return;
    parked.current = true;
    if (!clockState.current.playing) clock.seek(posterTime);
  }, [duration, posterTime, clock]);

  const [hovered, setHovered] = useState(false);
  const wantsLive = hovered || selected || clock.playing;
  useOnChange(wantsLive, onLiveIntent);
  useOnChange(clock.playing, onPlayingChange);
  // A node unmounted mid-playback (culled, removed) must not keep its live slot pinned.
  const releasePin = useRef(onPlayingChange);
  releasePin.current = onPlayingChange;
  useEffect(
    () => () => {
      if (clockState.current.playing) releasePin.current?.(false);
    },
    [],
  );
  const showLive = live && wantsLive && doc !== null;
  const liveDenied = clock.playing && !live;

  // Keep the board record's chrome (title, aspect) in step with the document.
  const sent = useRef('');
  useEffect(() => {
    if (!doc || !onDataChange) return;
    const patch: { title?: string; aspect?: MovieAspect } = {};
    if (doc.title !== data.title) patch.title = doc.title;
    if (doc.aspect !== data.aspect) patch.aspect = doc.aspect;
    const key = JSON.stringify(patch);
    if (key === '{}' || key === sent.current) return;
    sent.current = key;
    onDataChange(patch);
  }, [doc, data.title, data.aspect, onDataChange]);

  const syncFrame = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.seek(clockState.current.time);
    if (clockState.current.playing) frame.play({ loop: false });
  }, []);

  const onStagePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (showLive || clock.playing || !doc || !(duration > 0)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    clock.seek(((event.clientX - rect.left) / rect.width) * duration);
  };
  const onPointerLeave = () => {
    setHovered(false);
    if (!clock.playing && duration > 0) clock.seek(posterTime);
  };

  const [announce, setAnnounce] = useState('');
  const fail = (message: string) => {
    setAnnounce(message);
    toast({ title: message, tone: 'danger' });
  };
  const startRender = async () => {
    if (!doc) return;
    try {
      await movieRequest(projectId, workspaceContext, { action: 'render' }, doc.revision);
    } catch (error) {
      fail(t('motion.node.loadFailed', { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      movie.reload();
    }
  };
  const capture = async () => {
    if (!doc || !latest) return;
    const at = clockState.current.time;
    try {
      const file = await captureMotionFrame({ projectId, render: latest.render, time: at, title: doc.title, workspaceContext });
      sendFrameToChat(file);
      setAnnounce(t('motion.node.captured', { time: formatMotionTime(at, { tenths: true }) }));
    } catch (error) {
      fail(t('motion.node.captureFailed', { detail: error instanceof Error ? error.message : String(error) }));
    }
  };
  const createFilm = () => openMotionCreate({ target: { kind: 'existing-project', projectId }, source: 'board-insert' });

  const statusInfo = doc ? motionStatus(doc) : null;
  const status = statusInfo ? motionStatusLabel(statusInfo) : null;
  const progress = statusInfo?.kind === 'rendering' ? statusInfo.progress : undefined;
  const busyTone = status?.tone === 'brand';
  const renderCap = doc ? motionRenderCapability(doc) : null;
  const captureCap = doc ? motionCaptureCapability(doc) : null;
  const playable = doc !== null && duration > 0;
  const downloadUrl = latest?.render.file ? movieRawUrl(projectId, latest.render.file, workspaceContext) : null;

  return (
    <div
      className={cn(FX, styles.node)}
      style={{ width, height }}
      role="group"
      aria-label={t('motion.node.aria', { title })}
      data-testid="motion-node"
      data-node-id={nodeId}
      data-selected={selected ? '' : undefined}
      data-live={showLive ? '' : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={onPointerLeave}
    >
      <div
        className={styles.stage}
        data-testid="motion-node-stage"
        onPointerMove={onStagePointerMove}
        onDoubleClick={onOpenEditor}
      >
        {doc ? (
          showLive ? (
            <MoviePreviewFrame
              ref={frameRef}
              document={doc}
              projectId={projectId}
              workspaceContext={workspaceContext}
              initialTime={posterTime}
              variant="fill"
              title={doc.title}
              onReady={syncFrame}
            />
          ) : (
            <MotionCover cover={cover} aspect={aspect} time={clock.time} duration={duration} />
          )
        ) : movie.status === 'missing' ? (
          <div className={styles.overlay} {...interactive} onPointerDown={stopPointer}>
            <EmptyState
              variant="dashed"
              title={t('motion.node.status.missing')}
              action={
                <Button size="sm" onClick={createFilm}>
                  {t('motion.node.createFilm')}
                </Button>
              }
            />
          </div>
        ) : movie.status === 'error' ? (
          <div className={styles.overlay} {...interactive} onPointerDown={stopPointer}>
            <Callout tone="error" className={styles.callout}>
              <span>{t('motion.node.loadFailed', { detail: movie.error })}</span>
              <Button variant="link" size="sm" onClick={movie.reload}>
                {t('motion.node.retry')}
              </Button>
            </Callout>
          </div>
        ) : (
          <MotionCover cover={data.cover ? { kind: 'strip', ...data.cover } : null} aspect={aspect} />
        )}
        {movie.status === 'loading' ? (
          <span className={styles.chip} data-tone="neutral" data-testid="motion-node-status">
            <Spinner size="xs" />
            {t('motion.node.status.loading')}
          </span>
        ) : status ? (
          <span className={styles.chip} data-tone={status.tone} data-testid="motion-node-status" title={progress}>
            {busyTone ? <Spinner size="xs" /> : null}
            {t(status.key, status.vars)}
          </span>
        ) : null}
        {doc && duration > 0 ? (
          <span className={styles.duration}>
            <span aria-hidden>{formatMotionTime(duration)}</span>
            <VisuallyHidden>{t('motion.node.durationAria', { duration: formatMotionTime(duration) })}</VisuallyHidden>
          </span>
        ) : null}
      </div>
      <div className={styles.footer} data-testid="motion-node-footer" {...interactive} onPointerDown={stopPointer}>
        <IconButton
          size="sm"
          aria-label={t(clock.playing ? 'motion.common.pause' : 'motion.common.play')}
          tooltip={liveDenied ? t('motion.node.liveLimit') : undefined}
          disabled={!playable}
          onClick={clock.toggle}
        >
          <Icon icon={clock.playing ? Pause : Play} size="sm" />
        </IconButton>
        <span className={styles.time} aria-hidden>
          {formatMotionTime(clock.time, { tenths: true })} / {formatMotionTime(duration, { tenths: true })}
        </span>
        <Scrubber
          className={styles.scrubber}
          value={clock.time}
          max={duration}
          onChange={clock.seek}
          ariaLabel={t('motion.preview.position')}
          valueText={t('motion.node.timeValue', { current: formatMotionTime(clock.time), total: formatMotionTime(duration) })}
          disabled={!playable}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" aria-label={t('motion.node.menu')} disabled={!doc}>
              <MoreHorizontalIcon size="sm" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="lg">
            <DropdownMenuItem
              icon={<Icon icon={Film} size="sm" />}
              disabled={!renderCap?.available}
              description={renderCap?.reasonKey ? t(renderCap.reasonKey) : undefined}
              onSelect={() => void startRender()}
            >
              {t('motion.render.start')}
            </DropdownMenuItem>
            {downloadUrl ? (
              <DropdownMenuItem asChild>
                <a href={downloadUrl} download>
                  <MenuItemIcon>
                    <Icon icon={Download} size="sm" />
                  </MenuItemIcon>
                  {t('motion.review.downloadMp4')}
                </a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              icon={<Icon icon={Camera} size="sm" />}
              disabled={!captureCap?.available}
              description={captureCap?.reasonKey ? t(captureCap.reasonKey) : undefined}
              onSelect={() => void capture()}
            >
              {t('motion.node.capture')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="default" onClick={onOpenEditor}>
          {t('motion.node.open')}
        </Button>
        <VisuallyHidden role="status" aria-live="polite" data-testid="motion-node-announce">
          {announce}
        </VisuallyHidden>
      </div>
    </div>
  );
}

/** `BoardExtensions.renderMotionBody` adapter: the film comes from `movie`, playback pins the live slot. */
export function MotionNodeBody(props: BoardMotionBodyProps) {
  const data: MotionNodeData = {
    projectId: props.movie.projectId,
    path: MOVIE_DOCUMENT_FILE,
    ...(props.movie.title !== undefined ? { title: props.movie.title } : {}),
    ...(props.movie.aspect !== undefined ? { aspect: props.movie.aspect } : {}),
  };
  return (
    <MotionNode
      nodeId={props.nodeId}
      data={data}
      width={props.width}
      height={props.height}
      selected={props.selected}
      live={props.live}
      onPlayingChange={props.requestLive}
      {...(props.fileVersion !== undefined ? { fileVersion: props.fileVersion } : {})}
      onOpenEditor={props.onOpenEditor}
      onDataChange={props.onDataChange}
    />
  );
}
