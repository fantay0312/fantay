// SPDX-License-Identifier: AGPL-3.0-only
// The tool dialogs of the generation provider (spec 05 §6.7, §4.11): crop, split, upscale and the media
// preview, opened through `openToolDialog({ kind, nodeId, candidateId? })`. The provider keeps the
// request; the board assembly passes `renderToolDialogs={({ request, close }) => <ToolDialogHost
// dialog={request} onClose={close} />}` (without props the host reads the provider's `toolDialog`).
// Every dialog stays mounted so Radix plays the exit. A candidate id makes the tool work on that
// candidate's file instead of the node's cover.
import { useEffect, useState } from 'react';
import type { BoardMediaFile, GenerationGraphNode } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { useBoardGraph, useGeneration } from '../../generation/hooks';
import { MediaPreviewDialog } from '../../media-nodes/MediaPreviewDialog';
import { displayFileOf } from '../../media-nodes/media-display';
import { createMediaToolContext } from '../../media-nodes/node-actions';
import type { ToolDialogRequest } from '../../media-nodes/node-tools';
import { cropImageNode, splitImageNode, upscaleImageNode } from '../actions';
import { mediaUrl } from '../media-url';
import { CropDialog } from './CropDialog';
import { SplitDialog } from './SplitDialog';
import { UpscaleDialog } from './UpscaleDialog';

export interface ToolDialogHostProps {
  /** Default: the provider's open request. */
  dialog?: ToolDialogRequest | null;
  /** Default: the provider's `closeToolDialog`. */
  onClose?: () => void;
}

/** The file a tool request works on: the requested candidate's file, else the node's displayed file. */
export function toolSourceFile(node: GenerationGraphNode | undefined, candidateId?: string): BoardMediaFile | null {
  if (!node) return null;
  if (candidateId) {
    const candidate = node.media?.generation?.candidates.find((entry) => entry.id === candidateId);
    if (candidate?.status === 'done' && candidate.file) return candidate.file;
  }
  return displayFileOf(node);
}

export function ToolDialogHost(props: ToolDialogHostProps) {
  const t = useT();
  const generation = useGeneration();
  const graph = useBoardGraph();
  const dialog = props.dialog === undefined ? generation.toolDialog : props.dialog;
  const onClose = props.onClose ?? generation.closeToolDialog;
  const [last, setLast] = useState<ToolDialogRequest | null>(dialog);
  useEffect(() => {
    if (dialog) setLast(dialog);
  }, [dialog]);
  const request = dialog ?? last;
  const node = request ? graph.nodes.find((entry) => entry.id === request.nodeId) : undefined;
  const file = toolSourceFile(node, request?.candidateId);
  const url = file ? mediaUrl(generation.projectId, file.path, generation.workspaceContext) : '';

  /** A fresh tool context at confirm time (the board may have changed while the dialog was open). */
  const contextNow = () => {
    if (!request) return null;
    const graphNow = generation.board.getGraph();
    const nodeNow = graphNow.nodes.find((entry) => entry.id === request.nodeId);
    const fileNow = toolSourceFile(nodeNow, request.candidateId);
    if (!nodeNow || !fileNow) return null;
    return createMediaToolContext(generation, { ...nodeNow, media: { ...nodeNow.media, file: fileNow } }, graphNow, t);
  };

  const imageTool = node?.kind === 'image' && Boolean(file);

  return (
    <>
      <CropDialog
        open={dialog?.kind === 'crop' && imageTool}
        imageUrl={url}
        onClose={onClose}
        onConfirm={async (rect) => {
          const ctx = contextNow();
          if (!ctx) return;
          if (await cropImageNode(ctx, rect)) onClose();
        }}
      />
      <SplitDialog
        open={dialog?.kind === 'split' && imageTool}
        imageUrl={url}
        onClose={onClose}
        onConfirm={async (params) => {
          const ctx = contextNow();
          if (!ctx) return;
          if ((await splitImageNode(ctx, params)).length > 0) onClose();
        }}
      />
      <UpscaleDialog
        open={dialog?.kind === 'upscale' && imageTool}
        imageUrl={url}
        onClose={onClose}
        onConfirm={async (params) => {
          const ctx = contextNow();
          if (!ctx) return;
          if (await upscaleImageNode(ctx, params)) onClose();
        }}
      />
      <MediaPreviewDialog
        open={dialog?.kind === 'preview'}
        nodeId={request?.kind === 'preview' ? request.nodeId : null}
        candidateId={request?.kind === 'preview' ? (request.candidateId ?? null) : null}
        onClose={onClose}
      />
    </>
  );
}
