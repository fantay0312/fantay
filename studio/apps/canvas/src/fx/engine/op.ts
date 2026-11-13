// SPDX-License-Identifier: Apache-2.0
/**
 * The single `@open-pencil/*` import surface for Fantay-authored editor code (06 §1, §3.5).
 * Vendored files (src/vendor/open-pencil) keep their own upstream imports; everything under
 * src/fx and src/host imports the engine from here, so a move to 0.17 (one import path per
 * name, `setCanvasKitLocator`, …) changes this file plus a re-vendor.
 */
import corePackage from '@open-pencil/core/package.json';

/** The engine version the editor runs (reported in the bridge `hello`). */
export const OPEN_PENCIL_VERSION: string = corePackage.version;

export {
  createEditor,
  createDefaultEditorState,
  fontManager,
  getCanvasKit,
  exportFigFile,
  parseFigFile,
  renderNodesToImage,
  renderNodesToSVG,
  renderThumbnail,
  computeContentBounds,
  createSVGNodes,
  htmlFormat,
  IORegistry,
  BUILTIN_IO_FORMATS,
  parseColor,
} from '@open-pencil/core';
export type { Editor, EditorState, Tool, SceneNode, ExportRequest } from '@open-pencil/core';
export type { SnappingPreferences } from '@open-pencil/core/editor';
export { DEFAULT_SNAPPING_PREFERENCES, opacityFromBuffer } from '@open-pencil/core/editor';
export { findPageId, isSVGMarkup } from '@open-pencil/core/io';
export type { RasterExportFormat } from '@open-pencil/core/io';
export type { DesignIssueSeverity, RulerTheme, SelectionTheme } from '@open-pencil/core/canvas';
export { nodeToXPath } from '@open-pencil/core/xpath';
export {
  AUTO_LAYOUT_PADDING_EDITOR_OFFSET_X,
  AUTO_LAYOUT_PADDING_EDITOR_OFFSET_Y,
  COMPONENT_LABEL_ICON_GAP,
  COMPONENT_LABEL_ICON_SIZE,
  SECTION_TITLE_GAP,
  SECTION_TITLE_HEIGHT,
} from '@open-pencil/core/constants';
export { WEB_FONT_PROVIDER_IDS, DEFAULT_WEB_FONT_PROVIDER_SETTINGS } from '@open-pencil/core/text';
export type { FontFamilyOption, LocalFontAccessState, WebFontProviderId } from '@open-pencil/core/text';
export { SceneGraph } from '@open-pencil/scene-graph';
export type { Color, PluginDataEntry } from '@open-pencil/scene-graph';
export { sceneGraphFromStyledHTML } from '@open-pencil/core/io/formats/html/layers';
export { browserHTMLToDesignDocument, browserTailwindHTMLToDesignDocument } from '@open-pencil/dom-css/browser';
export {
  provideEditor,
  useEditor,
  useCanvas,
  useCanvasInput,
  useTextEdit,
  useCanvasDrop,
  useCanvasVirtualReference,
  autoLayoutValueAnchor,
  useEditorCommands,
  useSelectionState,
  useSceneComputed,
  useFlatReorderDrag,
  useInlineRename,
  useI18n,
  setLocale,
  toolCursor,
  isCanvasTextInput,
  formatShortcut,
  editorCommandMetadata,
  extractImageFilesFromClipboard,
  createShaderRasterizer,
  createRetainedScopePlugin,
  EDITOR_COMMAND_METADATA,
  EDITOR_KEY,
  TOOL_SHORTCUTS,
  AVAILABLE_LOCALES,
  ToolbarRoot,
  PageListRoot,
} from '@open-pencil/vue';
export type { EditorCommandId, Locale, AutoLayoutValueField } from '@open-pencil/vue';
