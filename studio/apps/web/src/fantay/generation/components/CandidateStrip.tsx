// SPDX-License-Identifier: AGPL-3.0-only
// Latest results of a generator (spec 05 §5.8): thumbnails of the candidates of `runs[0]`, then of older
// runs while there is room; done → picture or video poster, active → spinner, failed/lost → alert;
// `+N` for the rest. Click selects and flies to the output node and makes the candidate its cover;
// the context menu promotes, downloads or uses it as a reference.
import { useMemo } from 'react';
import { Square, TriangleAlert } from 'lucide-react';
import { isActiveSlot, type GenerationCandidate, type GenerationGraph, type GenerationGraphNode } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Spinner } from '../../ui';
import { useBoardGraph, useGeneration } from '../hooks';
import { downloadMedia, useAsReference } from '../../media-tools/actions';
import { mediaCacheKey, mediaUrl } from '../../media-tools/media-url';
import { useImageSource, useVideoPoster } from '../../media-tools/thumbnails';
import { createMediaToolContext } from '../../media-nodes/node-actions';
import { primaryCandidateOf } from '../../media-nodes/media-display';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS } from './board-interactive';
import styles from './CandidateStrip.module.css';

const THUMB_SIZE = 44;

interface StripEntry {
  node: GenerationGraphNode;
  candidate: GenerationCandidate;
}

/** Candidates of the generator's runs, newest run first, each run in slot order. */
export function stripEntries(graph: GenerationGraph, runs: ReadonlyArray<{ runId: string; outputNodeId: string }>): StripEntry[] {
  const entries: StripEntry[] = [];
  for (const run of runs) {
    const node = graph.nodes.find((entry) => entry.id === run.outputNodeId);
    if (!node) continue;
    const candidates = (node.media?.generation?.candidates ?? [])
      .filter((candidate) => candidate.runId === run.runId)
      .sort((a, b) => a.index - b.index);
    for (const candidate of candidates) entries.push({ node, candidate });
  }
  return entries;
}

function ThumbContent({ node, candidate }: StripEntry) {
  const t = useT();
  const generation = useGeneration();
  const file = candidate.status === 'done' ? candidate.file : undefined;
  const url = file ? mediaUrl(generation.projectId, file.path, generation.workspaceContext) : '';
  const key = file ? mediaCacheKey(file) : candidate.id;
  const picture = useImageSource(node.kind === 'video' ? '' : url, key, THUMB_SIZE);
  const poster = useVideoPoster(node.kind === 'video' && file ? url : null, key);
  if (file) {
    const src = node.kind === 'video' ? poster : picture;
    return src ? <img className={styles.thumbImage} src={src} alt="" draggable={false} /> : <Spinner size="xs" />;
  }
  if (isActiveSlot(candidate.status)) return <Spinner size="sm" label={t('fantay.gen.slot.running')} />;
  if (candidate.status === 'stopped') return <Square size={14} strokeWidth={1.5} aria-hidden />;
  return <TriangleAlert size={16} strokeWidth={1.5} aria-hidden />;
}

export interface CandidateStripProps {
  generatorId: string;
  max?: number;
  /** The panel shows the "recent results" caption. */
  showTitle?: boolean;
}

export function CandidateStrip({ generatorId, max = 4, showTitle = false }: CandidateStripProps) {
  const t = useT();
  const generation = useGeneration();
  const graph = useBoardGraph();
  const runs = graph.nodes.find((node) => node.id === generatorId && node.kind === 'generator')?.generator?.runs;
  const entries = useMemo(() => (runs ? stripEntries(graph, runs) : []), [graph, runs]);
  if (entries.length === 0) return null;
  const visible = entries.slice(0, Math.max(1, max));
  const rest = entries.length - visible.length;

  const select = (entry: StripEntry) => {
    generation.board.select([entry.node.id]);
    generation.board.focus(entry.node.id);
    if (entry.candidate.status === 'done') generation.service.setPrimary(entry.node.id, entry.candidate.id);
  };

  return (
    <div className={styles.root} data-testid="fx-gen-candidates" {...BOARD_INTERACTIVE_PROPS}>
      {showTitle ? <span className={styles.title}>{t('fantay.gen.runs.title')}</span> : null}
      <div className={styles.row}>
        {visible.map((entry, index) => {
          const primary = primaryCandidateOf(entry.node.media?.generation)?.id === entry.candidate.id;
          const file = entry.candidate.status === 'done' ? entry.candidate.file : undefined;
          const label = `${entry.node.title?.trim() || t(entry.node.kind === 'video' ? 'fantay.media.untitledVideo' : 'fantay.media.untitledImage')} · ${entry.candidate.index + 1}`;
          const thumb = (
            <Button
              variant="bare"
              size="icon"
              className={styles.thumb}
              data-testid={`fx-gen-candidate-${index}`}
              data-status={entry.candidate.status}
              data-primary={primary ? '' : undefined}
              aria-label={label}
              {...BOARD_CONTROL_PROPS}
              onClick={() => select(entry)}
            >
              <ThumbContent node={entry.node} candidate={entry.candidate} />
            </Button>
          );
          if (!file) return <span key={entry.candidate.id}>{thumb}</span>;
          return (
            <ContextMenu key={entry.candidate.id}>
              <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
                {thumb}
              </ContextMenuTrigger>
              <ContextMenuContent {...BOARD_INTERACTIVE_PROPS}>
                <ContextMenuItem
                  onSelect={() => {
                    const created = generation.service.promote(entry.node.id, entry.candidate.id);
                    if (created) generation.board.select([created]);
                  }}
                >
                  {t('fantay.gen.slot.promote')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => downloadMedia(generation.projectId, file, generation.workspaceContext)}>
                  {t('fantay.gen.slot.download')}
                </ContextMenuItem>
                {entry.node.kind === 'image' ? (
                  <ContextMenuItem
                    onSelect={() => {
                      const graphNow = generation.board.getGraph();
                      const nodeNow = graphNow.nodes.find((candidateNode) => candidateNode.id === entry.node.id);
                      if (nodeNow) useAsReference(createMediaToolContext(generation, nodeNow, graphNow, t));
                    }}
                  >
                    {t('fantay.media.tool.useAsReference')}
                  </ContextMenuItem>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {rest > 0 ? <span className={styles.more}>{t('fantay.gen.runs.more', { n: rest })}</span> : null}
      </div>
    </div>
  );
}
