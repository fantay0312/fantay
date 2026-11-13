// SPDX-License-Identifier: AGPL-3.0-only
// Last-used model and params per surface (spec 05 §4.10). Per-viewer convenience only: every storage access
// is wrapped, and a missing or broken entry reads as "no preference".
import {
  GENERATION_SURFACES,
  MEDIA_ASPECT_VALUES,
  type GenerationSurface,
  type GeneratorParams,
} from '@open-design/contracts';

export const GENERATION_PREFS_STORAGE_KEY = 'fantay:gen:last:v1';

export interface GenerationSurfacePrefs {
  model: string;
  params: GeneratorParams;
}
export type GenerationPrefs = Partial<Record<GenerationSurface, GenerationSurfacePrefs>>;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sanitizeParams(raw: unknown): GeneratorParams | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const aspect = MEDIA_ASPECT_VALUES.find((entry) => entry === value.aspect);
  const count = typeof value.count === 'number' && [1, 2, 3, 4].includes(value.count) ? (value.count as GeneratorParams['count']) : null;
  if (!aspect || count === null) return null;
  const params: GeneratorParams = { aspect, count };
  if (typeof value.length === 'number' && Number.isFinite(value.length) && value.length > 0) params.length = value.length;
  if (typeof value.quality === 'string' && value.quality) params.quality = value.quality;
  if (typeof value.resolution === 'string' && value.resolution) params.resolution = value.resolution;
  return params;
}

export function loadGenerationPrefs(): GenerationPrefs {
  const store = storage();
  if (!store) return {};
  let parsed: unknown;
  try {
    const raw = store.getItem(GENERATION_PREFS_STORAGE_KEY);
    if (!raw) return {};
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const prefs: GenerationPrefs = {};
  for (const surface of GENERATION_SURFACES) {
    const entry = (parsed as Record<string, unknown>)[surface];
    if (!entry || typeof entry !== 'object') continue;
    const model = (entry as Record<string, unknown>).model;
    const params = sanitizeParams((entry as Record<string, unknown>).params);
    if (typeof model === 'string' && model && params) prefs[surface] = { model, params };
  }
  return prefs;
}

export function lastUsedGeneration(surface: GenerationSurface): GenerationSurfacePrefs | null {
  return loadGenerationPrefs()[surface] ?? null;
}

export function saveGenerationPrefs(surface: GenerationSurface, value: GenerationSurfacePrefs): void {
  const store = storage();
  if (!store) return;
  try {
    const next: GenerationPrefs = { ...loadGenerationPrefs(), [surface]: { model: value.model, params: { ...value.params } } };
    store.setItem(GENERATION_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota, private mode or blocked storage: the preference is a convenience.
  }
}
