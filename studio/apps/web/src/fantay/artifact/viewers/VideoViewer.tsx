// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/media/MediaVideoPlayer.tsx @ c5e6b24f (MIT): how the
// `<video>` element is driven (a changed file is taken up once playback pauses, a hidden window
// pauses the film unless it is fullscreen). Changed here: the film is sized to the stage at its own
// proportions instead of letterboxed, the browser's controls are replaced by our own overlay, and
// the reader's place, speed and volume are kept per file.
//
// Film: the picture is the content. It sits centred on the canvas ground at its own proportions,
// as large as fits, with a hairline ring and no black bars. The controls are an overlay on the
// picture: there while the film is paused, the pointer moves or the keyboard is used, gone while it
// plays. Space or K plays and pauses, ← → move five seconds, ↑ ↓ change the volume, M mutes,
// F is fullscreen; a click on the picture plays and pauses, a double click is fullscreen.
// A subtitle file with the film's name next to it (`.vtt`, else `.srt`) is shown over the picture.
'use client';

import {
  Captions,
  CaptionsOff,
  FileWarning,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  VideoOff,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from 'react';

import { useT } from '../../../i18n';
import { IconButton } from '../../ui';
import { ArtifactShell, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactBytes, useArtifactUrl } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { FilmCaptions } from './media/FilmCaptions';
import { FilmScrubber } from './media/FilmScrubber';
import { SEEK_STEP_SECONDS, fitMedia, formatMediaTime, type MediaSize } from './media/media-time';
import { SpeedMenu } from './media/SpeedMenu';
import { useCaptions } from './media/use-captions';
import { useMediaPlayback } from './media/use-media-playback';
import { memoryMediaType, servedInRanges, useObjectUrl } from './media/use-memory-source';
import { FileCard } from './UnknownViewer';
import styles from './VideoViewer.module.css';

/** Space kept between the film and the edge of the stage. */
const PAD = 24;
const PAD_NARROW = 12;
/** How long the controls stay after the last pointer or key activity while the film plays. */
const IDLE_MS = 2400;
/** How long a keyboard change (volume, mute) stays named on the picture. */
const FLASH_MS = 900;
/** A film the server sends without byte ranges is played from memory up to this size. */
const MEMORY_MAX_BYTES = 64 * 1024 * 1024;

function VideoPlayer({ projectId, file, family, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const address = useArtifactUrl(projectId, file);

  // Where the film comes from: its address, or a copy in memory when the server would not let the
  // browser seek in it (a type the daemon does not label as video, such as .m4v or .ogv).
  const streamed = servedInRanges(file);
  const fromMemory = !streamed && file.size <= MEMORY_MAX_BYTES;
  const copy = useArtifactBytes(projectId, file, { enabled: fromMemory && active, maxBytes: MEMORY_MAX_BYTES });
  const memoryUrl = useObjectUrl(copy.source.status === 'ready' ? copy.source.data : null, memoryMediaType(family.extension));
  const playback = useMediaPlayback<HTMLVideoElement>({
    projectId,
    file,
    url: fromMemory ? (memoryUrl ?? '') : address,
    active,
    pauseWhenWindowHidden: true,
    // Too large for memory and not seekable: looking for the length would only lose the playhead.
    resolveUnknownLength: streamed || fromMemory,
  });
  const { duration, time, playing, phase, element, muted, volume } = playback;

  // ── size ──────────────────────────────────────────────────────────────────────────────────────
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<MediaSize>({ width: 0, height: 0 });
  /** The picture's own size; kept while a newer version of the file loads, so the frame does not jump. */
  const [natural, setNatural] = useState<MediaSize | null>(null);

  useLayoutEffect(() => {
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);

  const hasPicture = natural !== null && natural.width > 0 && natural.height > 0;
  const fitted = hasPicture && viewport.width > 0 ? fitMedia(natural, viewport, viewport.width < 420 ? PAD_NARROW : PAD) : null;

  const { onLoadedMetadata } = playback.elementProps;
  const onMetadata = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      onLoadedMetadata(event);
      setNatural({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
    },
    [onLoadedMetadata],
  );

  // ── controls: there when needed, gone while the film plays ────────────────────────────────────
  const [awake, setAwake] = useState(true);
  const idleRef = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  /** A drag pauses a playing film so each position shows its frame; it resumes on release. */
  const [resumeAfterDrag, setResumeAfterDrag] = useState(false);
  const resumeRef = useRef(false);
  /** Before the first play the picture carries a large play mark; afterwards it never returns. */
  const [started, setStarted] = useState(false);

  const wake = useCallback(() => {
    setAwake(true);
    if (idleRef.current !== null) window.clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  const rest = useCallback(() => {
    if (idleRef.current !== null) window.clearTimeout(idleRef.current);
    idleRef.current = null;
    setAwake(false);
  }, []);
  useEffect(
    () => () => {
      if (idleRef.current !== null) window.clearTimeout(idleRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!playing) return;
    setStarted(true);
    // However playback began (a key, the system's media controls), the idle countdown starts now.
    wake();
  }, [playing, wake]);

  const showsPlaying = playing || (scrubbing && resumeAfterDrag);
  const controlsShown = !showsPlaying || awake || menuOpen || scrubbing;

  const { play, pause } = playback;
  const onDragChange = useCallback(
    (dragging: boolean) => {
      setScrubbing(dragging);
      if (dragging) {
        resumeRef.current = element !== null && !element.paused && !element.ended;
        if (resumeRef.current) pause();
      } else if (resumeRef.current) {
        resumeRef.current = false;
        play();
      }
      setResumeAfterDrag(resumeRef.current);
    },
    [element, play, pause],
  );

  // ── what the keyboard changed, named on the picture for a moment ──────────────────────────────
  const [flash, setFlash] = useState<{ text: string; shown: boolean }>({ text: '', shown: false });
  const flashRef = useRef<number | null>(null);
  const showFlash = useCallback((text: string) => {
    setFlash({ text, shown: true });
    if (flashRef.current !== null) window.clearTimeout(flashRef.current);
    flashRef.current = window.setTimeout(() => setFlash((current) => ({ ...current, shown: false })), FLASH_MS);
  }, []);
  useEffect(
    () => () => {
      if (flashRef.current !== null) window.clearTimeout(flashRef.current);
    },
    [],
  );

  // ── fullscreen and picture-in-picture ─────────────────────────────────────────────────────────
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [canPictureInPicture, setCanPictureInPicture] = useState(false);

  useEffect(() => {
    setCanFullscreen(document.fullscreenEnabled);
    const onChange = (): void => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!element) return;
    setCanPictureInPicture(document.pictureInPictureEnabled && typeof element.requestPictureInPicture === 'function');
    const onEnter = (): void => setPictureInPicture(true);
    const onLeave = (): void => setPictureInPicture(false);
    element.addEventListener('enterpictureinpicture', onEnter);
    element.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      element.removeEventListener('enterpictureinpicture', onEnter);
      element.removeEventListener('leavepictureinpicture', onLeave);
      // The floating window belongs to this element: it closes when the viewer goes away.
      if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => undefined);
    };
  }, [element]);

  useEffect(() => {
    if (pictureInPicture) showFlash(t('artifact.media.pipActive'));
    // Said once, when the film moves to the floating window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pictureInPicture]);

  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || !document.fullscreenEnabled) return;
    if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => undefined);
    else void frame.requestFullscreen().catch(() => undefined);
  }, []);

  const togglePictureInPicture = useCallback(() => {
    if (!element) return;
    if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => undefined);
    else void element.requestPictureInPicture().catch(() => undefined);
  }, [element]);

  // ── subtitles ─────────────────────────────────────────────────────────────────────────────────
  const cues = useCaptions(projectId, file, active);
  const [captionsOn, setCaptionsOn] = useArtifactViewState<boolean>(projectId, file.name, 'captions', true);
  const hasCaptions = cues.length > 0;

  // ── keyboard ──────────────────────────────────────────────────────────────────────────────────
  const ready = playback.everReady && hasPicture;
  const toggleMute = (): void => {
    playback.setMuted(!muted);
    showFlash(muted ? t('artifact.media.volume', { percent: Math.round((volume || 0.3) * 100) }) : t('artifact.media.mute'));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!ready || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // The speed menu's keys are the menu's, wherever it is rendered.
    if (target?.closest('[role="menu"]')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === ' ') {
      // On a button, Space already presses that button.
      if (target?.closest('button')) {
        wake();
        return;
      }
      playback.toggle();
    } else if (key === 'k') playback.toggle();
    else if (key === 'ArrowRight') playback.seekBy(SEEK_STEP_SECONDS);
    else if (key === 'ArrowLeft') playback.seekBy(-SEEK_STEP_SECONDS);
    else if (key === 'ArrowUp' || key === 'ArrowDown') {
      const next = playback.nudgeVolume(key === 'ArrowUp' ? 1 : -1);
      showFlash(next === 0 ? t('artifact.media.mute') : t('artifact.media.volume', { percent: Math.round(next * 100) }));
    } else if (key === 'm') toggleMute();
    else if (key === 'f') toggleFullscreen();
    else if (key === 'c' && hasCaptions) setCaptionsOn((on) => !on);
    else {
      // Tab and the rest still bring the controls back, so focus never moves through hidden buttons.
      wake();
      return;
    }
    wake();
    event.preventDefault();
  };

  // ── bar and states ────────────────────────────────────────────────────────────────────────────
  const facts = [
    hasPicture ? `${natural.width} × ${natural.height}` : null,
    duration > 0 ? formatMediaTime(duration) : null,
    formatBytes(file.size),
  ].filter(Boolean);

  let state: ArtifactShellState | null = null;
  if (phase === 'failed') {
    state =
      playback.failure === 'network'
        ? {
            kind: 'notice',
            icon: FileWarning,
            title: t('workspace.code.loadFailed'),
            action: { label: t('fileViewer.reload'), onSelect: playback.retry },
            secondaryAction: { label: t('fileViewer.download'), onSelect: fileActions.downloadFile },
          }
        : fileActions.unsupported(t('artifact.video.loadFailed'), t('artifact.media.undecodable'), VideoOff);
  } else if (phase === 'ready' && !hasPicture) {
    // The file opened, but there is no picture to show: a codec this build cannot draw, or sound only.
    state = fileActions.unsupported(t('artifact.video.noPicture'), t('artifact.media.undecodable'), VideoOff);
  } else if (fromMemory && !playback.everReady && copy.source.status !== 'ready') {
    // The copy for memory playback is on its way, or did not arrive.
    state = fileActions.sourceState(copy.source, copy.reload);
  } else if (phase === 'loading' && !playback.everReady) {
    state = playback.slow ? { kind: 'loading', label: t('fileViewer.loading') } : { kind: 'loading', quiet: true };
  }

  const toggleLabel = showsPlaying ? t('chat.audio.pause') : t('chat.audio.play');
  const silent = muted || volume === 0;
  const VolumeGlyph = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const compact = fitted !== null && !fullscreen && fitted.width < 320;

  return (
    <ArtifactShell
      viewer="video"
      path={file.name}
      stage="canvas"
      meta={facts.join(' · ')}
      actions={[fileActions.download]}
      menu={fileActions.menu}
      menuLabel={t('nextStep.more')}
      state={state}
      // The element has to stay in the page while it loads; only a failure removes it.
      keepContentMounted={phase === 'loading'}
    >
      <div ref={setStage} className={styles.stage}>
        <div
          ref={frameRef}
          className={styles.frame}
          role="group"
          aria-label={t('artifact.video.player')}
          tabIndex={0}
          data-testid="artifact-video-player"
          data-ready={fitted !== null || undefined}
          data-controls={controlsShown ? 'shown' : 'hidden'}
          data-compact={compact || undefined}
          data-playing={showsPlaying || undefined}
          style={fitted ? { width: fitted.width, height: fitted.height } : undefined}
          onKeyDown={onKeyDown}
          onPointerMove={wake}
          onPointerDown={wake}
          onPointerLeave={rest}
        >
          <video {...playback.elementProps} className={styles.video} playsInline onLoadedMetadata={onMetadata} />
          {/* The picture itself: a click plays and pauses, a double click is fullscreen. */}
          <div className={styles.surface} aria-hidden="true" onClick={playback.toggle} onDoubleClick={toggleFullscreen} />
          {hasCaptions && captionsOn && fitted ? (
            <FilmCaptions
              cues={cues}
              playing={playing}
              time={time}
              liveTime={playback.liveTime}
              raised={controlsShown}
              width={fullscreen ? window.innerWidth : fitted.width}
            />
          ) : null}
          <span className={styles.mark} data-visible={(ready && !started) || undefined} aria-hidden="true">
            <Play fill="currentColor" strokeWidth={0} />
          </span>
          <span className={styles.flash} data-visible={flash.shown || undefined} role="status">
            {flash.text}
          </span>
          <div className={styles.controls} data-media-controls="">
            <FilmScrubber
              duration={duration}
              time={time}
              playing={playing}
              loadedTick={playback.loadedTick}
              liveTime={playback.liveTime}
              liveLoaded={playback.liveLoaded}
              onSeek={playback.seek}
              onSeekBy={playback.seekBy}
              onDragChange={onDragChange}
              label={t('artifact.media.seek')}
            />
            <div className={styles.buttons}>
              <IconButton size="sm" aria-label={toggleLabel} shortcut="k" data-media-toggle="" disabled={!ready} onClick={playback.toggle}>
                {showsPlaying ? (
                  <Pause aria-hidden="true" className="size-4" fill="currentColor" strokeWidth={0} />
                ) : (
                  <Play aria-hidden="true" className="size-4" fill="currentColor" strokeWidth={0} />
                )}
              </IconButton>
              <span className={styles.clock} data-media-clock="">
                <span>{formatMediaTime(time, duration)}</span>
                <span className={styles.total}> / {formatMediaTime(duration)}</span>
              </span>
              <span className={styles.spacer} />
              <IconButton
                size="sm"
                aria-label={silent ? t('artifact.media.unmute') : t('artifact.media.mute')}
                shortcut="m"
                on={silent}
                data-media-mute=""
                onClick={toggleMute}
              >
                <VolumeGlyph aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </IconButton>
              {hasCaptions ? (
                <IconButton
                  size="sm"
                  aria-label={t('artifact.media.captions')}
                  shortcut="c"
                  on={captionsOn}
                  data-media-captions-toggle=""
                  onClick={() => setCaptionsOn((on) => !on)}
                >
                  {captionsOn ? (
                    <Captions aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  ) : (
                    <CaptionsOff aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  )}
                </IconButton>
              ) : null}
              <span className={styles.optional}>
                <SpeedMenu
                  rate={playback.rate}
                  onRate={playback.setRate}
                  // A fullscreen film shows nothing outside itself: the menu then lives in the frame.
                  container={fullscreen ? frameRef.current : null}
                  onPicture
                  onOpenChange={setMenuOpen}
                />
              </span>
              {canPictureInPicture ? (
                <span className={styles.optional}>
                  <IconButton
                    size="sm"
                    aria-label={pictureInPicture ? t('artifact.media.exitPip') : t('artifact.media.pip')}
                    on={pictureInPicture}
                    data-media-pip=""
                    onClick={togglePictureInPicture}
                  >
                    <PictureInPicture2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  </IconButton>
                </span>
              ) : null}
              {canFullscreen ? (
                <IconButton
                  size="sm"
                  aria-label={fullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
                  shortcut="f"
                  data-media-fullscreen=""
                  onClick={toggleFullscreen}
                >
                  {fullscreen ? (
                    <Minimize aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  ) : (
                    <Maximize aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  )}
                </IconButton>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </ArtifactShell>
  );
}

export default function VideoViewer(props: ArtifactViewerProps): JSX.Element {
  const t = useT();
  if (props.family.format === 'unsupported') {
    const type = props.family.extension.toUpperCase();
    return <FileCard {...props} reason={t('artifact.media.unsupported', { type })} />;
  }
  // A player belongs to one file: another file gets its own element and its own place.
  return <VideoPlayer key={props.file.name} {...props} />;
}
