// SPDX-License-Identifier: Apache-2.0
// Fantay board (画板) data contract: spec 04 §3.1, amended by plan R3 a–e and amendment C8.
import type { ApiValidationIssue } from '../errors.js';
import type { MediaFailureNextStep } from './media.js';
import type {
  GenerationSurface,
  GeneratorParams,
  GeneratorRunSummary,
  MediaNodeGeneration,
} from './board-generation.js';

export const BOARD_SCHEMA_VERSION = 1 as const;

export const BOARD_NODE_KINDS = [
  'frame', 'web', 'image', 'video', 'audio', 'note', 'shape', 'group', 'generator', 'design', 'motion',
] as const;
export type BoardNodeKind = (typeof BOARD_NODE_KINDS)[number];

export const BOARD_EDGE_KINDS = ['reference', 'output', 'lineage'] as const;
export type BoardEdgeKind = (typeof BOARD_EDGE_KINDS)[number];

export const BOARD_LIMITS = {
  maxNodes: 2000,
  maxEdges: 4000,
  maxDocumentBytes: 3 * 1024 * 1024,   // JSON.stringify(content).length; below the global 4mb parser (server.ts:3290)
  maxOpsPerPatch: 200,
  maxGroupDepth: 2,                    // a group may contain groups; a nested group may not
  maxTitleLength: 200,
  maxNoteTextLength: 20_000,
  maxShapeTextLength: 5_000,
  maxPromptLength: 8_000,
  maxPathLength: 512,
  maxUrlLength: 2_048,
  maxCoordinate: 10_000_000,
  minNodeSize: 8,
  maxNodeSize: 20_000,
  maxGroupSize: 100_000,
  maxGeneratorCount: 4,                // GeneratorParams.count 1..4 (plan R3a)
  maxGeneratorRuns: 20,
  maxVariantLabelLength: 32,
  maxCoverBytes: 1_572_864,            // 1.5 MiB
  maxCoverDimension: 4_096,
  maxSelectionContextNodes: 24,
  maxImportDocuments: 20,
  maxPages: 50,
  maxPageTitleLength: 60,
} as const;

export const BOARD_LAYOUT = {
  itemGap: 80,          // Doop auto-place "rightmost + 80" (server/store.ts:618-619), interface fact only
  variantGap: 48,
  clusterGapY: 160,
  groupPad: 24,         // infinite-canvas GROUP_WRAP_PADDING (MIT)
  groupHeader: 52,      // infinite-canvas GROUP_WRAP_TOP_PADDING (MIT)
  rowWrapWidth: 6_000,
  spiralStep: 40,
  spiralMaxSteps: 200,
} as const;

export type BoardDevice = 'desktop' | 'tablet' | 'mobile' | 'custom';
export const BOARD_DEVICE_SIZES: Record<Exclude<BoardDevice, 'custom'>, { w: number; h: number }> = {
  desktop: { w: 1440, h: 900 },
  tablet: { w: 834, h: 1112 },
  mobile: { w: 390, h: 844 },
};
export const BOARD_MEDIA_MAX_DISPLAY = 960;
export const BOARD_DEFAULT_SIZES: Record<Exclude<BoardNodeKind, 'group'>, { w: number; h: number }> = {
  frame: { w: 1440, h: 900 }, web: { w: 1440, h: 900 }, image: { w: 640, h: 640 }, video: { w: 960, h: 540 },
  audio: { w: 360, h: 120 }, note: { w: 280, h: 220 }, shape: { w: 240, h: 160 }, generator: { w: 320, h: 272 },
  design: { w: 960, h: 600 }, motion: { w: 960, h: 540 },
};

/** Generator surfaces offered in phase 1 (audio generation is deferred, amendment C8). */
export const BOARD_GENERATOR_SURFACES: readonly GenerationSurface[] = ['image', 'video'];

/** The page of a board that never added one: nodes without `page` live here until the first page is removed. */
export const BOARD_DEFAULT_PAGE_ID = 'page_1';

/** One canvas of the board (Page 1, Page 2, …). Every page is its own infinite canvas with its own camera. */
export interface BoardPage { id: string; title: string }

export type BoardActorKind = 'user' | 'agent' | 'cli' | 'sync' | 'daemon';
/** Provenance only, never authority. Clients may claim user|agent|cli; the daemon coerces sync|daemon to user. */
export interface BoardActor {
  kind: BoardActorKind;
  /** Per-tab id of the web client (sessionStorage). Used to ignore own SSE echoes and to gate undo. */
  clientId?: string;
  runId?: string;
}

/** Last saved camera: world point at the viewport centre plus zoom. Not revisioned. */
export interface BoardViewport { centerX: number; centerY: number; zoom: number }

export const BOARD_PALETTE = ['ink', 'gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'] as const;
export type BoardPaletteColor = (typeof BOARD_PALETTE)[number];
/** Palette token (themed by the UI) or `#RRGGBB` / `#RRGGBBAA`. */
export type BoardColor = BoardPaletteColor | `#${string}`;

/** Project file reference. `path` = ProjectFile.name (project-relative POSIX). The daemon fills `workspaceArtifactId`. */
export interface BoardFileRef { path: string; workspaceArtifactId?: string }

export type BoardCoverRef =
  | {
      source: 'board-cover';
      digest: string;                                   // sha256 hex of the stored bytes
      mime: 'image/webp' | 'image/png' | 'image/jpeg';
      width: number;
      height: number;
      capturedAt: number;
      /** mtime of the source file when captured; the UI treats the cover as stale when file.mtime > sourceMtime + 1000. */
      sourceMtime?: number;
    }
  | { source: 'chat-artifact-snapshot'; snapshotId: string; sourceMtime?: number };

export interface BoardMissingState { since: number }

export type BoardNodeOriginSource = 'user' | 'chat-turn' | 'media-task' | 'generator' | 'seed' | 'cli' | 'migration';
export interface BoardNodeOrigin {
  source: BoardNodeOriginSource;
  conversationId?: string;
  messageId?: string;       // assistant message of the turn
  runId?: string;
  mediaTaskId?: string;
  batchId?: string;
  batchIndex?: number;
  generatorNodeId?: string;
}

/** Material provenance (plan R3d): set when a node was inserted from the materials library. Patchable; `null` clears. */
export interface BoardNodeProvenance {
  source: 'material';
  materialId: string;
  license: string;
  receiptPath?: string;     // project-relative path of the licence receipt, when one was written
  sourceUrl?: string;       // http(s) page the material came from
}

export interface BoardNodeCommon {
  id: string;
  x: number; y: number;     // world px, top-left; world px = CSS px at zoom 1
  w: number; h: number;
  title?: string;           // user label; absent ⇒ UI derives one (labels.ts)
  parentId?: string;        // containing group
  /** Canvas page (`BoardPage.id`); absent or unknown ⇒ the first page. A child always shares its group's page. */
  page?: string;
  variantLabel?: string;    // raw label ('a', 'bold', '2'); display via formatBoardVariantLabel
  locked?: boolean;
  hidden?: boolean;
  /** Set on derived media nodes: the UI fits w/h to the intrinsic aspect once, then sends {autoSize:false}. */
  autoSize?: boolean;
  origin?: BoardNodeOrigin;
  provenance?: BoardNodeProvenance;
  missing?: BoardMissingState;   // server-managed (reconcile)
  createdAt: number;
  updatedAt: number;
  createdBy: BoardActor;
  updatedBy: BoardActor;
  rev: number;
}

export interface BoardFrameNode extends BoardNodeCommon {
  kind: 'frame';
  ref: BoardFileRef | null;     // null only when liveArtifactId is set
  liveArtifactId?: string;
  device?: BoardDevice;         // default 'desktop'; w/h ARE the iframe viewport size
  scrollY?: number;
  cover?: BoardCoverRef;
}
export interface BoardWebNode extends BoardNodeCommon {
  kind: 'web';
  url: string;                  // http: or https: only
  browserTabId?: string;        // ProjectTabsState.browserTabs[].id when created from a browser tab
  device?: BoardDevice;
  cover?: BoardCoverRef;
}
export interface BoardPendingMedia {
  mediaTaskId: string;
  status: 'queued' | 'running' | 'failed' | 'interrupted';
  progress?: string;            // last progress line, ≤ 200 chars
  error?: { message: string; nextStep?: MediaFailureNextStep };
}
/** Daemon-ready copy of a media file used as a generation reference (05 `MediaNodeData.refProxy`). */
export interface BoardMediaRefProxy { path: string; sourceKey: string }
export interface BoardImageNode extends BoardNodeCommon {
  kind: 'image';
  ref: BoardFileRef | null;     // null only while `pending` or `generation` is present (plan R3b)
  pending?: BoardPendingMedia;
  naturalWidth?: number;
  naturalHeight?: number;
  /** Generation candidates of this output node (05 §3.2.1), ≤ 16 candidates. */
  generation?: MediaNodeGeneration;
  refProxy?: BoardMediaRefProxy;
}
export interface BoardVideoNode extends BoardNodeCommon {
  kind: 'video';
  ref: BoardFileRef | null;     // null only while `pending` or `generation` is present (plan R3b)
  pending?: BoardPendingMedia;
  naturalWidth?: number;
  naturalHeight?: number;
  durationMs?: number;
  posterTimeMs?: number;
  loop?: boolean;
  muted?: boolean;
  cover?: BoardCoverRef;
  generation?: MediaNodeGeneration;
  refProxy?: BoardMediaRefProxy;
}
export interface BoardAudioNode extends BoardNodeCommon {
  kind: 'audio';
  ref: BoardFileRef | null;
  pending?: BoardPendingMedia;
  durationMs?: number;
}
export type BoardNoteSize = 'sm' | 'md' | 'lg';
export interface BoardNoteNode extends BoardNodeCommon {
  kind: 'note';
  text: string;
  color?: BoardPaletteColor;    // default 'yellow'
  size?: BoardNoteSize;         // default 'md' (plan R3c)
}
export interface BoardTextStyle {
  fontSize: number;             // 8..512
  fontWeight: 400 | 500 | 600 | 700;
  align: 'left' | 'center' | 'right';
  color: BoardColor;
}
export interface BoardShapeNode extends BoardNodeCommon {
  kind: 'shape';
  shape: 'rect' | 'ellipse' | 'text';
  fill?: BoardColor | 'none';
  stroke?: BoardColor | 'none';
  strokeWidth?: number;         // 0..32
  radius?: number;              // rect only, 0..1000
  text?: string;
  textStyle?: BoardTextStyle;
}
export type BoardGroupRole = 'section' | 'turn' | 'variants';
export type BoardGroupLayout = 'free' | 'row' | 'grid';
export type BoardSectionKind = 'frame' | 'design' | 'motion' | 'image' | 'video' | 'audio';
export interface BoardGroupNode extends BoardNodeCommon {
  kind: 'group';
  role: BoardGroupRole;
  /** 'row'/'grid': the daemon owns child positions and refits the group rect. 'free': the UI owns them. Default 'free'. */
  layout?: BoardGroupLayout;
  sectionKind?: BoardSectionKind;  // role 'section' created by seeding or import
  variantKey?: string;             // role 'variants': '<dir><base>#<kind>' or 'batch:<batchId>'
  baseNodeId?: string;             // role 'variants': the node these are variants of
  promotedNodeId?: string;         // role 'variants': chosen child
  color?: BoardPaletteColor;
  collapsed?: boolean;
}
/**
 * Generator node = 05's `GeneratorNodeData`, flattened (plan R3a).
 * References = incoming 'reference' edges (ordered by edge createdAt, then id). Outputs = outgoing 'output' edges.
 */
export interface BoardGeneratorNode extends BoardNodeCommon {
  kind: 'generator';
  version: 1;
  surface: GenerationSurface;      // 'image' | 'video' in phase 1 (amendment C8)
  prompt: string;                  // ≤ 8000; may contain @[node:<id>] reference tokens
  model: string | null;            // null = auto-pick; the resolved id is written back on Run
  params: GeneratorParams;         // count 1..BOARD_LIMITS.maxGeneratorCount
  templateId?: string;
  runs: GeneratorRunSummary[];     // newest first, ≤ BOARD_LIMITS.maxGeneratorRuns
}
export interface BoardDesignNode extends BoardNodeCommon {
  kind: 'design';
  ref: BoardFileRef;               // designs/*.fig | designs/*.op (any project path is accepted)
  format: 'fig' | 'op';
  pageId?: string;
  cover?: BoardCoverRef;
  migratedFrom?: { store: 'design-canvas'; documentId: string; sha256: string };
}
export type BoardMotionSource =
  | { type: 'movie'; projectId: string }        // movie-studio.json of that project (may be another project)
  | { type: 'composition'; ref: BoardFileRef }; // motion-source/<id>/index.html (HyperFrames)
export interface BoardMotionNode extends BoardNodeCommon {
  kind: 'motion';
  source: BoardMotionSource;
  render?: BoardFileRef;          // latest rendered MP4
  aspect?: '16:9' | '9:16' | '1:1';
  cover?: BoardCoverRef;
}

export type BoardNode =
  | BoardFrameNode | BoardWebNode | BoardImageNode | BoardVideoNode | BoardAudioNode | BoardNoteNode
  | BoardShapeNode | BoardGroupNode | BoardGeneratorNode | BoardDesignNode | BoardMotionNode;

/**
 * Edge endpoint rules (plan R3e): `reference` image|note|frame|web|design → generator; `output` generator →
 * image|video|audio; `lineage` any non-group → any non-group (05's `derived` role is stored as `lineage`).
 * Groups are never endpoints. Reference order = edge `createdAt`, then `id`.
 */
export interface BoardEdge {
  id: string;
  kind: BoardEdgeKind;
  from: string;
  to: string;
  label?: string;
  createdAt: number;
  createdBy: BoardActor;
  updatedBy: BoardActor;
  rev: number;
}

export interface BoardSettings {
  background: 'dots' | 'lines' | 'blank';   // default 'dots'
  autoPlace: boolean;                       // chat sync places new outputs; default true
}

/** Revisioned content. */
export interface BoardContent {
  title?: string;
  settings: BoardSettings;
  /** Canvas pages in tab order; absent ⇒ one implicit page (`boardPagesOf`). */
  pages?: BoardPage[];
  nodes: BoardNode[];        // array order = paint order within a layer (groups render beneath non-groups)
  edges: BoardEdge[];
}

export interface BoardTurnLedgerEntry {
  conversationId: string;
  status: 'running' | 'terminal';
  groupId?: string;
  placed: Record<string, string>;   // path → nodeId
  updatedAt: number;
}
/** Server-owned chat-sync bookkeeping (separate column, not revisioned). */
export interface BoardSyncLedger {
  version: 1;
  seededAt: number | null;
  cursor: number;                                  // createdAt watermark of fully processed terminal turns
  turns: Record<string, BoardTurnLedgerEntry>;     // by assistant messageId, ≤ 200
  mediaTasks: Record<string, string>;              // taskId → nodeId, ≤ 300
  dismissed: Record<string, number>;               // path → removedAt, ≤ 500
}

export interface BoardDocument extends BoardContent {
  schemaVersion: typeof BOARD_SCHEMA_VERSION;
  projectId: string;
  revision: number;            // 0 = never saved
  updatedAt: number;
  updatedBy: BoardActor | null;
  viewport: BoardViewport | null;
  /** Page the last saved camera belongs to; agents and sync place new nodes there. Not revisioned. */
  activePageId?: string;
  /** Last saved camera per page. Not revisioned. */
  pageViewports?: Record<string, BoardViewport>;
  sync?: BoardSyncLedger;      // only with GET ?include=sync
}

// ---- drafts, patches, ops ---------------------------------------------------
export type BoardDistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type BoardServerManagedKey = 'rev' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'missing';
export type BoardNodeDraft =
  BoardDistributiveOmit<BoardNode, BoardServerManagedKey | 'id' | 'x' | 'y' | 'w' | 'h'>
  & { id?: string; x?: number; y?: number; w?: number; h?: number };
export type BoardGroupDraft =
  Omit<BoardGroupNode, BoardServerManagedKey | 'id' | 'kind' | 'x' | 'y' | 'w' | 'h' | 'parentId'> & { id?: string };
export type BoardEdgeDraft = Omit<BoardEdge, 'id' | 'rev' | 'createdAt' | 'createdBy' | 'updatedBy'> & { id?: string };

/** Mutable fields across kinds; the validator rejects keys that are not valid for the node's kind. `null` clears an optional field. */
export interface BoardNodePatch {
  x?: number; y?: number; w?: number; h?: number;
  title?: string | null; parentId?: string | null; page?: string | null; variantLabel?: string | null;
  locked?: boolean; hidden?: boolean; autoSize?: boolean;
  provenance?: BoardNodeProvenance | null;
  /** `null` sets the (required, nullable) ref of frame/image/video/audio to null; design refs cannot be null. */
  ref?: BoardFileRef | null; liveArtifactId?: string | null; device?: BoardDevice; scrollY?: number | null;
  cover?: BoardCoverRef | null;
  url?: string; browserTabId?: string | null;
  pending?: BoardPendingMedia | null; naturalWidth?: number | null; naturalHeight?: number | null;
  durationMs?: number | null; posterTimeMs?: number | null; loop?: boolean; muted?: boolean;
  generation?: MediaNodeGeneration | null; refProxy?: BoardMediaRefProxy | null;
  text?: string; color?: BoardPaletteColor; size?: BoardNoteSize | null;
  shape?: 'rect' | 'ellipse' | 'text'; fill?: BoardColor | 'none' | null; stroke?: BoardColor | 'none' | null;
  strokeWidth?: number | null; radius?: number | null; textStyle?: BoardTextStyle | null;
  role?: BoardGroupRole; layout?: BoardGroupLayout; sectionKind?: BoardSectionKind | null; variantKey?: string | null;
  baseNodeId?: string | null; promotedNodeId?: string | null; collapsed?: boolean;
  /** Generator keys (plan R3a). `model: null` selects auto-pick (it is a value, not a clear). */
  surface?: GenerationSurface; prompt?: string; model?: string | null; params?: GeneratorParams;
  templateId?: string | null; runs?: GeneratorRunSummary[];
  format?: 'fig' | 'op'; pageId?: string | null; migratedFrom?: never;
  source?: BoardMotionSource; render?: BoardFileRef | null; aspect?: '16:9' | '9:16' | '1:1' | null;
  /** Server-managed; accepted only from actor kinds 'sync' | 'daemon'. */
  missing?: BoardMissingState | null;
}

export type BoardPlacement =
  | { mode: 'auto' }                                          // new cluster below current content
  | { mode: 'near'; nodeId: string; side?: 'right' | 'below' }
  | { mode: 'at'; x: number; y: number }
  | { mode: 'viewport'; centerX: number; centerY: number };   // nearest free slot around a world point

export type BoardOp =
  | { op: 'add'; node: BoardNodeDraft; placement?: BoardPlacement; ifAbsent?: boolean }
  | { op: 'update'; id: string; patch: BoardNodePatch; expectRev?: number }
  | { op: 'move'; moves: Array<{ id: string; x: number; y: number }>; expectRev?: Record<string, number> }
  | { op: 'remove'; ids: string[]; cascade?: boolean; expectRev?: Record<string, number> }
  | { op: 'connect'; edge: BoardEdgeDraft; ifAbsent?: boolean }
  | { op: 'disconnect'; ids: string[] }
  | { op: 'reorder'; id: string; to: 'front' | 'back' | number; expectRev?: number }
  | { op: 'group'; ids: string[]; group: BoardGroupDraft }
  | { op: 'ungroup'; id: string; expectRev?: number }
  | { op: 'layout'; target: { groupId: string } | { ids: string[] } | { all: true; page?: string };
      mode: 'row' | 'column' | 'grid' | 'tidy'; gap?: number; columns?: number }
  | { op: 'set-meta'; title?: string | null; settings?: Partial<BoardSettings>; pages?: BoardPage[] }
  /** Inverse/undo op: upsert full snapshots, remove ids, optionally restore order. */
  | { op: 'restore'; nodes: BoardNode[]; edges: BoardEdge[]; removeNodeIds: string[]; removeEdgeIds: string[];
      order?: string[]; expectRev?: Record<string, number> };

export interface BoardChangeSet {
  fromRevision: number;
  toRevision: number;
  upsertNodes: BoardNode[];      // full objects after the change; new ids are appended in this order
  removeNodeIds: string[];
  upsertEdges: BoardEdge[];
  removeEdgeIds: string[];
  order?: string[];              // full node id order, present only when z-order changed beyond appends
  meta?: { title: string | null; settings: BoardSettings; pages?: BoardPage[] | null };
}

export type BoardOpSkipReason = 'exists' | 'missing' | 'noop';
export interface BoardOpResult { index: number; status: 'applied' | 'skipped'; reason?: BoardOpSkipReason; ids: string[] }

// ---- HTTP DTOs ---------------------------------------------------------------
export interface BoardGetResponse { board: BoardDocument }

export interface BoardPutRequest {
  baseRevision: number;
  board: { title?: string; settings?: Partial<BoardSettings>; pages?: unknown[]; nodes: unknown[]; edges: unknown[] };  // normalized server-side
  actor?: BoardActor;
}

export interface BoardPatchRequest { baseRevision: number; ops: BoardOp[]; actor?: BoardActor }
export interface BoardPatchResponse {
  revision: number;
  updatedAt: number;
  results: BoardOpResult[];
  changes: BoardChangeSet;       // empty sets + same revision when nothing changed
  inverse: BoardOp[];            // [] when nothing changed, else exactly one 'restore' op
}

export type BoardSyncReason = 'open' | 'run-started' | 'run-finished' | 'focus' | 'media' | 'files-changed' | 'manual';
export interface BoardSyncTurnHint {
  conversationId: string;
  messageId: string;             // assistant message id
  runId?: string;
  status: 'running' | 'terminal';
  paths?: string[];              // produced/declared paths known to the client (validated server-side)
}
export interface BoardSyncRequest {
  reason: BoardSyncReason;
  conversationId?: string;
  turn?: BoardSyncTurnHint;
  focus?: { names: string[]; primary?: string; near?: { x: number; y: number } };
  actor?: BoardActor;
}
export interface BoardSyncPlacement {
  nodeId: string;
  status: 'created' | 'existing' | 'updated' | 'removed';
  path?: string;
  mediaTaskId?: string;
  liveArtifactId?: string;
  groupId?: string;
}
export interface BoardSyncResponse {
  revision: number;
  changed: boolean;
  changes: BoardChangeSet | null;
  placements: BoardSyncPlacement[];
  focus: { nodeIds: string[]; primaryNodeId: string | null } | null;
  unplaceable: string[];         // focus names that cannot live on the board
}

export interface BoardViewportPutRequest { viewport: BoardViewport; pageId?: string }

export type BoardUploadedCoverRef = Extract<BoardCoverRef, { source: 'board-cover' }>;
export interface BoardCoverUploadResponse { cover: BoardUploadedCoverRef; url: string }

export interface BoardImportDesignCanvasRequest { documentIds: string[]; placement?: BoardPlacement }
export interface BoardImportDesignCanvasResult {
  documentId: string;
  status: 'imported' | 'already-imported' | 'not-found' | 'invalid';
  path?: string;
  nodeId?: string;
}
export interface BoardImportDesignCanvasResponse {
  revision: number;
  results: BoardImportDesignCanvasResult[];
  changes: BoardChangeSet | null;
}

// ---- error details (inside ApiError.details) ----------------------------------
export type BoardConflictReason = 'stale-entity' | 'missing-entity' | 'exists' | 'stale-board';
/** `stale-board` is request-wide: it is reported once with `opIndex: -1`, `id: '*'` and `currentRev` = the board revision. */
export interface BoardOpConflict { opIndex: number; id: string; reason: BoardConflictReason; currentRev?: number }
export interface BoardConflictErrorDetails { kind: 'board-conflict'; revision: number; conflicts: BoardOpConflict[] }
export interface BoardLimitErrorDetails { kind: 'board-limit'; limit: keyof typeof BOARD_LIMITS; max: number; actual: number }
export interface BoardRefErrorDetails {
  kind: 'board-ref';
  opIndex: number;
  path: string;
  reason: 'not-found' | 'outside-project' | 'not-placeable';
}
export type BoardValidationIssue = ApiValidationIssue;

// ---- SSE ---------------------------------------------------------------------
export const BOARD_CHANGED_SSE_EVENT = 'board-changed' as const;
export type BoardChangeReason = 'patch' | 'put' | 'sync' | 'import';
export interface BoardChangedSsePayload {
  type: typeof BOARD_CHANGED_SSE_EVENT;
  projectId: string;
  revision: number;
  reason: BoardChangeReason;
  actor: BoardActor;
  at: number;
}

// ---- chat context ------------------------------------------------------------
export const BOARD_SELECTION_CONTEXT_KIND = 'board-selection' as const;
export interface WorkspaceContextBoardNode {
  id: string;                      // board node id (usable with `od board`)
  kind: BoardNodeKind;
  label: string;                   // ≤ 120
  path?: string;                   // file-backed nodes (frame/image/video/audio/design/motion composition)
  url?: string;                    // web nodes
  text?: string;                   // note/shape text or generator prompt excerpt, ≤ 500
  group?: string;                  // parent group display title, ≤ 120
  variantLabel?: string;           // ≤ 32
}

// ---- paths -------------------------------------------------------------------
export function boardApiPath(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/board${suffix}`;
}
export function boardCoverApiPath(projectId: string, digest: string): string {
  return `${boardApiPath(projectId, '/covers')}/${encodeURIComponent(digest)}`;
}
