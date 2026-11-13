// SPDX-License-Identifier: AGPL-3.0-only
// Board generation service (spec 05 §4). The UI components live in `./components` (W2-gen-ui) and are not
// re-exported here (plan §4 W2-gen-core), so importing the service never pulls the component tree.
export {
  GenerationContext,
  GenerationProvider,
  type GenerationContextValue,
  type GenerationProviderProps,
  type GenerationSettingsSection,
  type GenerationToolDialogRequest,
} from './GenerationProvider';
export {
  resetGenerationCatalogCacheForTests,
  runDisabledReasonFor,
  useBoardGraph,
  useCandidateProgress,
  useGeneration,
  useGenerationCatalog,
  useGeneratorView,
  type GenerationCatalogOptions,
  type GeneratorView,
  type RunDisabledInput,
} from './hooks';
export {
  BOARD_COVER_REFERENCE_PREFIX,
  SNAPSHOT_COVER_REFERENCE_PREFIX,
  coverReferenceOf,
  createGenerationBoardPort,
  generationOpsToBoardOps,
  referenceSourceKey,
  toGenerationGraph,
  type BoardStoreLike,
  type CoverReference,
  type GenerationBoardPort,
  type GenerationBoardUi,
  type ReferencePickOptions,
} from './board-adapter';
export {
  GenerationService,
  canAddCandidate,
  fitFrameToMedia,
  generationRunTitle,
  retryableCandidatesOfLatestRun,
  type CandidateProgress,
  type GenerationEvent,
  type GenerationServiceDeps,
  type RunBlockedReason,
  type RunOutcome,
} from './generation-service';
export {
  buildGenerationCatalog,
  findOption,
  modelAvailability,
  pickDefaultModel,
  type BuildGenerationCatalogInput,
  type GenerationModelGroup,
  type GenerationModelOption,
  type ModelAvailability,
  type ModelReadiness,
  type PickDefaultModelPrefs,
} from './model-catalog';
export {
  listProjectFilesFresh,
  listProjectTasks,
  postGenerate,
  uploadToProject,
  waitTask,
  type DispatchDeps,
  type GenerateResult,
  type WaitResult,
} from './dispatch';
export {
  DEFAULT_WAIT_SCHEDULER_OPTIONS,
  createWaitScheduler,
  type WaitHandlers,
  type WaitOutcome,
  type WaitScheduler,
  type WaitSchedulerClock,
  type WaitSchedulerOptions,
} from './wait-scheduler';
export { mediaUrl, prepareReferenceImages, type PrepareReferenceImagesArgs, type ReferenceConverter } from './references';
export { MEDIA_PROBE_TIMEOUT_MS, probeImage, probeVideo } from './media-probe';
export { NEXT_STEP_ACTIONS, NEXT_STEP_SETTINGS_SECTION, nextStepFor, type NextStepAction, type NextStepRun } from './next-step';
export {
  GENERATION_PREFS_STORAGE_KEY,
  lastUsedGeneration,
  loadGenerationPrefs,
  saveGenerationPrefs,
  type GenerationPrefs,
  type GenerationSurfacePrefs,
} from './preferences';
export { isImeComposing, isPlainEnterKey, isSubmitShortcut, type KeyboardEventLike } from './keyboard';
export {
  collectResumableCandidates,
  findFileByStem,
  recoverCandidateByStem,
  resumeCandidates,
  type ResumePlan,
  type ResumableCandidate,
} from './rehydrate';
// Board factories (spec 04 toolbar "Generate G", connection menu, copy/paste) re-exported from contracts.
export {
  GENERATOR_DEFAULT_SIZE,
  GENERATOR_MIN_SIZE,
  canConnectToGenerator,
  cloneGeneratorData,
  cloneMediaNodeData,
  createGeneratorForSelection,
  createGeneratorNodeInput,
} from '@open-design/contracts';
