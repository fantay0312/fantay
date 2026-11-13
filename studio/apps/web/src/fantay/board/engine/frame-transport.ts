// SPDX-License-Identifier: AGPL-3.0-only
// How a frame shows a project HTML file (spec 03 §5.1, invariant I7). The URL transport is FileViewer's canonical
// passive preview: the daemon's `/raw` route injects the scroll, selection, snapshot and observability bridges plus
// the sandbox/focus/redirect guards (always requested on the board, they are inert where not needed). `fr` and the
// build-focus bridge ride along only while the agent writes the file, so ordinary file changes do not reload every
// live frame. srcdoc (`buildSrcdoc`) is used only when `shouldUrlLoadHtmlPreview` disqualifies the URL path: Edit,
// decks, forms/hash routers, tweaks, root-relative assets.
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { PREVIEW_URL_GUARD_MAX_HTML_BYTES } from '@open-design/contracts/runtime/preview-guards';

import { appendResourceQuery } from '../../../collab/workspace-identity';
import {
  hasTweaksTemplate,
  hasUrlModeBridge,
  htmlNeedsFocusGuard,
  htmlNeedsLocalInteractionBridge,
  htmlNeedsRedirectGuard,
  htmlNeedsSandboxShim,
  shouldUrlLoadHtmlPreview,
} from '../../../components/file-viewer-render-mode';
import {
  htmlHasRootRelativeProjectAssetRefs,
  normalizeRootRelativeProjectAssetRefs,
} from '../../../components/file-viewer-preview-assets';
import { sourceLooksLikeNavigableDeck } from '../../../runtime/exports';
import { buildSrcdoc } from '../../../runtime/srcdoc';
import {
  fetchProjectPreviewBaseHref,
  liveArtifactPreviewUrl,
  projectRawUrl,
  type ProjectPreviewBaseScope,
} from '../../../providers/registry';

/** = FileViewer `HTML_PREVIEW_SANDBOX`: scripts and forms, never same-origin. */
export const FRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads';

/** Above this the source is never fetched and the URL transport is used (contracts preview guard, 2 MiB). */
export const FRAME_SOURCE_MAX_BYTES = PREVIEW_URL_GUARD_MAX_HTML_BYTES;

/** Bridges and guards every board frame requests from the raw route (03 §5.1). */
export const FRAME_BRIDGE_TOKENS = ['scroll', 'selection', 'snapshot', 'observability', 'sandbox', 'focus', 'redirect'] as const;

export type FrameTransport = { kind: 'url'; src: string } | { kind: 'srcdoc'; srcDoc: string };
export type FrameTransportKind = FrameTransport['kind'];

export interface FrameUrlInput {
  projectId: string;
  path: string;
  /** file mtime (cache bust); omitted when the file list does not know the file yet */
  mtime?: number | undefined;
  /** the agent is writing this file: add `fr` + the build-focus bridge */
  building?: boolean;
  filesRefreshKey?: number | undefined;
  /** a HyperFrames composition shown in a motion node */
  motion?: boolean;
  /** reload counter (Reload action) */
  reload?: number;
  workspaceContext?: WorkspaceCollabContext | null;
}

/** The URL transport of a project HTML file (03 §5.1). */
export function frameUrl(input: FrameUrlInput): string {
  const query: string[] = [];
  if (typeof input.mtime === 'number' && Number.isFinite(input.mtime)) query.push(`v=${Math.round(input.mtime)}`);
  if (input.reload) query.push(`r=${input.reload}`);
  for (const token of FRAME_BRIDGE_TOKENS) query.push(`odPreviewBridge=${token}`);
  if (input.building) {
    query.push(`fr=${input.filesRefreshKey ?? 0}`);
    query.push('odPreviewBridge=buildfocus');
  }
  if (input.motion) query.push('odMotionPreview=1');
  return appendResourceQuery(projectRawUrl(input.projectId, input.path, input.workspaceContext), query.join('&'));
}

/** A live artifact rendered by the daemon (frame nodes with `liveArtifactId`, never `allow-same-origin`). */
export function liveArtifactFrameUrl(projectId: string, artifactId: string, workspaceContext?: WorkspaceCollabContext | null): string {
  return liveArtifactPreviewUrl(projectId, artifactId, 'rendered', workspaceContext);
}

/** FileViewer's deck heuristic (`sourceLooksLikeDeckPreview`): `.slide` sections or a navigable deck structure. */
export function looksLikeDeck(source: string | null | undefined): boolean {
  if (!source) return false;
  return /class\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])/i.test(source) || sourceLooksLikeNavigableDeck(source);
}

export interface FrameTransportDecisionInput {
  source: string | null;
  path: string;
  sizeBytes: number;
  projectFilePaths: ReadonlySet<string> | null;
  editing: boolean;
  isDeckProject: boolean;
}

/** URL by default; srcdoc only where the URL path cannot carry what the document needs (03 §5.1). */
export function decideFrameTransport(i: FrameTransportDecisionInput): FrameTransportKind {
  if (i.sizeBytes > FRAME_SOURCE_MAX_BYTES) return 'url';
  if (i.editing) return 'srcdoc';
  if (!i.source) return 'url';
  const deck = i.isDeckProject || looksLikeDeck(i.source);
  if (deck) return 'srcdoc';
  return shouldUrlLoadHtmlPreview({
    mode: 'preview',
    isDeck: false,
    commentMode: false,
    inspectMode: false,
    editMode: false,
    urlModeBridge: hasUrlModeBridge(i.source),
    urlCommentBridge: true,
    urlSnapshotBridge: true,
    paletteActive: false,
    drawMode: false,
    tweaksBridge: hasTweaksTemplate(i.source),
    forceInline: false,
    needsSandboxShim: htmlNeedsSandboxShim(i.source),
    urlSandboxGuard: true,
    needsLocalInteractionBridge: htmlNeedsLocalInteractionBridge(i.source),
    needsFocusGuard: htmlNeedsFocusGuard(i.source),
    urlFocusGuard: true,
    needsRedirectGuard: htmlNeedsRedirectGuard(i.source),
    urlRedirectGuard: true,
    projectRootAssetRefs: htmlHasRootRelativeProjectAssetRefs(i.source, i.projectFilePaths),
  })
    ? 'url'
    : 'srcdoc';
}

export interface BuildFrameSrcdocInput {
  projectId: string;
  path: string;
  source: string;
  projectFilePaths: ReadonlySet<string> | null;
  editing: boolean;
  deck: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  /** reload counter: makes the srcdoc string differ so the browser re-parses identical bytes */
  reloadKey?: number;
}

export interface BuildFrameSrcdocDeps {
  fetchBaseHref?: typeof fetchProjectPreviewBaseHref;
}

/** The srcdoc document of a frame: preview base scope, root-relative refs normalized, the board's bridges (03 §5.1). */
export async function buildFrameSrcdoc(
  i: BuildFrameSrcdocInput,
  deps: BuildFrameSrcdocDeps = {},
): Promise<{ srcDoc: string; scope: ProjectPreviewBaseScope | null }> {
  const fetchBaseHref = deps.fetchBaseHref ?? fetchProjectPreviewBaseHref;
  const scope = await fetchBaseHref(i.projectId, i.path, i.workspaceContext).catch(() => null);
  const html = i.projectFilePaths ? normalizeRootRelativeProjectAssetRefs(i.source, i.path, i.projectFilePaths) : i.source;
  const srcDoc = buildSrcdoc(html, {
    ...(scope?.href ? { baseHref: scope.href } : {}),
    selectionBridge: true,
    editBridge: i.editing,
    deck: i.deck,
    deckClickNavigation: i.deck,
    previewFocusGuard: true,
    previewObservability: true,
    deferFontStylesheets: true,
    motionPreview: true,
    ...(i.reloadKey !== undefined ? { reloadKey: i.reloadKey } : {}),
  });
  return { srcDoc, scope };
}

/** Stable identity of a transport (double buffering swaps only when it changes). */
export function transportKey(transport: FrameTransport | null): string {
  if (!transport) return '';
  return transport.kind === 'url' ? `url:${transport.src}` : `srcdoc:${transport.srcDoc.length}:${hashString(transport.srcDoc)}`;
}

/** Small non-cryptographic string hash (FNV-1a, 32 bit). */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
