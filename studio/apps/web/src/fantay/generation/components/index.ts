// SPDX-License-Identifier: AGPL-3.0-only
// Generator UI (spec 05 §5, §7). The generation barrel (`../index.ts`, W2-gen-core) does not re-export
// components; import them from here. The board-facing render functions live in `media-nodes/board-extensions`.
export { GeneratorNodeBody, type GeneratorNodeBodyProps } from './GeneratorNodeBody';
export { GeneratorPanel, PROMPT_PATCH_DEBOUNCE_MS, paramsForSurface, warningChips, type GeneratorPanelProps } from './GeneratorPanel';
export { PromptChipEditor, type PromptChipEditorHandle, type PromptChipEditorProps } from './PromptChipEditor';
export { PromptEditorDialog, type PromptEditorDialogProps } from './PromptEditorDialog';
export { MentionMenu, type MentionMenuProps } from './MentionMenu';
export { ReferenceBar, eligibleReferenceNodes, referenceEdgeFor, type ReferenceBarProps } from './ReferenceBar';
export { ModelPicker, type ModelPickerProps } from './ModelPicker';
export { ParamsPopover, paramsSummary, countLabel, qualityLabel, type ParamsPopoverProps } from './ParamsPopover';
export { RunButton, type RunButtonProps, type RunButtonState } from './RunButton';
export { RunStatus, type RunStatusProps } from './RunStatus';
export { GenerationErrorCard, type GenerationErrorCardProps } from './GenerationErrorCard';
export { CandidateStrip, stripEntries, type CandidateStripProps } from './CandidateStrip';
export {
  PromptLibraryPopover,
  combineTemplatePrompt,
  type PromptLibraryApplyInput,
  type PromptLibraryPopoverProps,
} from './PromptLibraryPopover';
export { loadPromptTemplates, usePromptTemplates, cachedPromptTemplate } from './prompt-library-data';
export { createGeneratorOnBoard, generatorPlacementRightOf, type CreateGeneratorInput } from './create-generator';
export {
  requestGeneratorPanelFocus,
  consumeGeneratorPanelFocus,
  useGeneratorPanelFocusRequest,
  type GeneratorPanelFocusRequest,
  type GeneratorPanelFocusTarget,
} from './generator-ui-store';
export { runNextStepAction, outputNodeNextStepTargets, type NextStepTargets } from './next-step-runner';
export { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS, BOARD_REGION_PROPS, stopBoardPointer } from './board-interactive';
export { parsePromptTokens, previewPromptText, serializePromptEditor, promptToken } from './prompt-editor-dom';
