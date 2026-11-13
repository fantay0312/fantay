// SPDX-License-Identifier: AGPL-3.0-only
// Public board API (spec 03 §2 index.ts). The workspace host mounts `BoardView` with the 04 data value; board
// chrome, node faces and the assembly read the engine through the contexts and hooks re-exported here.
export { BoardView, type BoardViewProps } from './BoardView';
export {
  BoardEngineContext,
  BoardHostContext,
  BoardLabelLayerContext,
  useBoardEngine,
  useBoardHost,
  useBoardSelector,
  useNodeView,
  useRegisterBoardServices,
  type BoardHostValue,
} from './context';
export { BOARD_INTERACTIVE_ATTR } from './extensions';
export type {
  BoardExtensions,
  BoardMotionBodyProps,
  BoardNodeAction,
  BoardNodeBodyProps,
} from './extensions';
export type {
  AlignMode,
  BoardCommands,
  EnsureFileNodesOptions,
  FocusNodesOptions,
  NewNodeInput,
  ReorderMode,
} from './commands/board-commands';
export { registerBoardShellCommands } from './commands/register-commands';
export { executeFocusIntent, useBoardFocusIntent, type RevealPillState } from './commands/focus-intent';
export { createBoardEngine, type BoardEngine, type BoardEngineOptions, type BoardServicesRegistry } from './store/board-engine';
export type { EngineState, EngineStore } from './store/board-store';
export type { BoardTransaction, BoardTxLabel, EngineOp, NewNodeDraft, NodePatch, TxOrigin } from './store/ops';
export type { CameraController } from './camera/camera-controller';
export {
  CHROME_INSETS,
  MAX_ZOOM,
  MIN_ZOOM,
  SETTLE_MS,
  ZOOM_STEP,
  type Camera,
} from './camera/camera';
export { LIVE_BUDGET } from './engine/live-budget';
export { BOARD_SHORTCUTS, type BoardShortcut, type BoardShortcutId } from './interaction/keyboard';
export { BOARD_TOOLS } from './interaction/tools';
export { NODE_KINDS, type NodeKindDefinition } from './model/node-registry';
export { NOTE_SWATCHES, SHAPE_SWATCHES, FRAME_DEVICES, boardColorCss, noteColorCss } from './model/defaults';
export { nodeDisplayTitle } from './model/labels';
export type {
  BoardContextTarget,
  BoardEnvironment,
  BoardNodeMode,
  BoardServices,
  BoardTool,
  BoardUiState,
  EngineDoc,
  EngineEdge,
  EngineNode,
  EngineNodeOf,
  NodeFaceProps,
  NodeRuntime,
  NodeView,
  Point,
  Rect,
} from './model/types';
