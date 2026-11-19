// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/AudioPreview.tsx and
// apps/web/src/components/media/MediaVideoPlayer.tsx @ c5e6b24f (MIT): a file that changes while it
// plays is taken up once playback pauses; a play() interrupted by a pause is not a failure; a hidden
// window pauses a film unless it is fullscreen. Changed here: one hook for `<audio>` and `<video>`,
// the reader's place, speed and volume are kept per file outside React (viewers are unmounted on
// every tab switch), a hidden tab pauses, and failures are sorted into "try again" and "cannot play".
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback, type SyntheticEvent } from 'react';

import type { ProjectFile } from '../../../../types';
import { ARTIFACT_SLOW_LOAD_MS } from '../../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../../use-view-state';
import { VOLUME_STEP, bufferedEnd, clampTime, resumeTime } from './media-time';

/** Why a file did not play. `network`: the bytes did not arrive, so trying again can help. */
export type MediaFailure = 'network' | 'decode';

export interface MediaPlaybackOptions {
  projectId: string;
  file: ProjectFile;
  /**
   * The file's current address. A newer one replaces it once playback pauses. Empty while the
   * address is not known yet (a file that is first loaded into memory): the element then waits.
   */
  url: string;
  /** False while the tab is mounted but hidden: playback pauses. */
  active: boolean;
  /** Films pause when the window is hidden (unless fullscreen or picture-in-picture); sound keeps playing. */
  pauseWhenWindowHidden?: boolean;
  /**
   * Some files do not state their length (a browser recording, an Ogg stream). Seeking far past
   * the end makes the browser find it. Set false for a source that cannot seek: there the attempt
   * would cost the reader's ability to move at all.
   */
  resolveUnknownLength?: boolean;
}

type MediaEvent<E> = SyntheticEvent<E>;

/** Spread on the `<audio>` or `<video>`. Listeners are attached with the element, before it loads. */
export interface MediaElementProps<E extends HTMLMediaElement> {
  ref: RefCallback<E>;
  src: string | undefined;
  preload: 'metadata';
  onLoadedMetadata(event: MediaEvent<E>): void;
  onDurationChange(event: MediaEvent<E>): void;
  onTimeUpdate(event: MediaEvent<E>): void;
  onSeeking(event: MediaEvent<E>): void;
  onSeeked(event: MediaEvent<E>): void;
  onPlay(event: MediaEvent<E>): void;
  onPause(event: MediaEvent<E>): void;
  onEnded(event: MediaEvent<E>): void;
  onProgress(event: MediaEvent<E>): void;
  onVolumeChange(event: MediaEvent<E>): void;
  onError(event: MediaEvent<E>): void;
}

export interface MediaPlayback<E extends HTMLMediaElement> {
  elementProps: MediaElementProps<E>;
  /** The mounted element, for what only the viewer needs (fullscreen, picture-in-picture, tracks). */
  element: E | null;
  phase: 'loading' | 'ready' | 'failed';
  /** True once any version of the file has loaded here: a newer version then loads behind it. */
  everReady: boolean;
  failure: MediaFailure | null;
  /** True once loading has outlasted the grace period: only then is it worth mentioning. */
  slow: boolean;
  playing: boolean;
  /** Seconds; 0 until known. */
  duration: number;
  /** Seconds. Follows the element about four times a second; read `liveTime()` for every frame. */
  time: number;
  /** Changes whenever more of the file has loaded. */
  loadedTick: number;
  rate: number;
  muted: boolean;
  volume: number;
  toggle(): void;
  play(): void;
  pause(): void;
  seek(time: number): void;
  seekBy(seconds: number): void;
  setRate(rate: number): void;
  setMuted(muted: boolean): void;
  /** Steps the volume up (1) or down (-1); un-mutes on the way up. Returns the new volume. */
  nudgeVolume(direction: 1 | -1): number;
  /** Clears a failure and loads the file again. */
  retry(): void;
  liveTime(): number;
  /** Seconds up to which the stretch under the playhead has loaded. */
  liveLoaded(): number;
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function useMediaPlayback<E extends HTMLMediaElement>(options: MediaPlaybackOptions): MediaPlayback<E> {
  const { projectId, file, url, active, pauseWhenWindowHidden = false, resolveUnknownLength = true } = options;
  const name = file.name;

  const elementRef = useRef<E | null>(null);
  const [element, setElement] = useState<E | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(() => readArtifactViewState<number>(projectId, name, 'time') ?? 0);
  const [loadedTick, setLoadedTick] = useState(0);
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ src: string; failure: MediaFailure } | null>(null);
  const [slowSrc, setSlowSrc] = useState<string | null>(null);

  const [rate, setRateState] = useArtifactViewState<number>(projectId, name, 'rate', 1);
  const [muted, setMutedState] = useArtifactViewState<boolean>(projectId, name, 'muted', false);
  const [volume, setVolumeState] = useArtifactViewState<number>(projectId, name, 'volume', 1);

  // A newer version of the file is taken up once playback pauses, never under a playing reader.
  const [src, setSrc] = useState(url);
  if (src !== url && !playing) setSrc(url);

  /**
   * The source whose saved position has been applied. Until a source reaches that point its
   * positions are not recorded: a load starts by resetting the playhead to 0, and that reset must
   * not overwrite where the reader was.
   */
  const restoredRef = useRef<string | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  /** The source whose length is being looked for by seeking past its end. */
  const probingRef = useRef<string | null>(null);
  const settingsRef = useRef({ rate, muted, volume });
  settingsRef.current = { rate, muted, volume };

  const remember = useCallback(
    (media: HTMLMediaElement) => {
      if (restoredRef.current !== srcRef.current) return;
      const ended = media.ended || (finite(media.duration) > 0 && media.currentTime >= media.duration - 0.05);
      writeArtifactViewState(projectId, name, 'time', ended ? 0 : media.currentTime);
    },
    [projectId, name],
  );

  const attach = useCallback<RefCallback<E>>((node) => {
    elementRef.current = node;
    setElement(node);
  }, []);

  const elementProps = useMemo<MediaElementProps<E>>(
    () => ({
      ref: attach,
      src: src === '' ? undefined : src,
      preload: 'metadata',
      onLoadedMetadata: (event) => {
        const media = event.currentTarget;
        const length = finite(media.duration);
        const settings = settingsRef.current;
        // A new source starts at the default rate, so both are set.
        media.defaultPlaybackRate = settings.rate;
        media.playbackRate = settings.rate;
        media.muted = settings.muted;
        media.volume = settings.volume;
        let at = 0;
        if (length === 0 && media.duration === Infinity && resolveUnknownLength) {
          // The file does not state its length. Seeking far past the end makes the browser find
          // it; `onDurationChange` then puts the playhead where it belongs.
          probingRef.current = src;
          try {
            media.currentTime = 1e101;
          } catch {
            probingRef.current = null;
            restoredRef.current = src;
          }
        } else {
          at = resumeTime(readArtifactViewState<number>(projectId, name, 'time'), length);
          if (at > 0) {
            try {
              media.currentTime = at;
            } catch {
              /* A refused seek leaves the file at its start, which is still playable. */
            }
          }
          restoredRef.current = src;
        }
        setDuration(length);
        setTime(at);
        setReadySrc(src);
        setFailed(null);
      },
      onDurationChange: (event) => {
        const media = event.currentTarget;
        const length = finite(media.duration);
        setDuration(length);
        if (probingRef.current !== src || length === 0) return;
        // The length has been found: back from the end to where the reader was.
        probingRef.current = null;
        const at = resumeTime(readArtifactViewState<number>(projectId, name, 'time'), length);
        try {
          media.currentTime = at;
        } catch {
          /* The file stays where the browser left it. */
        }
        restoredRef.current = src;
        setTime(at);
      },
      onTimeUpdate: (event) => {
        // While the length is being looked for the playhead is not anywhere the reader put it.
        if (probingRef.current === src) return;
        setTime(event.currentTarget.currentTime);
        remember(event.currentTarget);
      },
      onSeeking: (event) => {
        if (probingRef.current !== src) setTime(event.currentTarget.currentTime);
      },
      onSeeked: (event) => {
        const media = event.currentTarget;
        if (probingRef.current === src && finite(media.duration) === 0) {
          // The look past the end found nothing (a true stream): start over, length unknown.
          probingRef.current = null;
          restoredRef.current = src;
          try {
            media.currentTime = 0;
          } catch {
            /* Nothing to undo. */
          }
          setTime(0);
          return;
        }
        setTime(media.currentTime);
        remember(media);
      },
      onPlay: () => setPlaying(true),
      onPause: (event) => {
        setPlaying(false);
        remember(event.currentTarget);
      },
      onEnded: (event) => {
        setPlaying(false);
        remember(event.currentTarget);
      },
      onProgress: () => setLoadedTick((tick) => tick + 1),
      onVolumeChange: (event) => {
        // The system's media controls and the picture-in-picture window can change these too.
        setMutedState(event.currentTarget.muted);
        setVolumeState(event.currentTarget.volume);
      },
      onError: (event) => {
        const code = event.currentTarget.error?.code;
        setPlaying(false);
        // 2 is MEDIA_ERR_NETWORK. Everything else means these bytes cannot be played here.
        setFailed({ src, failure: code === 2 ? 'network' : 'decode' });
      },
    }),
    [attach, src, projectId, name, remember, resolveUnknownLength, setMutedState, setVolumeState],
  );

  // Leaving the tab pauses; so does unmounting (a detached element would keep playing).
  useEffect(() => {
    if (!active) elementRef.current?.pause();
  }, [active]);

  useEffect(() => {
    const media = element;
    if (!media) return;
    return () => {
      remember(media);
      media.pause();
      // A detached element's pause event never arrives.
      setPlaying(false);
    };
  }, [element, remember]);

  useEffect(() => {
    if (!pauseWhenWindowHidden || !element) return;
    const onVisibility = (): void => {
      if (!document.hidden) return;
      // Fullscreen and picture-in-picture are still being watched while the page itself is hidden.
      const watched = document.fullscreenElement?.contains(element) || document.pictureInPictureElement === element;
      if (!watched) element.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [element, pauseWhenWindowHidden]);

  // The grace period before a load is worth mentioning.
  const loading = readySrc !== src && failed?.src !== src;
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSlowSrc(src), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [loading, src]);

  const play = useCallback(() => {
    const media = elementRef.current;
    if (!media) return;
    // A rejection here is either a pause that overtook the play (nothing to do) or a file that
    // cannot be played, which the element's error event already reports.
    media.play().catch(() => undefined);
  }, []);
  const pause = useCallback(() => elementRef.current?.pause(), []);
  const toggle = useCallback(() => {
    const media = elementRef.current;
    if (!media) return;
    if (media.paused || media.ended) play();
    else media.pause();
  }, [play]);

  const seek = useCallback((next: number) => {
    const media = elementRef.current;
    if (!media) return;
    const target = clampTime(next, finite(media.duration));
    try {
      media.currentTime = target;
    } catch {
      return;
    }
    setTime(target);
  }, []);
  const seekBy = useCallback(
    (seconds: number) => {
      const media = elementRef.current;
      if (media) seek(media.currentTime + seconds);
    },
    [seek],
  );

  const setRate = useCallback(
    (next: number) => {
      setRateState(next);
      const media = elementRef.current;
      if (!media) return;
      media.defaultPlaybackRate = next;
      media.playbackRate = next;
    },
    [setRateState],
  );
  const setMuted = useCallback(
    (next: boolean) => {
      setMutedState(next);
      const media = elementRef.current;
      if (!media) return;
      media.muted = next;
      // Un-muting at volume zero would change nothing the listener can hear.
      if (!next && media.volume === 0) media.volume = VOLUME_STEP * 3;
    },
    [setMutedState],
  );
  const nudgeVolume = useCallback(
    (direction: 1 | -1) => {
      const media = elementRef.current;
      const current = media ? (media.muted ? 0 : media.volume) : settingsRef.current.volume;
      const next = Math.min(1, Math.max(0, Math.round((current + direction * VOLUME_STEP) * 10) / 10));
      setVolumeState(next);
      setMutedState(next === 0);
      if (media) {
        media.volume = next;
        media.muted = next === 0;
      }
      return next;
    },
    [setMutedState, setVolumeState],
  );

  const retry = useCallback(() => {
    setFailed(null);
    setReadySrc(null);
    elementRef.current?.load();
  }, []);

  const liveTime = useCallback(() => elementRef.current?.currentTime ?? 0, []);
  const liveLoaded = useCallback(() => {
    const media = elementRef.current;
    if (!media) return 0;
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < media.buffered.length; index += 1) {
      ranges.push({ start: media.buffered.start(index), end: media.buffered.end(index) });
    }
    return bufferedEnd(ranges, media.currentTime);
  }, []);

  const phase = failed?.src === src ? 'failed' : readySrc === src ? 'ready' : 'loading';

  return {
    elementProps,
    element,
    phase,
    everReady: readySrc !== null,
    failure: phase === 'failed' ? (failed?.failure ?? 'decode') : null,
    slow: phase === 'loading' && slowSrc === src,
    playing,
    duration,
    time,
    loadedTick,
    rate,
    muted,
    volume,
    toggle,
    play,
    pause,
    seek,
    seekBy,
    setRate,
    setMuted,
    nudgeVolume,
    retry,
    liveTime,
    liveLoaded,
  };
}
