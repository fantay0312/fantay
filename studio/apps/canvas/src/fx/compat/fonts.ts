// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/editor/fonts` (06 §3.4): the font catalogue and loading the
 * vendored font picker, font settings and typography section use, for a browser-only editor.
 *
 * Online fonts are on by default; Google Fonts stays off in the browser (as upstream does),
 * and web font downloads only reach the font CDNs below, capped at 8 MiB per response.
 */
import { useLocalStorage } from '@vueuse/core';
import { watch } from 'vue';

import {
  DEFAULT_WEB_FONT_PROVIDER_SETTINGS,
  WEB_FONT_PROVIDER_IDS,
  fontManager,
  type FontFamilyOption,
  type LocalFontAccessState,
  type WebFontProviderId,
} from '../engine/op';
import type { DownloadedFontCacheSummary } from './fonts-cache';

export type FontProviderSettings = Record<WebFontProviderId, boolean>;

export const ONLINE_FONTS_STORAGE_KEY = 'fantay:design:online-fonts';
export const FONT_PROVIDERS_STORAGE_KEY = 'fantay:design:font-providers';
const MAX_WEB_FONT_RESPONSE_BYTES = 8 * 1024 * 1024;
const WEB_FONT_HOSTS = new Set([
  'api.fontsource.org',
  'cdn.jsdelivr.net',
  'fonts.bunny.net',
  'api.fontshare.com',
  'cdn.fontshare.com',
]);

export const onlineFontsEnabled = useLocalStorage(ONLINE_FONTS_STORAGE_KEY, true);
export const fontProviderSettings = useLocalStorage<FontProviderSettings>(FONT_PROVIDERS_STORAGE_KEY, {
  ...DEFAULT_WEB_FONT_PROVIDER_SETTINGS,
});

/** Providers that may download fonts right now (Google Fonts is never used from the browser). */
export function enabledFontProviders(enabled: boolean, settings: FontProviderSettings): Partial<Record<WebFontProviderId, boolean>> {
  if (!enabled) return {};
  return Object.fromEntries(WEB_FONT_PROVIDER_IDS.map((provider) => [provider, !!settings[provider] && provider !== 'google']));
}

watch(
  [onlineFontsEnabled, fontProviderSettings],
  () => fontManager.setOnlineFontProviders(enabledFontProviders(onlineFontsEnabled.value, fontProviderSettings.value)),
  { deep: true, immediate: true },
);

// Captured once: the SDK installs this fetcher as the global `fetch` while it resolves web fonts,
// so calling the global from inside it would recurse.
const nativeFetch: typeof fetch | null = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;

async function boundedWebFontFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!nativeFetch) throw new Error('fetch is unavailable');
  const url = new URL(input, globalThis.location?.href);
  const sameOrigin = globalThis.location !== undefined && url.origin === globalThis.location.origin;
  if (!sameOrigin && (url.protocol !== 'https:' || !WEB_FONT_HOSTS.has(url.hostname))) {
    throw new Error(`Unsupported web font host: ${url.hostname}`);
  }
  const response = await nativeFetch(url, init);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_WEB_FONT_RESPONSE_BYTES) throw new Error('Web font response exceeds the size limit');
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

if (typeof navigator !== 'undefined') fontManager.setFallbackUserAgent(navigator.userAgent);
fontManager.setWebFontFetch(boundedWebFontFetch);

export function loadFont(family: string, style = 'Regular', characters = '', signal?: AbortSignal): Promise<ArrayBuffer | null> {
  return fontManager.loadFont(family, style, characters, signal);
}

export function listFamilies(): Promise<FontFamilyOption[]> {
  return fontManager.listFamilyOptions();
}

export function localFontAccessState(): LocalFontAccessState {
  return fontManager.localAccessState();
}

export async function requestLocalFontAccess(): Promise<FontFamilyOption[]> {
  await fontManager.requestLocalFontAccess();
  return listFamilies();
}

export function predownloadFallbackFonts(): Promise<unknown> {
  return fontManager.ensureFallbackPack();
}

export async function downloadedFontCacheSummary(): Promise<DownloadedFontCacheSummary> {
  return { count: 0, byteLength: 0, updatedAt: null };
}

export async function clearDownloadedFontCache(): Promise<void> {}
