// SPDX-License-Identifier: AGPL-3.0-only
// Writes the chosen 社媒设计 canvas size into the Home brief (amendment C4) without editing HomeView: the
// page composer persists its prompt under HOME_COMPOSER_PROMPT_DRAFT_KEY on every change, and HomeView's own
// `seedHomeComposerPrompt` replaces the live prompt (the same path Community's "use prompt" takes). HomeView
// is imported lazily: it renders HomeHero, which renders the Fantay type row, so a static import would close
// an import cycle.
import type { Dict } from '../../i18n/types';
import { HOME_COMPOSER_INPUT_SELECTOR, focusHomeComposer } from './focus-home-composer';
import { mergeBriefSizeLine, socialBriefSizeLine, type SocialPlatformPreset } from './social-presets';

/** Must equal HOME_COMPOSER_PROMPT_KEY in components/HomeView.tsx (pinned by tests/fantay/home/social-chip.test.ts). */
export const HOME_COMPOSER_PROMPT_DRAFT_KEY = 'open-design:home-composer:prompt';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/** The page composer's current brief: its persisted draft, else (storage blocked) the editor's text. */
export function readHomeComposerBrief(): string {
  try {
    if (typeof window !== 'undefined') return window.localStorage.getItem(HOME_COMPOSER_PROMPT_DRAFT_KEY) ?? '';
  } catch {
    // Storage blocked: fall through to the editor's own text.
  }
  if (typeof document === 'undefined') return '';
  const input = document.querySelector<HTMLElement>(HOME_COMPOSER_INPUT_SELECTOR);
  return input?.innerText ?? input?.textContent ?? '';
}

/** Replaces the page composer's brief through HomeView's seed path. */
export async function seedHomeComposerBrief(prompt: string): Promise<void> {
  const { seedHomeComposerPrompt } = await import('../../components/HomeView');
  seedHomeComposerPrompt(prompt, 'page');
}

/** Puts `画布尺寸：W×H（平台）` first in the brief (replacing an earlier size line), then focuses the composer. */
export async function applySocialBriefSize(t: Translate, preset: SocialPlatformPreset): Promise<string> {
  const line = socialBriefSizeLine(t, preset);
  const next = mergeBriefSizeLine(readHomeComposerBrief(), line, t('fantayHome.social.briefSize'));
  await seedHomeComposerBrief(next);
  focusHomeComposer();
  return next;
}
