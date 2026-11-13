// SPDX-License-Identifier: AGPL-3.0-only
// Generation model catalog (spec 05 §4.3): the web media registry filtered to models whose renderer can run
// on the board, variant groups collapsed into one option, BYOK readiness, the cloud group, and the default
// pick. Pure functions; `hooks.ts` feeds them the live AIHubMix list and the cloud video availability.
import {
  paramSupportFor,
  variantGroupFor,
  type GenerationParamSupport,
  type GenerationSurface,
} from '@open-design/contracts';

import { canonicalMediaModelId, findProvider, type MediaModel } from '../../media/models';
import { mergeAihubmixModels } from '../../media/aihubmix-image-models';
import { isMediaModelPickerReady, isMediaProviderPickerReady } from '../../media/provider-readiness';
import type { MediaProviderCredentials } from '../../types';

export type ModelReadiness = 'ready' | 'needs-setup' | 'cloud';

export interface GenerationModelOption {
  /** Base id (variant groups collapsed). */
  id: string;
  label: string;
  hint: string;
  provider: string;
  providerLabel: string;
  surface: GenerationSurface;
  caps: string[];
  support: GenerationParamSupport;
  readiness: ModelReadiness;
  isDefault: boolean;
}

export interface GenerationModelGroup {
  providerId: string;
  label: string;
  readiness: ModelReadiness;
  options: GenerationModelOption[];
}

export type ModelAvailability =
  | { selectable: true }
  | { selectable: false; reason: 'no-references' | 'needs-reference' | 'needs-setup' };

export interface BuildGenerationCatalogInput {
  surface: GenerationSurface;
  /** IMAGE_MODELS | VIDEO_MODELS (apps/web/src/media/models.ts). */
  staticModels: MediaModel[];
  /** useAIHubMixModels(...) result; empty keeps the static AIHubMix seeds. */
  aihubmixModels: MediaModel[];
  mediaProviders?: Record<string, MediaProviderCredentials> | undefined;
  /** Verified cloud ids for this surface. Unknown availability is not a usable catalogue. */
  cloudModelIds?: string[] | null | undefined;
  /** Legacy video-only callers. */
  cloudVideoIds?: string[] | null | undefined;
}

function readinessOf(
  provider: string,
  mediaProviders: Record<string, MediaProviderCredentials> | undefined,
): ModelReadiness | null {
  if (provider === 'tokentosea') return 'cloud';
  const known = findProvider(provider as Parameters<typeof findProvider>[0]);
  if (!known?.integrated) return null;
  return isMediaProviderPickerReady(known.id, mediaProviders) ? 'ready' : null;
}

/**
 * Catalog groups for one surface. Order: `ready` groups (catalog order), then the cloud group, then the
 * providers that need setup (shown as one collapsed section by the picker).
 */
export function buildGenerationCatalog(input: BuildGenerationCatalogInput): GenerationModelGroup[] {
  const { surface, mediaProviders } = input;
  const cloudModelIds = input.cloudModelIds ?? (surface === 'video' ? input.cloudVideoIds : null);
  const models = mergeAihubmixModels(input.staticModels, input.aihubmixModels);
  const options: GenerationModelOption[] = [];
  const byId = new Map<string, GenerationModelOption>();

  for (const model of models) {
    const group = variantGroupFor(model.id);
    const id = group ? group.baseId : model.id;
    const existing = byId.get(id);
    if (existing) {
      if (model.default) existing.isDefault = true;
      continue;
    }
    const provider = group ? group.provider : model.provider;
    const readiness = readinessOf(provider, mediaProviders);
    if (readiness === null) continue; // provider not integrated: never listed
    if (provider !== 'tokentosea' && !isMediaModelPickerReady(model.id, mediaProviders) && !model.id.startsWith('aihubmix-')) continue;
    if (
      provider === 'tokentosea' &&
      !cloudModelIds?.includes(model.id)
    ) {
      continue;
    }
    const caps = [...(model.caps ?? [])];
    const support = paramSupportFor({ id, provider, caps }, surface);
    if (!support.usable) continue;
    const option: GenerationModelOption = {
      id,
      label: group ? group.label : model.label,
      // A collapsed group's resolution is a param, so drop a trailing "· 1080p" from the member's hint.
      hint: group ? stripResolutionSuffix(model.hint, Object.keys(group.byResolution)) : model.hint,
      provider,
      providerLabel: findProvider(provider as Parameters<typeof findProvider>[0])?.label ?? provider,
      surface,
      caps,
      support,
      readiness,
      isDefault: Boolean(model.default),
    };
    byId.set(id, option);
    options.push(option);
  }

  const groups = new Map<string, GenerationModelGroup>();
  for (const option of options) {
    let group = groups.get(option.provider);
    if (!group) {
      group = { providerId: option.provider, label: option.providerLabel, readiness: option.readiness, options: [] };
      groups.set(option.provider, group);
    }
    group.options.push(option);
  }
  const ordered = [...groups.values()];
  const rank: Record<ModelReadiness, number> = { ready: 0, cloud: 1, 'needs-setup': 2 };
  return ordered
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank[a.group.readiness] - rank[b.group.readiness] || a.index - b.index)
    .map(({ group }) => group);
}

/**
 * Whether the option can run with `referenceCount` connected reference images: a model that ignores
 * references cannot take them, an image-to-X-only model needs one, and BYOK providers need credentials.
 */
export function modelAvailability(option: GenerationModelOption, referenceCount: number): ModelAvailability {
  if (referenceCount > 0 && option.support.maxReferences === 0) return { selectable: false, reason: 'no-references' };
  if (referenceCount === 0 && option.support.requiresReference) return { selectable: false, reason: 'needs-reference' };
  if (option.readiness === 'needs-setup') return { selectable: false, reason: 'needs-setup' };
  return { selectable: true };
}

/** Option by id; variant ids of a group resolve to the group's option. */
export function findOption(groups: GenerationModelGroup[], id: string): GenerationModelOption | null {
  if (!id) return null;
  const group = variantGroupFor(id);
  const target = group ? group.baseId : id;
  for (const entry of groups) {
    const option = entry.options.find((candidate) => candidate.id === target);
    if (option) return option;
  }
  return null;
}

export interface PickDefaultModelPrefs {
  /** The generator's stored model (null = auto-pick). */
  stored?: string | null | undefined;
  /** Project `metadata.imageModel` / `videoModel`. */
  projectDefault?: string | undefined;
  /** Last used model of this surface (preferences). */
  lastUsed?: string | undefined;
  referenceCount: number;
}

/**
 * Model that will run: stored (when present and selectable) → project default (when ready) → last used
 * (when ready) → first ready catalog default → first selectable ready option → null. Cloud models are
 * never auto-picked; only an explicit choice (`stored`) selects them.
 */
export function pickDefaultModel(groups: GenerationModelGroup[], prefs: PickDefaultModelPrefs): GenerationModelOption | null {
  const selectable = (option: GenerationModelOption | null): option is GenerationModelOption =>
    option !== null && modelAvailability(option, prefs.referenceCount).selectable;
  const readyAndSelectable = (option: GenerationModelOption | null): option is GenerationModelOption =>
    selectable(option) && option.readiness === 'ready';

  if (prefs.stored) {
    const stored = findOption(groups, prefs.stored);
    if (selectable(stored)) return stored;
  }
  if (prefs.projectDefault) {
    const projectDefault = findOption(groups, canonicalMediaModelId(prefs.projectDefault));
    if (readyAndSelectable(projectDefault)) return projectDefault;
  }
  if (prefs.lastUsed) {
    const lastUsed = findOption(groups, prefs.lastUsed);
    if (readyAndSelectable(lastUsed)) return lastUsed;
  }
  const ready = groups.filter((group) => group.readiness === 'ready').flatMap((group) => group.options);
  return ready.find((option) => option.isDefault && selectable(option)) ?? ready.find((option) => selectable(option)) ?? null;
}

function stripResolutionSuffix(hint: string, resolutions: readonly string[]): string {
  for (const resolution of resolutions) {
    const suffix = ` · ${resolution}`;
    if (hint.toLowerCase().endsWith(suffix.toLowerCase())) return hint.slice(0, hint.length - suffix.length);
  }
  return hint;
}
