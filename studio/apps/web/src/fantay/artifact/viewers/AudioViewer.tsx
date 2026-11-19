// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/AudioPreview.tsx @ c5e6b24f (MIT): how the
// `<audio>` element is driven (finite durations only, the elapsed / total clock, a changed file is
// taken up once playback pauses). Changed here: a waveform of the whole file replaces the browser's
// controls, the reader's place and speed are kept per file, and failures are designed states.
//
// Sound: one calm player on the canvas ground. The whole file is drawn as a waveform that is also
// the scrubber; under it the clock, one play button and the speed. Space plays and pauses, ← and →
// move five seconds. The player is on screen at once and fills in (length, then shape); a file too
// long to decode whole still plays, with a plain track in place of the shape. A file the server
// sends without byte ranges (FLAC, Ogg) is played from memory, so it can be scrubbed like the rest.
'use client';

import { AudioLines, FileWarning, Pause, Play } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../../../i18n';
import { IconButton } from '../../ui';
import { ArtifactShell, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactUrl } from '../use-artifact-source';
import type { ArtifactViewerProps } from '../viewer-types';
import styles from './AudioViewer.module.css';
import { SEEK_STEP_SECONDS, formatMediaTime, formatSampleRate } from './media/media-time';
import { SpeedMenu } from './media/SpeedMenu';
import { useMediaPlayback } from './media/use-media-playback';
import { memoryMediaType, servedInRanges, useObjectUrl } from './media/use-memory-source';
import { WAVEFORM_MAX_BYTES, useWaveform } from './media/use-waveform';
import { Waveform } from './media/Waveform';
import { FileCard } from './UnknownViewer';

function AudioPlayer({ projectId, file, family, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const address = useArtifactUrl(projectId, file);

  // Where the sound comes from: the file's address, or a copy in memory when the server would not
  // let the browser seek in it. The copy is the same fetch that draws the waveform.
  const streamed = servedInRanges(file);
  const fromMemory = !streamed && file.size <= WAVEFORM_MAX_BYTES;
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const memoryUrl = useObjectUrl(fromMemory ? bytes : null, memoryMediaType(family.extension));
  const playback = useMediaPlayback<HTMLAudioElement>({
    projectId,
    file,
    url: fromMemory ? (memoryUrl ?? '') : address,
    active,
    // Too large for memory and not seekable: looking for the length would only lose the playhead.
    resolveUnknownLength: streamed || fromMemory,
  });
  const { duration, time, playing, phase } = playback;
  const wave = useWaveform(projectId, file, {
    active,
    length: !playback.everReady ? 'pending' : duration > 0 ? 'known' : 'unknown',
    duration,
    plainPcm: family.extension === 'wav',
    keepBytes: fromMemory,
  });
  useEffect(() => setBytes(wave.bytes), [wave.bytes]);
  /** The file has loaded and can play. Its length may still be unknown (a stream): then it cannot be scrubbed. */
  const ready = playback.everReady;
  const baseName = file.name.split('/').pop() ?? file.name;

  // The keyboard's media keys and the system's "now playing" name this file, not the app.
  const { play, pause, seekBy } = playback;
  useEffect(() => {
    if (!active || !playing || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.metadata = new MediaMetadata({ title: baseName });
      session.setActionHandler('play', play);
      session.setActionHandler('pause', pause);
      session.setActionHandler('seekbackward', () => seekBy(-SEEK_STEP_SECONDS));
      session.setActionHandler('seekforward', () => seekBy(SEEK_STEP_SECONDS));
    } catch {
      /* A platform without these actions keeps its default media keys. */
    }
    return () => {
      try {
        session.metadata = null;
        for (const action of ['play', 'pause', 'seekbackward', 'seekforward'] as const) session.setActionHandler(action, null);
      } catch {
        /* Nothing was set. */
      }
    };
  }, [active, playing, baseName, play, pause, seekBy]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!ready || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // The speed menu is rendered elsewhere but its keys still arrive here: they are the menu's.
    if (target?.closest('[role="menu"]')) return;
    if (event.key === ' ') {
      // On a button, Space already presses that button.
      if (target?.closest('button')) return;
      playback.toggle();
    } else if (event.key === 'ArrowRight') playback.seekBy(SEEK_STEP_SECONDS);
    else if (event.key === 'ArrowLeft') playback.seekBy(-SEEK_STEP_SECONDS);
    else return;
    event.preventDefault();
  };

  // What the file says about itself; each fact appears when it is known.
  const probe = wave.waveform?.probe ?? null;
  const channels = probe?.channels || wave.waveform?.channels || 0;
  const length = duration > 0 ? duration : (probe?.duration ?? 0);
  const facts = [
    length > 0 ? formatMediaTime(length) : null,
    probe && probe.sampleRate > 0 ? formatSampleRate(probe.sampleRate) : null,
    channels === 1
      ? t('artifact.audio.mono')
      : channels === 2
        ? t('artifact.audio.stereo')
        : channels > 2
          ? t('artifact.audio.channels', { count: channels })
          : null,
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
        : fileActions.unsupported(t('artifact.audio.loadFailed'), t('artifact.media.undecodable'), AudioLines);
  } else if (fromMemory && !playback.everReady && wave.source.source.status === 'failed') {
    // The copy for memory playback did not arrive.
    state = fileActions.sourceState(wave.source.source, wave.source.reload);
  }

  const toggleLabel = playing ? t('chat.audio.pause') : t('chat.audio.play');

  return (
    <ArtifactShell
      viewer="audio"
      path={file.name}
      stage="canvas"
      meta={facts.join(' · ')}
      actions={[fileActions.download]}
      menu={fileActions.menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      <div className={styles.wrap}>
        <div
          className={styles.player}
          role="group"
          aria-label={t('artifact.audio.player')}
          tabIndex={-1}
          data-testid="artifact-audio-player"
          data-playing={playing || undefined}
          onKeyDown={onKeyDown}
        >
          <audio {...playback.elementProps} />
          <Waveform
            peaks={wave.waveform?.peaks ?? null}
            plain={wave.settled}
            instant={wave.instant}
            duration={duration}
            time={time}
            playing={playing}
            liveTime={playback.liveTime}
            onSeek={playback.seek}
            onSeekBy={playback.seekBy}
            label={t('artifact.media.seek')}
          />
          <div className={styles.controls}>
            <span className={styles.clock} data-media-clock="">
              {ready ? (
                <>
                  <span className={styles.elapsed}>{formatMediaTime(time, duration)}</span>
                  {duration > 0 ? <span className={styles.total}> / {formatMediaTime(duration)}</span> : null}
                </>
              ) : playback.slow ? (
                <span className={styles.total}>{t('fileViewer.loading')}</span>
              ) : null}
            </span>
            <IconButton
              variant="primary"
              shape="round"
              size="lg"
              className={styles.play}
              aria-label={toggleLabel}
              shortcut="space"
              tooltipSide="bottom"
              data-media-toggle=""
              disabled={!ready}
              onClick={playback.toggle}
            >
              {playing ? (
                <Pause aria-hidden="true" fill="currentColor" strokeWidth={0} />
              ) : (
                <Play aria-hidden="true" className={styles.playGlyph} fill="currentColor" strokeWidth={0} />
              )}
            </IconButton>
            <span className={styles.speed}>
              <SpeedMenu rate={playback.rate} onRate={playback.setRate} />
            </span>
          </div>
        </div>
      </div>
    </ArtifactShell>
  );
}

export default function AudioViewer(props: ArtifactViewerProps): JSX.Element {
  const t = useT();
  if (props.family.format === 'unsupported') {
    const type = props.family.extension.toUpperCase();
    return <FileCard {...props} reason={t('artifact.media.unsupported', { type })} />;
  }
  // A player belongs to one file: another file gets its own element, clock and waveform.
  return <AudioPlayer key={props.file.name} {...props} />;
}
