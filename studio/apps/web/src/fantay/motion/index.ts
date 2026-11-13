// SPDX-License-Identifier: AGPL-3.0-only
// Motion barrel for other features (spec 07 §3.1): the board's motion body, the create flow and
// its store, the editor entry, and the sidebar helpers. Plan R5: no `motionNodeSeed` (the daemon
// planner seeds motion nodes); R9: no `MotionSidebarSection` (the shell sidebar builds the section).
export * from './motion-model';
export { MotionNode, MotionNodeBody, type MotionNodeProps } from './MotionNode';
export { MotionCover, type MotionCoverProps } from './MotionCover';
export { MoviePreviewFrame, type MoviePreviewFrameHandle, type MoviePreviewFrameProps } from './MoviePreviewFrame';
export { useMoviePreviewClock, type MoviePreviewClock, type MoviePreviewClockOptions } from './useMoviePreviewClock';
export { useMovieDocument, type MovieDocumentState } from './useMovieDocument';
export { loadMovieStrip, useMovieStrip } from './useMovieStrip';
export { Scrubber, type ScrubberProps } from './Scrubber';
export { captureMotionFrame, sendFrameToChat } from './capture-frame';
export { dropMovieDraft, stashMovieDraft, takeMovieDraft, type CachedMovieDraft } from './movie-draft-cache';
export {
  DEFAULT_MOTION_STYLE,
  MotionCreateCancelled,
  MotionCreateError,
  createMotionProject,
  importVideos,
  initialMotionCreateDraft,
  loadPersonalStyles,
  motionCreateBlockedKey,
  motionCreationDraftToSave,
  movieStylePreview,
  resolveFootageAssets,
  type MotionCreateDraft,
  type MotionCreateResult,
  type MotionCreateTask,
} from './motion-create';
export { MotionCreatePanel, type MotionCreatePanelProps } from './MotionCreatePanel';
export { MotionCreateDialog, type MotionCreateDialogProps } from './MotionCreateDialog';
export { MotionCreateHost, type MotionCreateHostProps } from './MotionCreateHost';
export { StyleFields, type StyleFieldsProps } from './StyleFields';
export {
  closeMotionCreate,
  openMotionCreate,
  useMotionCreateRequest,
  type MotionCreateRequest,
  type MotionCreateTarget,
} from './motion-create-store';
export {
  filterMotionProjects,
  insertMotionFromBoard,
  isMotionProject,
  isOpenMotionStudioCommand,
  motionEditorRoute,
  motionOpenFileName,
  motionProjectOpenRoute,
  openMotionEditor,
  type InsertMotionFromBoardInput,
  type InsertMotionFromBoardResult,
} from './motion-projects';
