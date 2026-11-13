import type { MediaProviderCredentials } from '../types';
import {
  findMediaModel,
  findProvider,
  type MediaProviderId,
} from './models';

export function isMediaProviderPickerReady(
  providerId: MediaProviderId,
  mediaProviders?: Record<string, MediaProviderCredentials>,
): boolean {
  const provider = findProvider(providerId);
  if (!provider?.integrated) return false;
  const entry = mediaProviders?.[provider.id];
  if (providerId === 'comfyui') return Boolean(entry?.model?.trim());
  if (['midjourney', 'suno', 'udio'].includes(providerId) && !entry?.baseUrl?.trim()) return false;
  if (provider.credentialsRequired === false) return true;
  if (provider.id === 'openai' && isOpenAIOAuthOnlyEntry(entry)) return false;
  return Boolean(entry?.apiKey?.trim() || entry?.apiKeyConfigured || entry?.apiKeyTail?.trim());
}

export function isMediaModelPickerReady(
  modelId: string,
  mediaProviders?: Record<string, MediaProviderCredentials>,
): boolean {
  const model = findMediaModel(modelId);
  if (!model) return false;
  if (model.provider === 'google') {
    let vertex = false;
    try { vertex = /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(new URL(mediaProviders?.google?.baseUrl || '').hostname); } catch { /* Default is the Gemini Developer API. */ }
    if (/^(veo-|lyria-2$)/.test(model.id) && !vertex) return false;
    if (/^(gemini-omni-|lyria-3)/.test(model.id) && vertex) return false;
  }
  return isMediaProviderPickerReady(model.provider, mediaProviders);
}

function isOpenAIOAuthOnlyEntry(entry: MediaProviderCredentials | null | undefined): boolean {
  const source = entry?.source?.trim();
  return (source === 'oauth-codex' || source === 'oauth-hermes')
    && !entry?.apiKey?.trim()
    && !entry?.baseUrl?.trim()
    && !entry?.model?.trim()
    && !entry?.apiKeyTail?.trim();
}
