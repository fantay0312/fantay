// SPDX-License-Identifier: Apache-2.0
/**
 * Interop registry (06 §8.5): which file formats become a design, routed by extension.
 * `.fig` opens natively, `.op` stays an `.op` (read-only viewer), the rest convert into a new
 * `.fig` graph. Penpot is a disabled later-phase entry.
 */
import { DesignBridgeFailure, type DesignOpenWarning } from '@open-design/contracts/runtime/design-editor-bridge';

import { isForeignFig, parseFigDocument } from '../editor/document';
import type { SceneGraph } from '../engine/op';
import { doopCanvasToHtml } from './doop';
import { htmlToSceneGraph } from './html';
import { penToSceneGraph } from './pen';
import { PENPOT_EXTENSIONS, PENPOT_INTEROP_ENABLED } from './penpot';
import { svgToSceneGraph } from './svg';

export interface DesignInteropContext {
  fetchAsset(path: string): Promise<{ bytes: ArrayBuffer; mime: string }>;
  t(key: string, vars?: Record<string, string>): string;
  signal?: AbortSignal;
}

export type DesignImportResult =
  | { kind: 'graph'; graph: SceneGraph; warnings: DesignOpenWarning[]; foreign?: boolean }
  | { kind: 'op'; bytes: Uint8Array };

export interface DesignImportInput {
  fileName: string;
  bytes: ArrayBuffer;
  sourcePath?: string | null;
}

export interface DesignInterop {
  id: 'fig' | 'op' | 'pen' | 'svg' | 'html' | 'doop-json' | 'penpot';
  /** Nominative format name only, e.g. 'Penpot (.penpot)'. */
  label: string;
  /** Lower case, no dot. */
  extensions: readonly string[];
  enabled: boolean;
  import?(input: DesignImportInput, ctx: DesignInteropContext): Promise<DesignImportResult>;
  export?(graph: SceneGraph, ctx: DesignInteropContext): Promise<{ bytes: Uint8Array; mime: string; extension: string }>;
}

export function baseNameOf(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'design';
}

function text(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

export const DESIGN_INTEROPS: readonly DesignInterop[] = [
  {
    id: 'fig',
    label: 'Figma (.fig)',
    extensions: ['fig'],
    enabled: true,
    async import(input, ctx) {
      const foreign = isForeignFig(new Uint8Array(input.bytes));
      const graph = await parseFigDocument(input.bytes, ctx.signal);
      return { kind: 'graph', graph, warnings: foreign ? ['foreign-fig'] : [], foreign };
    },
  },
  {
    id: 'op',
    label: 'OP document (.op)',
    extensions: ['op'],
    enabled: true,
    async import(input) {
      return { kind: 'op', bytes: new Uint8Array(input.bytes) };
    },
  },
  {
    id: 'pen',
    label: 'Pencil (.pen)',
    extensions: ['pen'],
    enabled: true,
    async import(input) {
      return { kind: 'graph', graph: await penToSceneGraph(input.fileName, input.bytes), warnings: [] };
    },
  },
  {
    id: 'svg',
    label: 'SVG (.svg)',
    extensions: ['svg'],
    enabled: true,
    async import(input) {
      return { kind: 'graph', graph: svgToSceneGraph(text(input.bytes), baseNameOf(input.fileName)), warnings: [] };
    },
  },
  {
    id: 'html',
    label: 'HTML (.html, .htm)',
    extensions: ['html', 'htm'],
    enabled: true,
    async import(input, ctx) {
      const { graph, warnings } = await htmlToSceneGraph(text(input.bytes), {
        sourcePath: input.sourcePath ?? null,
        fetchAsset: ctx.fetchAsset,
        pageName: baseNameOf(input.fileName),
        signal: ctx.signal,
      });
      return { kind: 'graph', graph, warnings };
    },
  },
  {
    id: 'doop-json',
    label: 'Doop canvas JSON (.json)',
    extensions: ['json'],
    enabled: true,
    async import(input, ctx) {
      const { graph, warnings } = await htmlToSceneGraph(doopCanvasToHtml(text(input.bytes)), {
        sourcePath: input.sourcePath ?? null,
        fetchAsset: ctx.fetchAsset,
        pageName: baseNameOf(input.fileName),
        signal: ctx.signal,
      });
      return { kind: 'graph', graph, warnings };
    },
  },
  {
    id: 'penpot',
    label: 'Penpot (.penpot)',
    extensions: PENPOT_EXTENSIONS,
    enabled: PENPOT_INTEROP_ENABLED,
  },
];

export function extensionOf(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The enabled interop for a file name, by its extension. */
export function findInterop(fileName: string): DesignInterop | null {
  const extension = extensionOf(fileName);
  if (!extension) return null;
  return DESIGN_INTEROPS.find((interop) => interop.enabled && interop.extensions.includes(extension)) ?? null;
}

export async function importDesignFile(input: DesignImportInput, ctx: DesignInteropContext): Promise<DesignImportResult> {
  const interop = findInterop(input.fileName);
  if (!interop?.import) throw new DesignBridgeFailure('INVALID_REQUEST', `Unsupported design file: ${input.fileName}`);
  return interop.import(input, ctx);
}
