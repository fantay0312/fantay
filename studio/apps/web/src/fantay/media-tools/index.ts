// SPDX-License-Identifier: AGPL-3.0-only
// Media tools of image/video nodes (spec 05 §6.5–§6.8): actions, client-side image operations, frame
// capture, encoding and persistence into the project, thumbnails, and the tool dialogs.
export {
  DESIGN_EDITOR_ACK_TIMEOUT_MS,
  captureVideoFrameNode,
  cropImageNode,
  downloadMedia,
  editVideoInMotion,
  mediaDisplayName,
  mediaFileOf,
  openInDesignEditor,
  sendToChat,
  splitImageNode,
  upscaleImageNode,
  useAsReference,
} from './actions';
export { FANTAY_OPEN_DESIGN_EDITOR_EVENT, type OpenDesignEditorDetail } from './events';
export {
  MAX_UPSCALE_LONG_EDGE,
  buildSplitCuts,
  cropRectToPixels,
  cropToBlob,
  loadImage,
  resolveUpscaleSize,
  splitToBlobs,
  upscaleToBlob,
  type NormalizedRect,
  type SplitParams,
  type UpscaleAlgorithm,
  type UpscaleParams,
} from './image-ops';
export { captureVideoFrame, type CapturedVideoFrame, type VideoFramePosition } from './video-frame';
export { ENCODE_ATTEMPTS, canvasHasAlpha, encodeForProject, extensionForMime, type EncodedImage, type ProjectImageExt } from './encode';
export { measureImageBlob, persistToolOutput, toolOutputPath, toolOutputStem, type PersistDeps, type ToolOutputKind } from './persist';
export {
  CANVAS_IMAGE_PREVIEW_MAX_EDGE,
  THUMBNAIL_CACHE_LIMIT,
  createImageThumbnail,
  getThumbnailDimensions,
  pickImageSource,
  useImageSource,
  useVideoPoster,
} from './thumbnails';
export { useImageEditorViewport } from './use-image-editor-viewport';
export { mediaBaseName, mediaCacheKey, mediaStemName, mediaUrl } from './media-url';
export { createIdSource, newBoardEntityId } from './ids';
export { CropDialog, type CropDialogProps } from './components/CropDialog';
export { SplitDialog, type SplitDialogProps } from './components/SplitDialog';
export { UpscaleDialog, type UpscaleDialogProps } from './components/UpscaleDialog';
export { ToolDialogHost, toolSourceFile, type ToolDialogHostProps } from './components/ToolDialogHost';
