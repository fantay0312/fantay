'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Audio face (spec 03 §4.5): a capsule with Play/Pause, the title, a progress bar and the duration. The `<audio>`
// exists only while playing, never counts against the live budget, and only one plays at a time (audio manager).
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';

import { useT } from '../../../../i18n';
import { IconButton } from '../../../ui/icon-button';
import { useBoardEngine, useBoardHost } from '../../context';
import { claimAudio, releaseAudio } from '../../engine/audio-manager';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { ErrorFace } from '../common/ErrorFace';
import { ICON_STROKE } from '../common/kind-icons';
import { basenameOf, projectFileFor } from '../frame/project-files';
import { formatMediaTime, projectMediaUrl } from './media-url';
import styles from './media.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;
const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

export function AudioNode({ view }: NodeFaceProps) {
  const engine = useBoardEngine();
  const { commands } = engine;
  const { env } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'audio'>;
  const nodeId = node.id;
  const path = node.data.ref?.path ?? null;
  const file = projectFileFor(env.files, path);
  const playing = view.runtime.playing === true && path !== null && view.active;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(node.data.durationMs ?? undefined);
  const title = node.title ?? (path ? basenameOf(path) : t('board.kind.audio'));

  useEffect(() => {
    const audio = audioRef.current;
    if (!playing || !audio) return undefined;
    claimAudio(nodeId, {
      pause: () => {
        audio.pause();
        commands.setRuntime(nodeId, { playing: false });
      },
    });
    void audio.play().catch(() => commands.setRuntime(nodeId, { playing: false }));
    return () => {
      audio.pause();
      releaseAudio(nodeId);
    };
  }, [playing, nodeId, commands]);

  useEffect(() => () => releaseAudio(nodeId), [nodeId]);

  if (view.runtime.phase === 'error') {
    return <ErrorFace message={view.runtime.error?.message ?? t(view.runtime.error?.messageKey ?? 'board.node.state.error')} />;
  }

  const progress = duration && duration > 0 ? Math.min(1, time / duration) : 0;
  return (
    <div className={styles.audio} data-testid="board-audio">
      <span {...INTERACTIVE} onPointerDown={stop} className={styles.audioPlay}>
        <IconButton
          size="sm"
          shape="round"
          variant="quiet"
          aria-label={t(playing ? 'board.node.pause' : 'board.node.play')}
          onClick={() => commands.setRuntime(nodeId, { playing: !playing })}
          disabled={!path}
        >
          {playing ? <Pause strokeWidth={ICON_STROKE} /> : <Play strokeWidth={ICON_STROKE} />}
        </IconButton>
      </span>
      <span className={styles.audioBody}>
        <span className={styles.audioTitle}>{title}</span>
        <span className={styles.audioTrack} aria-hidden>
          <span className={styles.audioFill} style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </span>
      </span>
      <span className={styles.time}>{formatMediaTime(playing ? time : duration)}</span>
      {playing && path ? (
        <audio
          ref={audioRef}
          src={projectMediaUrl(env.projectId, path, file?.mtime, env.workspaceContext)}
          preload="metadata"
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds)) setDuration(seconds * 1000);
          }}
          onEnded={() => {
            setTime(0);
            commands.setRuntime(nodeId, { playing: false });
          }}
        />
      ) : null}
    </div>
  );
}
