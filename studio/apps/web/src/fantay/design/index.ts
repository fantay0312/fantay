// SPDX-License-Identifier: AGPL-3.0-only
// Design documents host (spec 06 §6, plan R10). What the board (W3-board-assembly), the app shell
// (W3-app-integration) and the file-editor registry consume.
export { isDesignDocumentPath } from '@open-design/contracts';

export { DesignEditorHost, describeDesignError, designDocumentTargetKey } from './DesignEditorHost';
export type {
  DesignEditorDocument,
  DesignEditorHandle,
  DesignEditorHostProps,
  DesignEditorState,
  DesignSavedEvent,
  DesignSavedSource,
  DesignSelectionChange,
} from './types';
export { DesignEditorHeader } from './DesignEditorHeader';
export { ConflictBanner } from './ConflictBanner';
export { DesignDocumentViewer, type DesignDocumentViewerProps } from './DesignDocumentViewer';
export { DesignShareCta } from './DesignShareCta';
export { NewDesignDialog, DESIGN_IMPORT_ACCEPT, type NewDesignDialogProps } from './NewDesignDialog';
export { NewDesignDialogHost } from './NewDesignDialogHost';
export { DesignCreationRunner } from './DesignCreationRunner';
export { DesignEditorEventBridge, type DesignEditorEventBridgeProps } from './DesignEditorEventBridge';
export { designFileEditor } from './file-editor';
export { designNodeActions, sendDesignFigmaSnapshotToChat, type DesignNodeActionInput } from './design-node-actions';
export { useDesignBridge, DesignBridgeSession, type DesignBridgeController, type UseDesignBridgeOptions } from './useDesignBridge';
export { useDocumentTheme } from './useDocumentTheme';
export { designEditorMessages } from './messages';
export { designSelectionToWorkspaceItem } from './context';
export { shareDesignAsWebPage, designHtmlPathFor, type ShareDesignResult } from './share';
export {
  DesignApiError,
  designCoverUrl,
  designDownloadUrl,
  fetchProjectAsset,
  listDesigns,
  putDesignCover,
  readDesign,
  saveDesign,
  suggestDesignPath,
  type SaveDesignOutcome,
} from './design-api';
export {
  cancelDesignOpenRequest,
  peekDesignOpenRequest,
  putDesignOpenRequest,
  takeDesignOpenRequest,
  type DesignOpenRequest,
} from './design-open-requests';
export { insertDesignOnBoard, insertFrameOnBoard, openDesignDocument } from './design-workspace';
export {
  closeNewDesignDialog,
  openNewDesignDialog,
  rememberDesignWorkspaceContext,
  startDesignCreation,
  useNewDesignRequest,
  type DesignCreationInput,
  type DesignCreationJob,
  type NewDesignRequest,
  type OpenNewDesignDialogInput,
} from './new-design-store';
