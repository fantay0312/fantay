// SPDX-License-Identifier: AGPL-3.0-only
// Body of board `video` nodes (spec 05 §6.2), injected through `BoardExtensions.renderVideoBody`
// (plan R4). The `<video>` is mounted only while the board's live budget grants the node a slot
// (plan R6: `live` + `requestLive(pinned)`, ≤ 4 board-wide); otherwise a cached first-frame poster
// with a play button that pins the node live. The mounted element is registered with the
// generation provider for "capture current frame". Multi-candidate nodes show a strip of posters.
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Clapperboard, Play } from 'lucide-react';
import type { BoardMediaFile, GenerationCandidate } from '@open-design/contracts';

import { useT } from '../../i18n';
import { Button, IconButton } from '../ui';
import type { BoardNodeBodyProps } from '../board/extensions';
import { useGeneration } from '../generation/hooks';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS, BOARD_REGION_PROPS } from '../generation/components/board-interactive';
import { mediaCacheKey, mediaUrl } from '../media-tools/media-url';
import { useVideoPoster } from '../media-tools/thumbnails';
import { OVERLAY_MIN_ZOOM, displayFileOf, overlayScaleFor, primaryCandidateOf, useGenerationNode } from './media-display';
import { SlotStatus } from './SlotStatus';
import styles from './VideoNodeBody.module.css';

const STRIP_LIMIT = 4;

export type VideoNodeBodyProps = Pick<BoardNodeBodyProps, 'nodeId' | 'selected' | 'zoom'> &
  Partial<Pick<BoardNodeBodyProps, 'live' | 'requestLive' | 'width' | 'height'>>;

function CandidatePosterThumb({
  nodeId,
  candidate,
  primary,
  label,
}: {
  nodeId: string;
  candidate: GenerationCandidate;
  primary: boolean;
  label: string;
}) {
  const generation = useGeneration();
  const file: BoardMediaFile | undefined = candidate.status === 'done' ? candidate.file : undefined;
  const url = file ? mediaUrl(generation.projectId, file.path, generation.workspaceContext) : null;
  const poster = useVideoPoster(url, file ? mediaCacheKey(file) : candidate.id);
  return (
    <Button
      size="icon"
      variant="bare"
      className={styles.thumb}
      data-primary={primary ? '' : undefined}
      data-testid={`fx-media-candidate-${candidate.index}`}
      aria-label={label}
      aria-pressed={primary}
      disabled={!file}
      {...BOARD_CONTROL_PROPS}
      onClick={() => generation.service.setPrimary(nodeId, candidate.id)}
    >
      {poster ? <img className={styles.thumbImage} src={poster} alt="" draggable={false} /> : <Clapperboard size={14} strokeWidth={1.5} aria-hidden />}
    </Button>
  );
}

export function VideoNodeBody({ nodeId, selected, zoom, live = false, requestLive }: VideoNodeBodyProps) {
  const t = useT();
  const generation = useGeneration();
  const node = useGenerationNode(nodeId);
  const generationData = node?.media?.generation;
  const candidates = generationData?.candidates ?? [];
  const primary = primaryCandidateOf(generationData);
  const file = displayFileOf(node);
  const url = file ? mediaUrl(generation.projectId, file.path, generation.workspaceContext) : null;
  const poster = useVideoPoster(live ? null : url, file ? mediaCacheKey(file) : nodeId);
  const title = node?.title?.trim() || t('fantay.media.untitledVideo');
  const wantsPlay = useRef(false);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const registerVideoElement = generation.registerVideoElement;

  useEffect(() => {
    registerVideoElement(nodeId, videoElement);
    return () => registerVideoElement(nodeId, null);
  }, [nodeId, registerVideoElement, videoElement]);

  useEffect(() => {
    if (!videoElement || !wantsPlay.current) return;
    wantsPlay.current = false;
    const playing = videoElement.play();
    if (playing && typeof playing.catch === 'function') playing.catch(() => requestLive?.(false));
  }, [requestLive, videoElement]);

  const startPlayback = useCallback(() => {
    wantsPlay.current = true;
    requestLive?.(true);
  }, [requestLive]);

  const overlayStyle = { '--fx-inv-zoom': overlayScaleFor(zoom) } as React.CSSProperties;
  const showStrip = candidates.length > 1;

  return (
    <div
      className={styles.root}
      style={overlayStyle}
      data-testid="fx-media-node"
      data-kind="video"
      data-live={live ? '' : undefined}
      data-lod={zoom < OVERLAY_MIN_ZOOM ? 'low' : 'normal'}
      data-selected={selected ? '' : undefined}
    >
      <div
        className={styles.frame}
        onDoubleClick={(event) => {
          // Spec 05 §6.3: double-click on the poster opens the preview; the live <video> keeps its own
          // double-click (fullscreen) and a press on the play button stays a press.
          if (!file || live || (event.target instanceof Element && event.target.closest('button'))) return;
          event.stopPropagation();
          generation.openToolDialog({ kind: 'preview', nodeId });
        }}
      >
        {file && url ? (
          live ? (
            <>
              <video
                ref={setVideoElement}
                className={styles.video}
                src={url}
                controls
                playsInline
                preload="metadata"
                aria-label={title}
                onPlay={() => requestLive?.(true)}
                onPause={() => requestLive?.(false)}
                onEnded={() => requestLive?.(false)}
              />
              <div className={styles.controlBar} data-testid="fx-media-video-controls" {...BOARD_INTERACTIVE_PROPS} />
            </>
          ) : (
            <>
              {poster ? (
                <img className={styles.poster} src={poster} alt={title} draggable={false} />
              ) : (
                <div className={styles.posterFallback} aria-hidden>
                  <Clapperboard size={28} strokeWidth={1.5} />
                </div>
              )}
              <div className={styles.play}>
                <IconButton
                  size="lg"
                  shape="round"
                  variant="frosted"
                  aria-label={t('board.node.play')}
                  data-testid="fx-media-play"
                  disabled={!requestLive}
                  {...BOARD_CONTROL_PROPS}
                  onClick={startPlayback}
                >
                  <Play strokeWidth={1.5} />
                </IconButton>
              </div>
            </>
          )
        ) : primary ? (
          <SlotStatus nodeId={nodeId} candidate={primary} generatorId={generationData?.request.generatorId} />
        ) : (
          <div className={styles.empty}>
            <Clapperboard size={24} strokeWidth={1.5} aria-hidden />
            <span>{t('fantay.media.untitledVideo')}</span>
          </div>
        )}
      </div>
      {showStrip ? (
        <div className={styles.strip} {...BOARD_REGION_PROPS}>
          {candidates.slice(0, STRIP_LIMIT).map((candidate) => (
            <CandidatePosterThumb
              key={candidate.id}
              nodeId={nodeId}
              candidate={candidate}
              primary={candidate.id === primary?.id}
              label={`${title} · ${candidate.index + 1}`}
            />
          ))}
          {candidates.length > STRIP_LIMIT ? (
            <span className={styles.more}>{t('fantay.gen.runs.more', { n: candidates.length - STRIP_LIMIT })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
