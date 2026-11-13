// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-image-toolbar-tools.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: one tool table for image and video nodes with enable rules and
// disabled reasons (spec 05 §6.4) instead of handler callbacks; amendment C5 adds "edit video".
// The table is rendered by the board's ContextBar through `BoardExtensions.nodeActions`
// (node-actions.ts, plan R4); the old floating MediaNodeToolbar is not built.
import type { LucideIcon } from 'lucide-react';
import {
  Camera,
  Crop,
  Download,
  Expand,
  Film,
  Grid2x2,
  Link2,
  MessageSquarePlus,
  PenTool,
  RefreshCw,
  ZoomIn,
} from 'lucide-react';
import {
  GENERATION_LIMITS,
  isActiveSlot,
  type GenerationGraph,
  type GenerationGraphNode,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import type { Dict } from '../../i18n/types';
import type { GenerationBoardPort } from '../generation/board-adapter';
import type { GenerationService } from '../generation/generation-service';
import {
  captureVideoFrameNode,
  downloadMedia,
  editVideoInMotion,
  openInDesignEditor,
  sendToChat,
  useAsReference,
} from '../media-tools/actions';
import { MAX_UPSCALE_LONG_EDGE } from '../media-tools/image-ops';
import type { PersistDeps } from '../media-tools/persist';

type DictKey = keyof Dict;

export type MediaToolId =
  | 'use-as-reference'
  | 'send-to-chat'
  | 'open-in-design'
  | 'crop'
  | 'split'
  | 'upscale'
  | 'download'
  | 'view'
  | 'more-like-this'
  | 'capture-first'
  | 'capture-current'
  | 'capture-last'
  /** Amendment C5: seed a footage film from the video and open the motion editor. */
  | 'edit-video';

/** Dialogs the generation provider hosts (spec 05 §4.11 `openToolDialog`). */
export interface ToolDialogRequest {
  kind: 'crop' | 'split' | 'upscale' | 'preview';
  nodeId: string;
  candidateId?: string;
}

export interface MediaToolContext {
  node: GenerationGraphNode;
  graph: GenerationGraph;
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  service: GenerationService;
  board: GenerationBoardPort;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
  notify: (n: { tone: 'info' | 'success' | 'error'; message: string }) => void;
  openToolDialog: (dialog: ToolDialogRequest) => void;
  videoElement: HTMLVideoElement | null;
  lastActiveGeneratorId: string | null;
  onRevealChat?: (() => void) | undefined;
  /** Test seams (defaults: random ids, Date.now, the multipart project upload). */
  ids?: { next(): string } | undefined;
  now?: (() => number) | undefined;
  upload?: PersistDeps['upload'] | undefined;
}

export type MediaToolAvailability = { enabled: true } | { enabled: false; reasonKey: DictKey };

export interface MediaToolDefinition {
  id: MediaToolId;
  icon: LucideIcon;
  labelKey: DictKey;
  placement: 'bar' | 'more';
  appliesTo: ReadonlyArray<'image' | 'video'>;
  enabled(ctx: MediaToolContext): MediaToolAvailability;
  run(ctx: MediaToolContext): void | Promise<void>;
}

const ENABLED: MediaToolAvailability = { enabled: true };
const NO_MEDIA: MediaToolAvailability = { enabled: false, reasonKey: 'fantay.media.tool.noMedia' };

function hasFile(ctx: MediaToolContext): boolean {
  return Boolean(ctx.node.media?.file?.path);
}

function requireFile(ctx: MediaToolContext): MediaToolAvailability {
  return hasFile(ctx) ? ENABLED : NO_MEDIA;
}

/** True while a candidate of the node is still pending/queued/running. */
export function isMediaGenerating(node: GenerationGraphNode): boolean {
  return Boolean(node.media?.generation?.candidates.some((candidate) => isActiveSlot(candidate.status)));
}

function mediaKindOf(node: GenerationGraphNode): 'image' | 'video' {
  return node.kind === 'video' ? 'video' : 'image';
}

function primaryCandidateId(ctx: MediaToolContext): string | undefined {
  return ctx.node.media?.generation?.primaryCandidateId;
}

export const MEDIA_TOOLS: readonly MediaToolDefinition[] = Object.freeze([
  {
    id: 'use-as-reference',
    icon: Link2,
    labelKey: 'fantay.media.tool.useAsReference',
    placement: 'bar',
    appliesTo: ['image'],
    enabled: requireFile,
    run: (ctx) => {
      useAsReference(ctx);
    },
  },
  {
    id: 'send-to-chat',
    icon: MessageSquarePlus,
    labelKey: 'fantay.media.tool.sendToChat',
    placement: 'bar',
    appliesTo: ['image', 'video'],
    enabled: requireFile,
    run: (ctx) => {
      const file = ctx.node.media?.file;
      if (!file) return;
      const title = ctx.node.title?.trim();
      sendToChat([{ file, kind: mediaKindOf(ctx.node), ...(title ? { title } : {}) }], ctx.onRevealChat);
      ctx.notify({ tone: 'success', message: ctx.t('fantay.media.sentToChat') });
    },
  },
  {
    id: 'crop',
    icon: Crop,
    labelKey: 'fantay.media.tool.crop',
    placement: 'bar',
    appliesTo: ['image'],
    enabled: requireFile,
    run: (ctx) => ctx.openToolDialog({ kind: 'crop', nodeId: ctx.node.id }),
  },
  {
    id: 'split',
    icon: Grid2x2,
    labelKey: 'fantay.media.tool.split',
    placement: 'bar',
    appliesTo: ['image'],
    enabled: requireFile,
    run: (ctx) => ctx.openToolDialog({ kind: 'split', nodeId: ctx.node.id }),
  },
  {
    id: 'upscale',
    icon: ZoomIn,
    labelKey: 'fantay.media.tool.upscale',
    placement: 'bar',
    appliesTo: ['image'],
    enabled: (ctx) => {
      const file = ctx.node.media?.file;
      if (!file?.path) return NO_MEDIA;
      const longEdge = Math.max(file.width ?? 0, file.height ?? 0);
      return longEdge >= MAX_UPSCALE_LONG_EDGE ? { enabled: false, reasonKey: 'fantay.media.upscale.reached' } : ENABLED;
    },
    run: (ctx) => ctx.openToolDialog({ kind: 'upscale', nodeId: ctx.node.id }),
  },
  {
    id: 'capture-current',
    icon: Camera,
    labelKey: 'fantay.media.tool.captureFrame',
    placement: 'bar',
    appliesTo: ['video'],
    enabled: requireFile,
    run: async (ctx) => {
      await captureVideoFrameNode(ctx, 'current');
    },
  },
  {
    id: 'edit-video',
    icon: Film,
    labelKey: 'fantay.media.tool.editVideo',
    placement: 'bar',
    appliesTo: ['video'],
    enabled: (ctx) => {
      if (hasFile(ctx)) return ENABLED;
      if (isMediaGenerating(ctx.node)) return { enabled: false, reasonKey: 'fantay.media.tool.videoGenerating' };
      return NO_MEDIA;
    },
    run: (ctx) => {
      editVideoInMotion(ctx);
    },
  },
  {
    id: 'download',
    icon: Download,
    labelKey: 'fantay.media.tool.download',
    placement: 'bar',
    appliesTo: ['image', 'video'],
    enabled: requireFile,
    run: (ctx) => {
      const file = ctx.node.media?.file;
      if (file) downloadMedia(ctx.projectId, file, ctx.workspaceContext);
    },
  },
  {
    id: 'capture-first',
    icon: Camera,
    labelKey: 'fantay.media.tool.captureFirst',
    placement: 'more',
    appliesTo: ['video'],
    enabled: requireFile,
    run: async (ctx) => {
      await captureVideoFrameNode(ctx, 'first');
    },
  },
  {
    id: 'capture-last',
    icon: Camera,
    labelKey: 'fantay.media.tool.captureLast',
    placement: 'more',
    appliesTo: ['video'],
    enabled: requireFile,
    run: async (ctx) => {
      await captureVideoFrameNode(ctx, 'last');
    },
  },
  {
    id: 'open-in-design',
    icon: PenTool,
    labelKey: 'fantay.media.tool.openInDesign',
    placement: 'more',
    appliesTo: ['image'],
    enabled: requireFile,
    run: async (ctx) => {
      await openInDesignEditor(ctx);
    },
  },
  {
    id: 'view',
    icon: Expand,
    labelKey: 'fantay.media.tool.view',
    placement: 'more',
    appliesTo: ['image', 'video'],
    enabled: requireFile,
    run: (ctx) => {
      const candidateId = primaryCandidateId(ctx);
      ctx.openToolDialog({ kind: 'preview', nodeId: ctx.node.id, ...(candidateId ? { candidateId } : {}) });
    },
  },
  {
    id: 'more-like-this',
    icon: RefreshCw,
    labelKey: 'fantay.media.tool.moreLikeThis',
    placement: 'more',
    appliesTo: ['image', 'video'],
    enabled: (ctx) => {
      const generation = ctx.node.media?.generation;
      if (!generation?.request) return NO_MEDIA;
      if (generation.candidates.length >= GENERATION_LIMITS.maxCandidatesPerNode) {
        return { enabled: false, reasonKey: 'fantay.gen.slot.limitReached' };
      }
      return ENABLED;
    },
    run: async (ctx) => {
      await ctx.service.moreLikeThis(ctx.node.id);
    },
  },
] satisfies MediaToolDefinition[]);

/** The tools of one node kind, in table order (bar first, then more). */
export function getMediaNodeTools(kind: 'image' | 'video'): MediaToolDefinition[] {
  const tools = MEDIA_TOOLS.filter((tool) => tool.appliesTo.includes(kind));
  return [...tools.filter((tool) => tool.placement === 'bar'), ...tools.filter((tool) => tool.placement === 'more')];
}

/** Vars for a tool's disabled reason (`fantay.gen.slot.limitReached` needs `{max}`). */
export function mediaToolReasonVars(reasonKey: DictKey): Record<string, string | number> | undefined {
  return reasonKey === 'fantay.gen.slot.limitReached' ? { max: GENERATION_LIMITS.maxCandidatesPerNode } : undefined;
}
