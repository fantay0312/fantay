// SPDX-License-Identifier: AGPL-3.0-only
// Face of board `generator` nodes, injected through `BoardExtensions.renderGeneratorBody` (plan R4). The node is the
// future output: a frame in the output's shape holding a placeholder, the latest results, or the working mascot. It
// carries no text or controls, because world-space UI shrinks with the zoom; those live in the screen-space label and
// the docked panel, which holds the prompt and Run.
import { TriangleAlert } from 'lucide-react';

import { FantayMascot } from '../../brand/FantayMascot';
import type { BoardNodeBodyProps } from '../../board/extensions';
import { useImageSource, useVideoPoster } from '../../media-tools/thumbnails';
import { useGeneration } from '../hooks';
import { mediaUrl } from '../../media-tools/media-url';
import { useGeneratorFace, type GeneratorFaceOutput } from './generator-face';
import { requestGeneratorPanelFocus } from './generator-ui-store';
import styles from './GeneratorNodeBody.module.css';

export type GeneratorNodeBodyProps = Pick<BoardNodeBodyProps, 'nodeId' | 'selected' | 'zoom'> &
  Partial<Pick<BoardNodeBodyProps, 'height' | 'width'>>;

function ImageGlyph() {
  return (
    <svg className={styles.glyph} viewBox="0 0 64 64" fill="currentColor" aria-hidden>
      <circle cx="46" cy="16" r="7" />
      <path d="M7.6 49.4 24.9 21.7a3 3 0 0 1 5.1 0l10 16 3.9-5.5a3 3 0 0 1 4.9 0l8.9 12.6c1.7 2.4 0 5.7-2.9 5.7H10.1c-2.6 0-4-2.7-2.5-4.6Z" />
    </svg>
  );
}

function VideoGlyph() {
  return (
    <svg className={styles.glyph} viewBox="0 0 64 64" fill="currentColor" aria-hidden>
      <path d="M18 11.7a3.5 3.5 0 0 1 5.3-3l31 18.6a5.5 5.5 0 0 1 0 9.4l-31 18.6a3.5 3.5 0 0 1-5.3-3Z" />
    </svg>
  );
}

function OutputTile({ output, longEdge }: { output: GeneratorFaceOutput; longEdge: number }) {
  const { projectId, workspaceContext } = useGeneration();
  const url = mediaUrl(projectId, output.path, workspaceContext);
  const picture = useImageSource(output.video ? '' : url, output.cacheKey, longEdge);
  const poster = useVideoPoster(output.video ? url : null, output.cacheKey);
  const src = output.video ? poster : picture;
  return src ? <img className={styles.tile} src={src} alt="" draggable={false} /> : <span className={styles.tile} />;
}

export function GeneratorNodeBody({ nodeId, width, height }: GeneratorNodeBodyProps) {
  const generation = useGeneration();
  const face = useGeneratorFace(nodeId);
  const { surface, status, outputs } = face;
  const longEdge = Math.max(width ?? 0, height ?? 0) || 320;

  return (
    <div
      className={styles.root}
      data-testid="fx-gen-node"
      data-surface={surface}
      data-state={status}
      aria-busy={status === 'running' ? true : undefined}
      onDoubleClick={(event) => {
        event.stopPropagation();
        generation.board.select([nodeId]);
        requestGeneratorPanelFocus(nodeId, 'prompt');
      }}
    >
      {outputs.length > 0 ? (
        <div className={styles.outputs} data-count={outputs.length}>
          {outputs.map((output) => (
            <OutputTile key={output.id} output={output} longEdge={outputs.length > 1 ? longEdge / 2 : longEdge} />
          ))}
        </div>
      ) : status !== 'running' ? (
        surface === 'video' ? <VideoGlyph /> : <ImageGlyph />
      ) : null}
      {status === 'running' ? (
        <div className={styles.working} aria-hidden>
          <span className={styles.mascot}>
            <FantayMascot mood="working" />
          </span>
        </div>
      ) : null}
      {status === 'failed' ? (
        <span className={styles.failed} aria-hidden>
          <TriangleAlert strokeWidth={1.5} />
        </span>
      ) : null}
    </div>
  );
}
