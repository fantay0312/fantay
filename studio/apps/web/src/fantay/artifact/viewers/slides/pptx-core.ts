// SPDX-License-Identifier: AGPL-3.0-only
// The one place the PowerPoint model library is imported.
// `@office-kit/pptx` is the peer of `@office-kit/pptx-preview`. pnpm installs it, but apps/web does
// not list it as a dependency, so its name does not resolve from this package. Until it is listed,
// this file reaches the installed copy through pnpm's hoisted folder. The preview package resolves
// to the same file on disk, so the bundle still holds one instance of the library.
// When `"@office-kit/pptx": "0.28.0"` is in apps/web/package.json, replace the path below with the
// package name; nothing else changes.
export {
  emu,
  getParagraphLevel,
  getParagraphPropertiesEffective,
  getShapeBounds,
  getShapeChartCategories,
  getShapeChartSeriesNames,
  getShapeKind,
  getShapeParagraphCount,
  getShapeParagraphElements,
  getShapePlaceholderType,
  getShapeRunFormatEffective,
  getSlideLayout,
  getSlideLayoutShapes,
  getSlideMasterPartName,
  getSlideMasterShapes,
  getSlideNotes,
  getSlideShapes,
  getSlideSize,
  getSlideTitle,
  getSlides,
  getTableCellText,
  getTableCells,
  getTableSize,
  getTableStyleId,
  hasShapeText,
  isChartShape,
  isShapeHidden,
  isShapePlaceholder,
  isShapeTextBox,
  isSlideHidden,
  isTableShape,
  loadPresentation,
  readPackagePart,
  setParagraphAlignment,
  setShapeBounds,
  setTableStyleId,
} from '../../../../../../../node_modules/.pnpm/node_modules/@office-kit/pptx/dist/index.js';
export type {
  PresentationData,
  SlideData,
  SlideShapeData,
} from '../../../../../../../node_modules/.pnpm/node_modules/@office-kit/pptx/dist/index.js';
