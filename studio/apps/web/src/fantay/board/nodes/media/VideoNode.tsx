'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Video face (spec 03 §4.4, plan R4/R6): the generation body when `extensions.renderVideoBody` is injected, else
// the fallback. A `<video>` exists only while the node holds a live slot (it counts against the budget); hovering a
// live video for 400 ms previews it muted, an explicit Play pins it live until pause or end (`runtime.playing`).
// Not live → the cover (board cover or chat snapshot) with a Play button. The first decoded frame becomes the
// cover once, and the first metadata fixes the natural size.
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';

import { useT } from '../../../../i18n';
import { IconButton } from '../../../ui/icon-button';
import { useBoardEngine, useBoardHost } from '../../context';
import { captureVideoCover, needsCoverCapture, resolveCover, saveNodeCover } from '../../engine/covers';
import { HOVER_DWELL_MS } from '../../engine/live-budget';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { CoverImage } from '../common/CoverImage';
import { ErrorFace } from '../common/ErrorFace';
import { PlaceholderFace } from '../common/PlaceholderFace';
import { ICON_STROKE } from '../common/kind-icons';
import { basenameOf, projectFileFor } from '../frame/project-files';
import { useNodeBodyProps } from './body-props';
import { formatMediaTime, projectMediaUrl } from './media-url';
import styles from './media.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;
const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

export function VideoNode({ view }: NodeFaceProps) {
  const { extensions } = useBoardHost();
  const body = useNodeBodyProps(view, 'video');
  if (extensions?.renderVideoBody) {
    return (
      <div className={styles.body} data-testid="board-video-body">
        {extensions.renderVideoBody(body)}
      </div>
    );
  }
  return <VideoFallback view={view} />;
}

function VideoFallback({ view }: NodeFaceProps) {
  const engine = useBoardEngine();
  const { commands } = engine;
  const { env } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'video'>;
  const nodeId = node.id;
  const path = node.data.ref?.path ?? null;
  const file = projectFileFor(env.files, path);
  const muted = node.data.muted !== false;
  const playing = view.runtime.playing === true;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  const [elementPlaying, setElementPlaying] = useState(false);
  const covered = useRef<string | null>(null);
  const measured = useRef(false);
  const title = node.title ?? (path ? basenameOf(path) : t('board.kind.video'));
  const cover = resolveCover({ node, file, messages: env.messages, projectId: env.projectId, workspaceContext: env.workspaceContext });
  const mounted = view.live && path !== null;

  // explicit play intent (context bar / Play button) and board visibility
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!view.active) {
      video.pause();
      return;
    }
    if (playing && video.paused) void video.play().catch(() => commands.setRuntime(nodeId, { playing: false }));
    if (!playing && !view.hovered && !video.paused) video.pause();
  }, [playing, view.active, view.hovered, mounted, commands, nodeId]);

  // hover preview: muted, never pinned
  useEffect(() => {
    if (!mounted || !view.hovered || playing) return undefined;
    const timer = setTimeout(() => {
      const video = videoRef.current;
      if (video && video.paused) {
        video.muted = true;
        void video.play().catch(() => undefined);
      }
    }, HOVER_DWELL_MS);
    return () => clearTimeout(timer);
  }, [mounted, view.hovered, playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted || !playing;
  }, [muted, playing, mounted]);

  // release the pin when the face unmounts
  useEffect(() => () => {
    if (engine.store.getState().runtime.get(nodeId)?.playing) commands.setRuntime(nodeId, { playing: false });
  }, [commands, engine, nodeId]);

  const togglePlay = (): void => {
    commands.setRuntime(nodeId, { playing: !playing });
    if (playing) videoRef.current?.pause();
  };

  if (view.runtime.phase === 'error') {
    return <ErrorFace message={view.runtime.error?.message ?? t(view.runtime.error?.messageKey ?? 'board.node.state.error')} />;
  }
  if (!path) return <PlaceholderFace kind="video" caption={title} />;

  const src = projectMediaUrl(env.projectId, path, file?.mtime, env.workspaceContext);
  const duration = node.data.durationMs ?? (videoRef.current && Number.isFinite(videoRef.current.duration) ? videoRef.current.duration * 1000 : undefined);

  return (
    <div className={styles.video} data-testid="board-video">
      {cover ? <CoverImage src={cover.url} alt={title} hidden={mounted && elementPlaying} /> : !mounted ? <PlaceholderFace kind="video" caption={title} /> : null}
      {mounted ? (
        <video
          ref={videoRef}
          className={styles.player}
          src={src}
          poster={cover?.url}
          muted
          playsInline
          preload="metadata"
          loop={node.data.loop !== false}
          onPlay={() => setElementPlaying(true)}
          onPause={() => {
            setElementPlaying(false);
            if (engine.store.getState().runtime.get(nodeId)?.playing && !videoRef.current?.ended) commands.setRuntime(nodeId, { playing: false });
          }}
          onEnded={() => commands.setRuntime(nodeId, { playing: false })}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (measured.current || view.readOnly || node.data.naturalWidth || !video.videoWidth || !video.videoHeight) return;
            measured.current = true;
            const h = Math.max(1, Math.round((node.w * video.videoHeight) / video.videoWidth));
            commands.updateNode(
              nodeId,
              {
                h,
                data: {
                  naturalWidth: video.videoWidth,
                  naturalHeight: video.videoHeight,
                  ...(Number.isFinite(video.duration) ? { durationMs: Math.round(video.duration * 1000) } : {}),
                },
              },
              { origin: 'system', label: 'autosize' },
            );
          }}
          onLoadedData={(event) => {
            const video = event.currentTarget;
            const mtime = file?.mtime;
            if (view.readOnly || mtime === undefined || !needsCoverCapture(node, mtime) || covered.current === `${mtime}`) return;
            covered.current = `${mtime}`;
            void captureVideoCover(video).then((image) => {
              if (!image) return;
              void saveNodeCover({
                projectId: env.projectId,
                nodeId,
                image,
                sourceMtime: mtime,
                workspaceContext: env.workspaceContext,
                update: (id, next) => commands.updateNode(id, { data: { cover: next } }, { origin: 'system', label: 'cover' }),
              });
            });
          }}
        />
      ) : null}
      {mounted ? (
        <div className={styles.controls} {...INTERACTIVE} onPointerDown={stop} data-testid="board-video-controls">
          <IconButton size="xs" variant="quiet" aria-label={t(playing ? 'board.node.pause' : 'board.node.play')} onClick={togglePlay}>
            {playing ? <Pause strokeWidth={ICON_STROKE} /> : <Play strokeWidth={ICON_STROKE} />}
          </IconButton>
          <IconButton
            size="xs"
            variant="quiet"
            aria-label={t(muted ? 'board.node.unmute' : 'board.node.mute')}
            on={!muted}
            onClick={() => commands.updateNode(nodeId, { data: { muted: !muted } }, { label: 'style' })}
            disabled={view.readOnly}
          >
            {muted ? <VolumeX strokeWidth={ICON_STROKE} /> : <Volume2 strokeWidth={ICON_STROKE} />}
          </IconButton>
          <span className={styles.time}>
            {formatMediaTime(time)} / {formatMediaTime(duration)}
          </span>
        </div>
      ) : (
        <span className={styles.playOverlay} {...INTERACTIVE} onPointerDown={stop}>
          <IconButton size="lg" shape="round" variant="frosted" aria-label={t('board.node.play')} onClick={togglePlay}>
            <Play strokeWidth={ICON_STROKE} />
          </IconButton>
        </span>
      )}
    </div>
  );
}
