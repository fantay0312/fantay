// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-reference-bar.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29 (spec 05 §5.4): compiled inputs with their labels (图片1, 文本1),
// "not sent" state, undoable edge removal through the generation board port, board pick mode when the
// engine offers it, else a popover list of eligible board nodes (spec 05 §4.2 fallback).
// Modified for Fantay on 2026-10-31: the add control is a labelled tile in the row, in place of the caption above it.
import { forwardRef, useMemo, useState } from 'react';
import { FileText, ImageIcon, ImageOff, ImagePlus, X } from 'lucide-react';
import { canConnectToGenerator, type CompiledInput, type GenerationGraph, type GenerationGraphNode } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger, Tooltip } from '../../ui';
import { useBoardGraph, useGeneration } from '../hooks';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS } from './board-interactive';
import { mediaUrl } from '../references';
import { newBoardEntityId } from '../../media-tools/ids';
import styles from './ReferenceBar.module.css';

export interface ReferenceBarProps {
  generatorId: string;
  inputs: CompiledInput[];
  /** nodeId → thumbnail URL. */
  previews: Record<string, string | undefined>;
}

/** The incoming `reference` edge that brings `nodeId` to the generator (direct, else through a group). */
export function referenceEdgeFor(graph: GenerationGraph, generatorId: string, nodeId: string): string | null {
  const incoming = graph.edges.filter((edge) => edge.role === 'reference' && edge.to === generatorId);
  const direct = incoming.find((edge) => edge.from === nodeId);
  if (direct) return direct.id;
  const viaGroup = incoming.find((edge) => graph.nodes.find((node) => node.id === edge.from)?.memberIds?.includes(nodeId));
  return viaGroup?.id ?? null;
}

/** Board nodes that may become a new reference of the generator (not itself, not yet connected). */
export function eligibleReferenceNodes(graph: GenerationGraph, generatorId: string): GenerationGraphNode[] {
  const connected = new Set(graph.edges.filter((edge) => edge.role === 'reference' && edge.to === generatorId).map((edge) => edge.from));
  return graph.nodes.filter((node) => node.id !== generatorId && !connected.has(node.id) && canConnectToGenerator(node, graph));
}

function nodeTitle(node: GenerationGraphNode, fallback: string): string {
  const title = node.title?.trim();
  if (title) return title;
  const text = node.text?.trim();
  if (text) return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return fallback;
}

export const ReferenceBar = forwardRef<HTMLButtonElement, ReferenceBarProps>(function ReferenceBar(
  { generatorId, inputs, previews },
  addRef,
) {
  const t = useT();
  const generation = useGeneration();
  const graph = useBoardGraph();
  const { board } = generation;
  const [picking, setPicking] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const eligible = useMemo(() => eligibleReferenceNodes(graph, generatorId), [graph, generatorId]);

  const removeInput = (nodeId: string) => {
    const edgeId = referenceEdgeFor(board.getGraph(), generatorId, nodeId);
    if (!edgeId) return;
    board.apply([{ type: 'edge.remove', id: edgeId }], { label: 'generation.reference.remove', undoable: true, flush: true });
  };

  const addReference = (nodeId: string) => {
    board.apply(
      [{ type: 'edge.add', edge: { id: newBoardEntityId(), from: nodeId, to: generatorId, role: 'reference' } }],
      { label: 'generation.reference.add', undoable: true, flush: true },
    );
  };

  const startPick = () => {
    if (!board.startReferencePick) return;
    setPicking(true);
    board.startReferencePick({
      generatorId,
      isEligible: (node) => eligibleReferenceNodes(board.getGraph(), generatorId).some((entry) => entry.id === node.id),
      onPick: (nodeId) => addReference(nodeId),
      onExit: () => setPicking(false),
    });
  };

  const addButton = (
    <Button
      ref={addRef}
      variant="bare"
      className={styles.add}
      aria-label={t('fantay.gen.refs.add')}
      data-testid="fx-gen-refs-add"
      {...BOARD_CONTROL_PROPS}
      {...(board.startReferencePick ? { onClick: startPick } : {})}
    >
      <ImagePlus strokeWidth={1.5} aria-hidden />
      <span className={styles.addLabel}>{t('fantay.gen.refs.title')}</span>
    </Button>
  );

  return (
    <div className={styles.root} data-testid="fx-gen-refs">
      {picking ? (
        <span className={styles.hint} role="status">
          {t('fantay.gen.refs.pickHint')}
        </span>
      ) : !board.startReferencePick && listOpen && eligible.length === 0 ? (
        <span className={styles.hint} role="status">
          {t('fantay.gen.prompt.mentionEmpty')}
        </span>
      ) : null}
      <div className={styles.strip} {...BOARD_INTERACTIVE_PROPS}>
        {inputs.map((input) => {
          const preview = input.kind === 'image' ? previews[input.nodeId] : undefined;
          const tooltip =
            input.kind === 'image' && preview ? (
              <img className={styles.preview} src={preview} alt={input.title ?? input.label} />
            ) : (
              <span className={styles.previewText}>{input.text ?? input.title ?? input.label}</span>
            );
          return (
            <Tooltip key={input.nodeId} label={tooltip} className="max-w-[300px] p-1.5">
              <span
                className={styles.tile}
                data-sent={input.sent ? 'true' : 'false'}
                data-kind={input.kind}
                data-testid={`fx-gen-ref-${input.nodeId}`}
                aria-label={input.title ? `${input.label} · ${input.title}` : input.label}
                role="group"
              >
                {preview ? (
                  <img className={styles.tileMedia} src={preview} alt="" draggable={false} />
                ) : input.kind === 'image' ? (
                  <ImageIcon className={styles.tileIcon} size={18} strokeWidth={1.5} aria-hidden />
                ) : (
                  <FileText className={styles.tileIcon} size={18} strokeWidth={1.5} aria-hidden />
                )}
                <span className={styles.badge}>{input.label}</span>
                {!input.sent ? <ImageOff className={styles.strike} size={12} strokeWidth={1.5} aria-hidden /> : null}
                <IconButton
                  size="xs"
                  shape="round"
                  variant="frosted"
                  className={styles.remove}
                  aria-label={`${t('fantay.gen.refs.remove')} · ${input.label}`}
                  tooltip={t('fantay.gen.refs.remove')}
                  data-testid={`fx-gen-ref-remove-${input.nodeId}`}
                  {...BOARD_CONTROL_PROPS}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeInput(input.nodeId);
                  }}
                >
                  <X strokeWidth={1.5} />
                </IconButton>
              </span>
            </Tooltip>
          );
        })}
        {board.startReferencePick ? (
          addButton
        ) : (
          <Popover open={listOpen} onOpenChange={setListOpen}>
            <PopoverTrigger asChild>{addButton}</PopoverTrigger>
            <PopoverContent width={280} align="start" side="bottom" data-testid="fx-gen-refs-pick" {...BOARD_INTERACTIVE_PROPS}>
              <div className={styles.pickList} role="listbox" aria-label={t('fantay.gen.refs.add')}>
                {eligible.length === 0 ? (
                  <div className={styles.pickEmpty}>{t('fantay.gen.refs.pickEmpty')}</div>
                ) : (
                  eligible.map((node) => {
                    const picture = node.image ? mediaUrl(generation.projectId, node.image.path, generation.workspaceContext) : null;
                    const label = nodeTitle(node, t(node.kind === 'note' ? 'fantay.gen.refs.labelText' : 'fantay.media.untitledImage', { n: '' }));
                    return (
                      <Button
                        key={node.id}
                        variant="bare"
                        size="md"
                        className={styles.pickRow}
                        role="option"
                        aria-selected={false}
                        data-testid={`fx-gen-refs-pick-${node.id}`}
                        onClick={() => {
                          addReference(node.id);
                          setListOpen(false);
                        }}
                      >
                        <span className={styles.pickThumb} aria-hidden>
                          {picture ? <img src={picture} alt="" /> : <FileText size={16} strokeWidth={1.5} />}
                        </span>
                        <span className={styles.pickTitle}>{label}</span>
                      </Button>
                    );
                  })
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
});
