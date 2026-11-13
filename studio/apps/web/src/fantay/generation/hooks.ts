'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// React hooks over the generation context (spec 05 §4.11). Every external store read passes a server
// snapshot (amendment B2).
import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  GENERATION_LIMITS,
  collectGeneratorInputs,
  compileGeneration,
  generatorRunState,
  referenceLabelSetFor,
  type CompiledGeneration,
  type GenerationGraph,
  type GenerationGraphNode,
  type GenerationParamSupport,
  type GenerationSurface,
  type GeneratorNodeData,
  type GeneratorRunState,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceIdentityCacheKey, workspaceProjectHeaders } from '../../collab/workspace-identity';
import type { Dict } from '../../i18n/types';
import { useAIHubMixModels } from '../../media/aihubmix-image-models';
import { IMAGE_MODELS, VIDEO_MODELS, type MediaModel } from '../../media/models';
import { TOKENTOSEA_SESSION_EVENT } from '../../lib/tokentosea-events';
import { isMediaProviderPickerReady } from '../../media/provider-readiness';
import type { CandidateProgress } from './generation-service';
import { GenerationContext, type GenerationContextValue } from './GenerationProvider';
import {
  buildGenerationCatalog,
  modelAvailability,
  pickDefaultModel,
  type GenerationModelGroup,
  type GenerationModelOption,
} from './model-catalog';
import { lastUsedGeneration } from './preferences';

/** `keyof Dict` (amendment B16). */
type DictKey = keyof Dict;

export function useGeneration(): GenerationContextValue {
  const value = useContext(GenerationContext);
  if (!value) throw new Error('useGeneration must be used inside <GenerationProvider>');
  return value;
}

/** The board as a generation graph; re-renders on every board change. */
export function useBoardGraph(): GenerationGraph {
  const { board } = useGeneration();
  return useSyncExternalStore(board.subscribe, board.getGraph, board.getGraph);
}

// ---- cloud video availability (GET /api/media/models?cloud=true&projectId=) --------------------------

type CloudEntry = { status: 'loading' | 'ready'; ids: string[] | null; image?: MediaModel[]; video?: MediaModel[] };
const cloudEntries = new Map<string, CloudEntry>();
const cloudListeners = new Set<() => void>();

function emitCloud(): void {
  for (const listener of [...cloudListeners]) listener();
}

function subscribeCloud(listener: () => void): () => void {
  cloudListeners.add(listener);
  return () => {
    cloudListeners.delete(listener);
  };
}

function loadCloudVideoIds(key: string, projectId: string, workspaceContext: WorkspaceCollabContext | null): void {
  if (cloudEntries.has(key)) return;
  const pending: CloudEntry = { status: 'loading', ids: null };
  cloudEntries.set(key, pending);
  emitCloud();
  void (async () => {
    let ids: string[] | null = null;
    let image: MediaModel[] | undefined, video: MediaModel[] | undefined;
    try {
      const response = await fetch(`/api/media/models?cloud=true&projectId=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      });
      if (response.ok) {
        const payload = (await response.json()) as { video?: MediaModel[]; image?: MediaModel[] };
        ids = Array.isArray(payload.video)
          ? payload.video.map((entry) => entry?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
          : null;
        const valid = (model: MediaModel) => model?.provider === 'tokentosea' && typeof model.id === 'string' && typeof model.label === 'string' && Array.isArray(model.caps);
        if (Array.isArray(payload.image)) image = payload.image.filter(valid);
        if (Array.isArray(payload.video)) video = payload.video.filter(valid);
      }
    } catch {
      ids = null;
    }
    if (cloudEntries.get(key) !== pending) return;
    if (ids === null) {
      // Unknown availability is not permission to offer a static cloud model.
      cloudEntries.delete(key);
    } else {
      cloudEntries.set(key, { status: 'ready', ids, ...(image ? { image } : {}), ...(video ? { video } : {}) });
    }
    emitCloud();
  })();
}

/** Test hook: forget cached cloud availability. */
export function resetGenerationCatalogCacheForTests(): void {
  cloudEntries.clear();
  emitCloud();
}

function useCloudVideoIds(projectId: string, workspaceContext: WorkspaceCollabContext | null, enabled: boolean) {
  const key = `${projectId}\u0000${workspaceIdentityCacheKey(workspaceContext)}`;
  const entry = useSyncExternalStore(subscribeCloud, () => cloudEntries.get(key), () => undefined);
  useEffect(() => {
    if (enabled) loadCloudVideoIds(key, projectId, workspaceContext);
    const changed = () => { cloudEntries.delete(key); emitCloud(); if (enabled) loadCloudVideoIds(key, projectId, workspaceContext); };
    window.addEventListener(TOKENTOSEA_SESSION_EVENT, changed);
    return () => window.removeEventListener(TOKENTOSEA_SESSION_EVENT, changed);
  }, [enabled, key, projectId, workspaceContext]);
  return { ids: entry?.status === 'ready' ? entry.ids : null, models: entry?.status === 'ready' ? entry : null, loading: entry?.status === 'loading' };
}

export interface GenerationCatalogOptions {
  /** Fetch the Vela cloud video availability (pass true once the model picker opens). */
  loadCloud?: boolean;
}

export function useGenerationCatalog(
  surface: GenerationSurface,
  options?: GenerationCatalogOptions,
): { groups: GenerationModelGroup[]; loading: boolean } {
  const { mediaProviders, projectId, workspaceContext } = useGeneration();
  const aihubmixEnabled = isMediaProviderPickerReady('aihubmix', mediaProviders);
  const aihubmixModels = useAIHubMixModels(surface === 'image' ? 'image_generation' : 'video', aihubmixEnabled);
  const cloud = useCloudVideoIds(projectId, workspaceContext, Boolean(options?.loadCloud));
  const groups = useMemo(
    () =>
      buildGenerationCatalog({
        surface,
        staticModels: [
          ...(surface === 'image' ? IMAGE_MODELS : VIDEO_MODELS).filter(model => model.provider !== 'tokentosea'),
          ...(cloud.models?.[surface] ?? []),
        ],
        aihubmixModels,
        mediaProviders,
        cloudModelIds: cloud.models?.[surface]?.map(model => model.id) ?? [],
      }),
    [surface, aihubmixModels, mediaProviders, cloud.ids, cloud.models],
  );
  return { groups, loading: cloud.loading };
}

// ---- generator view -----------------------------------------------------------------------------------

export interface RunDisabledInput {
  readOnly?: boolean;
  isImportedFolderProject: boolean;
  data: GeneratorNodeData | null;
  model: GenerationModelOption | null;
  referenceCount: number;
  compiled: CompiledGeneration | null;
}

/** Why Run is disabled (tooltip key), in the order the user can act on it; null when Run is allowed. */
export function runDisabledReasonFor(input: RunDisabledInput): DictKey | null {
  if (input.readOnly) return 'board.mode.reason.readOnly';
  if (input.isImportedFolderProject) return 'fantay.gen.run.disabledImported';
  if (!input.data) return 'fantay.gen.run.disabledNoPrompt';
  if (!input.model) return 'fantay.gen.run.disabledNoModel';
  const availability = modelAvailability(input.model, input.referenceCount);
  if (!availability.selectable) {
    if (availability.reason === 'no-references') return 'fantay.gen.refs.unsupported';
    if (availability.reason === 'needs-reference') return 'fantay.gen.refs.needed';
    return 'fantay.gen.model.noneReady';
  }
  if (input.compiled && !input.compiled.ok) {
    return input.compiled.blockReason === 'needs-reference' ? 'fantay.gen.refs.needed' : 'fantay.gen.run.disabledNoPrompt';
  }
  return null;
}

export interface GeneratorView {
  node: GenerationGraphNode | null;
  data: GeneratorNodeData | null;
  /** The model that will run (stored choice when selectable, else the default pick). */
  model: GenerationModelOption | null;
  support: GenerationParamSupport | null;
  compiled: CompiledGeneration | null;
  runState: GeneratorRunState;
  runDisabledReason: DictKey | null;
  /** Reference proxies are being prepared for a run. */
  preparing: boolean;
}

export function useGeneratorView(generatorId: string): GeneratorView {
  const { service, projectMetadata, locale, isImportedFolderProject, readOnly } = useGeneration();
  const graph = useBoardGraph();
  const node = useMemo(
    () => graph.nodes.find((entry) => entry.id === generatorId && entry.kind === 'generator') ?? null,
    [graph, generatorId],
  );
  const data = node?.generator ?? null;
  const surface: GenerationSurface = data?.surface ?? 'image';
  const { groups } = useGenerationCatalog(surface);
  const referenceCount = useMemo(
    () => (data ? collectGeneratorInputs(graph, generatorId).inputs.filter((input) => input.kind === 'image').length : 0),
    [graph, generatorId, data],
  );
  const lastUsed = useMemo(() => lastUsedGeneration(surface)?.model, [surface]);
  const storedModel = data?.model ?? null;
  const projectDefault = surface === 'image' ? projectMetadata?.imageModel : projectMetadata?.videoModel;
  const model = useMemo(
    () =>
      data
        ? pickDefaultModel(groups, { stored: storedModel, projectDefault, lastUsed, referenceCount })
        : null,
    [data, groups, storedModel, projectDefault, lastUsed, referenceCount],
  );
  const support = model?.support ?? null;
  const compiled = useMemo(
    () =>
      data
        ? compileGeneration(graph, generatorId, {
            // Without a model, compile for display only (no truncation/ignored-reference warnings).
            maxReferences: support ? support.maxReferences : GENERATION_LIMITS.maxCandidatesPerNode,
            requiresReference: support?.requiresReference ?? false,
            labels: referenceLabelSetFor(locale),
          })
        : null,
    [data, graph, generatorId, support, locale],
  );
  const runState = useMemo(() => generatorRunState(graph, generatorId), [graph, generatorId]);
  const subscribe = useCallback((listener: () => void) => service.subscribeProgress(listener), [service]);
  const preparing = useSyncExternalStore(
    subscribe,
    () => service.isPreparing(generatorId),
    () => false,
  );
  const runDisabledReason = runDisabledReasonFor({ readOnly, isImportedFolderProject, data, model, referenceCount, compiled });
  return { node, data, model, support, compiled, runState, runDisabledReason, preparing };
}

/** In-memory progress of one candidate (last ≤ 3 lines; `reconnecting` during network trouble). */
export function useCandidateProgress(candidateId: string): CandidateProgress | undefined {
  const { service } = useGeneration();
  const subscribe = useCallback((listener: () => void) => service.subscribeProgress(listener), [service]);
  return useSyncExternalStore(
    subscribe,
    () => service.progressOf(candidateId),
    () => undefined,
  );
}
