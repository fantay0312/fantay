// SPDX-License-Identifier: AGPL-3.0-only
// Board engine types (spec 03 §3.0, amended by plan R1/R2/R6/R7). The document comes from spec 04's store
// (`BoardDataStore`) and is derived into an `EngineDoc` by `contract-adapter.ts`; field names follow the
// contract (x/y/w/h, `ref`, `device: 'mobile'`, palette colours, `textStyle`, group fields). The engine itself
// only owns UI state: tool, selection, hover, mode, preview, runtime, visible/live sets and the settled zoom.
import type {
  BoardDocument,
  BoardEdge,
  BoardEdgeKind,
  BoardNode,
  BoardNodeCommon,
  BoardNodeKind,
  ChatMessage,
  ProjectFile,
  ProjectPlatform,
  WorkspaceCollabContext,
} from '@open-design/contracts';

import type { Dict } from '../../../i18n/types';
import type { LiveArtifactWorkspaceEntry } from '../../../types';
import type { Camera } from '../camera/camera';

/** `keyof Dict` (the i18n module exports no `DictKey` alias, amendment B16). */
export type DictKey = keyof Dict;
export type BoardTranslate = (key: DictKey, vars?: Record<string, string | number>) => string;

export type { BoardEdgeKind, BoardNodeKind };

export interface Point { x: number; y: number }
export interface Size { w: number; h: number }
/** World or screen rectangle; same shape as contracts `BoardRect`. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Insets { top: number; right: number; bottom: number; left: number }

/** The contract node of one kind. */
export type BoardNodeOf<K extends BoardNodeKind> = Extract<BoardNode, { kind: K }>;
export type NodeCommonKey = keyof BoardNodeCommon;
/** Kind-specific contract fields (the contract node without `BoardNodeCommon` and `kind`). */
export type NodeDataOf<K extends BoardNodeKind> = Omit<BoardNodeOf<K>, NodeCommonKey | 'kind'>;

/**
 * Common engine fields. An engine node is a read-only view of one 04 node: it is created once per contract
 * node object (memoized by identity), so unchanged nodes keep their identity across documents.
 */
export interface EngineNodeBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** User label; absent → the UI derives one (`model/labels.ts`). */
  readonly title: string | undefined;
  readonly parentId: string | null;
  readonly variantLabel: string | undefined;
  readonly locked: boolean;
  readonly hidden: boolean;
  /** Server-reconciled: the file this node shows is gone (contract `missing`). */
  readonly missing: boolean;
  /** The 04 node this view derives from; server stamps and unknown keys live here. */
  readonly source: BoardNode;
}

/**
 * `data` is the contract node itself typed as its kind-specific part (no copy), so `node.data.ref`,
 * `node.data.device`, `node.data.text`, … read the contract fields directly.
 */
export type EngineNodeOf<K extends BoardNodeKind> = EngineNodeBase & { readonly kind: K; readonly data: NodeDataOf<K> };
export type EngineNode = { [K in BoardNodeKind]: EngineNodeOf<K> }[BoardNodeKind];

export interface EngineEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: BoardEdgeKind;
  readonly label: string | undefined;
  readonly source: BoardEdge;
}

export type BoardSidePanel = 'references' | 'assets';

export interface EngineDoc {
  readonly projectId: string;
  readonly revision: number;
  /** The canvas page this view shows; null before the first load. */
  readonly pageId: string | null;
  readonly nodes: ReadonlyMap<string, EngineNode>;
  readonly edges: ReadonlyMap<string, EngineEdge>;
  /** Paint order: every group (contract array order), then every other node (array order). */
  readonly order: readonly string[];
  /** Index of each node in the contract `nodes` array (z = array order, plan R1). */
  readonly arrayIndex: ReadonlyMap<string, number>;
  /** Direct children per group id, in array order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** The 04 document this view was derived from (null while loading). */
  readonly source: BoardDocument | null;
}

export type NodePhase = 'idle' | 'loading' | 'building' | 'streaming' | 'ready' | 'error' | 'missing';
export type NodeErrorAction = 'retry' | 'reload' | 'open-in-files' | 'open-media-settings' | 'remove';
export type NodeEditSessionState = 'idle' | 'loading' | 'mounting' | 'active' | 'saving' | 'exiting';

export interface NodeRuntime {
  phase: NodePhase;
  /** 0..1 while streaming */
  progress?: number;
  /** building by */
  agentName?: string;
  error?: { messageKey?: DictKey; message?: string; actionId?: NodeErrorAction };
  cover?: { url: string; stale: boolean; source: 'board' | 'chat-snapshot' | 'poster' | 'design-export' | 'image-preview' };
  fileMtime?: number;
  fileSize?: number;
  /** frame: page reported by od:url-selection-bridge-ready */
  currentHref?: string;
  /** video/audio/motion */
  playing?: boolean;
  lastLoadedAt?: number;
  /** Frame Edit session (spec 03 §5.3); the shield lifts while it is active or saving. */
  editSession?: NodeEditSessionState;
}

export type BoardTool = 'select' | 'hand' | 'frame' | 'rectangle' | 'ellipse' | 'text' | 'generate' | 'note' | 'comment';
export type BoardNodeMode = 'navigate' | 'edit' | 'capture';
export type BoardCaptureTool = 'pick' | 'markup';
export type BoardInteraction = 'idle' | 'panning' | 'zooming' | 'dragging' | 'resizing' | 'marquee' | 'drawing' | 'connecting';
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface SnapGuide {
  /** 'v': vertical line at x=`at` spanning `from`..`to` in y; 'h': the converse (world px). */
  axis: 'v' | 'h';
  at: number;
  from: number;
  to: number;
}

export interface BoardContextTarget {
  kind: 'node' | 'edge' | 'background';
  id?: string;
  /** world point of the press */
  world: Point;
  /** client (viewport) point of the press, for positioning a menu */
  client: Point;
}

/** Pending "connect to a new …" request after a connector drag ended on empty canvas (03 §3.8). */
export interface BoardConnectMenuRequest {
  from: string;
  world: Point;
  client: Point;
}

export interface BoardUiState {
  tool: BoardTool;
  /** node ids, selection order */
  selection: readonly string[];
  selectedEdgeId: string | null;
  hoverId: string | null;
  hoverSince: number | null;
  mode: { nodeId: string; mode: BoardNodeMode; captureTool: BoardCaptureTool } | null;
  /** the node filling the stage and the camera 返回 flies back to; the viewer's own pan or zoom ends it */
  maximized: { nodeId: string; returnTo: Camera } | null;
  editingTextId: string | null;
  renamingId: string | null;
  interaction: BoardInteraction;
  spaceHeld: boolean;
  minimapOpen: boolean;
  /** The docked panel beside the canvas (参考 / 我的素材). */
  sidePanel: BoardSidePanel | null;
  wheelZooms: boolean;
  shortcutsOpen: boolean;
  dropActive: boolean;
  contextTarget: BoardContextTarget | null;
  connectMenu: BoardConnectMenuRequest | null;
  /** Bumped by Enter on a selected generator: the generator panel focuses its prompt. */
  panelFocusNonce: number;
}

export interface InteractionPreview {
  /** drag/resize preview per node id (world) */
  rects: ReadonlyMap<string, Rect>;
  /** world */
  marquee?: Rect;
  draw?: { tool: BoardTool; rect: Rect };
  connect?: { from: string; to?: string; point: Point };
  guides?: readonly SnapGuide[];
  dropGroupId?: string | null;
  /** W×H badge while resizing (world px of the resized node) */
  resize?: { id: string; w: number; h: number };
}

/** Everything a node face needs; produced by `useNodeView(id)` (shallow-stable). */
export interface NodeView {
  node: EngineNode;
  runtime: NodeRuntime;
  selected: boolean;
  /** the only selected node */
  soleSelected: boolean;
  hovered: boolean;
  live: boolean;
  mode: BoardNodeMode | null;
  captureTool: BoardCaptureTool | null;
  /** Comment tool on this sole selected node (no node mode, editable board): its page takes comment picks */
  commenting: boolean;
  previewRect: Rect | null;
  layoutZoom: number;
  settledZoom: number;
  /** below the LOD threshold at the settled zoom: render a flat kind-coloured rect */
  lod: boolean;
  editingText: boolean;
  renaming: boolean;
  readOnly: boolean;
  spaceHeld: boolean;
  /** the board tab is visible */
  active: boolean;
  /** a group the current drag would drop into */
  dropTarget: boolean;
}

export interface NodeFaceProps {
  view: NodeView;
}

/** What the host gives the board besides the 04 data value (plan R2 `BoardView` props). */
export interface BoardEnvironment {
  projectId: string;
  files: readonly ProjectFile[];
  filesAuthoritative: boolean;
  filesRefreshKey: number | undefined;
  liveArtifacts: readonly LiveArtifactWorkspaceEntry[];
  messages: readonly ChatMessage[];
  runInFlight: boolean;
  buildingPaths: ReadonlySet<string>;
  buildingAgentName: string | undefined;
  isDeckProject: boolean;
  projectPlatform: ProjectPlatform | undefined;
  viewerOnly: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  onOpenInFiles(path: string): void;
  onOpenBrowserTab?: ((url: string) => void) | undefined;
  onRefreshFiles?: (() => void) | undefined;
}

/**
 * Optional services the board chrome registers at runtime (`engine.services.register`): features whose
 * implementation lives outside the engine core (file copies for duplicate, a custom blank-page writer).
 */
export interface BoardServices {
  /** Duplicates file-backed nodes by copying their files (spec 03 §3.12); resolves to the new node ids. */
  duplicateFileNodes?(nodes: readonly EngineNode[]): Promise<string[]>;
  /** Writes a blank HTML page for the Frame tool and resolves to its project path (default: blank-frame.ts). */
  createBlankFrameFile?(): Promise<string | null>;
}
