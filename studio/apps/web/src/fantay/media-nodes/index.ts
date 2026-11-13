// SPDX-License-Identifier: AGPL-3.0-only
// Image and video node bodies, the media tool table and the board extensions of the generation UI
// (spec 05 §6.1–§6.4; plan R4, R6; amendment C5).
export { ImageNodeBody, type ImageNodeBodyProps } from './ImageNodeBody';
export { VideoNodeBody, type VideoNodeBodyProps } from './VideoNodeBody';
export { CandidateFan, fanCardPosition, type CandidateFanProps } from './CandidateFan';
export { SlotStatus, type SlotStatusProps } from './SlotStatus';
export { MediaPreviewDialog, type MediaPreviewDialogProps } from './MediaPreviewDialog';
export {
  MEDIA_TOOLS,
  getMediaNodeTools,
  isMediaGenerating,
  mediaToolReasonVars,
  type MediaToolAvailability,
  type MediaToolContext,
  type MediaToolDefinition,
  type MediaToolId,
  type ToolDialogRequest,
} from './node-tools';
export {
  buildMediaNodeActions,
  createMediaToolContext,
  useMediaNodeActions,
  type MediaNodeActionsDeps,
  type MediaToolContextExtras,
} from './node-actions';
export {
  GENERATION_BODY_EXTENSIONS,
  renderGeneratorBody,
  renderGeneratorPanel,
  renderImageBody,
  renderVideoBody,
  useGenerationBoardExtensions,
  type GenerationBoardExtensions,
} from './board-extensions';
export { displayFileOf, primaryCandidateOf, secondaryCandidatesOf, useGenerationNode, formatElapsed } from './media-display';
