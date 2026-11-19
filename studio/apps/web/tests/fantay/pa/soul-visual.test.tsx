// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Soul visual foundation (UI spec §8, §10.2): theme attributes per theme and the stage-1 frame rule, the theme token
// blocks and their contrast, portraits and the monogram fallback, roleplay text and narration detection, the tag
// input and stepper rules, the bubble radius table and the typing bubble.
import '../helpers/radix-jsdom';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import postcss from 'postcss';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaCharacterView, PaChatTheme, PersonalAgent } from '@open-design/contracts';
import { PA_CHAT_THEMES, PA_THEME_META, PA_THEME_SURFACES, guardAccent, resolveAppearance } from '@open-design/contracts/soul';

import { soulFrameOf, soulThemeAttrs, soulThemeName, soulThemeStyle } from '../../../src/fantay/pa/soul/soul-theme';
import { SoulThemeScope } from '../../../src/fantay/pa/soul/SoulThemeScope';
import { SoulAgentPortrait, SoulPortrait, SoulPortraitCover } from '../../../src/fantay/pa/soul/SoulPortrait';
import { SoulRoleplayText, isNarrationOnly } from '../../../src/fantay/pa/soul/SoulRoleplayText';
import { SoulStage } from '../../../src/fantay/pa/soul/SoulStage';
import {
  SoulBubbleFrame,
  SoulDeltaRow,
  SoulPreviewChat,
  SoulStateBar,
  SoulStepper,
  SoulStoryFrame,
  SoulTag,
  SoulTagInput,
  SoulThemeSwatch,
  SoulTypingBubble,
  SoulVoiceBar,
} from '../../../src/fantay/pa/soul/SoulPrimitives';

const WEB_ROOT = resolve(__dirname, '../../..');
const PA_CSS = readFileSync(resolve(WEB_ROOT, 'src/fantay/styles/pa.css'), 'utf8');
const TOKENS_CSS = readFileSync(resolve(WEB_ROOT, '../../packages/fantay-tokens/tokens.css'), 'utf8');
const PRIMITIVES_CSS = readFileSync(resolve(WEB_ROOT, 'src/fantay/pa/soul/SoulPrimitives.module.css'), 'utf8');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ── theme attributes ─────────────────────────────────────────────────────────────────────── */

describe('soul-theme', () => {
  it('maps every theme to its data attributes with the theme defaults', () => {
    for (const theme of PA_CHAT_THEMES) {
      const meta = PA_THEME_META[theme];
      expect(soulThemeAttrs(resolveAppearance({ theme }))).toEqual({
        'data-pa-skin': theme,
        'data-pa-shape': 'soft',
        'data-pa-font': meta.font,
        'data-pa-scale': 'md',
        'data-pa-pattern': meta.pattern,
        'data-pa-frame': meta.avatarFrame,
        'data-pa-layout': 'bubble',
      });
      expect(soulThemeStyle(resolveAppearance({ theme }))).toEqual({});
    }
  });

  it('draws the journal layout, the polaroid frame and a guarded accent, and keeps explicit choices', () => {
    const appearance = resolveAppearance({ theme: 'rain' }, { avatarFrame: 'polaroid', layout: 'journal', accent: '#123456', shape: 'round', font: 'mono', scale: 'lg', pattern: 'dots' });
    expect(soulFrameOf(appearance)).toBe('polaroid');
    const attrs = soulThemeAttrs(appearance);
    expect(attrs).toEqual({
      'data-pa-skin': 'rain',
      'data-pa-frame': 'polaroid',
      'data-pa-shape': 'round',
      'data-pa-font': 'mono',
      'data-pa-scale': 'lg',
      'data-pa-pattern': 'dots',
      'data-pa-layout': 'journal',
      'data-pa-accent': '',
    });
    const guard = guardAccent('rain', '#123456');
    if (!guard?.ok) throw new Error('the guard should accept #123456 on rain');
    expect(soulThemeStyle(appearance)).toEqual({
      '--pa-accent-l': guard.light.accent,
      '--pa-accent-ink-l': guard.light.accentInk,
      '--pa-link-l': guard.light.link,
      '--pa-accent-d': guard.dark.accent,
      '--pa-accent-ink-d': guard.dark.accentInk,
      '--pa-link-d': guard.dark.link,
    });
    expect(soulFrameOf(resolveAppearance({ theme: 'sakura' }, { avatarFrame: 'circle' }))).toBe('circle');
    expect(soulFrameOf(resolveAppearance({ theme: 'sakura' }))).toBe('squircle');
  });

  it('keeps the style object stable per theme and colour, and draws no accent for an invalid one', () => {
    const a = soulThemeStyle(resolveAppearance({ theme: 'sakura' }, { accent: '#ffff00' }));
    const b = soulThemeStyle(resolveAppearance({ theme: 'sakura', layout: 'journal' }, { accent: '#ffff00' }));
    expect(a).toBe(b);
    expect(soulThemeStyle(resolveAppearance({ theme: 'clean' }, { accent: '#ffff00' }))).not.toBe(a);
    // Yellow cannot be read on sakura's light paper, so what is drawn is the guard's adjusted colour.
    const guard = guardAccent('sakura', '#ffff00');
    expect(guard?.ok && guard.adjusted).toBe(true);
    const invalid = resolveAppearance({ theme: 'rain' }, { accent: '#12345' as string });
    expect(soulThemeStyle(invalid)).toEqual({});
    expect(Object.keys(soulThemeAttrs(invalid))).not.toContain('data-pa-accent');
  });

  it('names themes in both locales', () => {
    expect(soulThemeName('sakura', 'zh')).toBe('樱花手帐');
    expect(soulThemeName('deepsea', 'en')).toBe('Deep sea');
  });

  it('renders a themed island with the attributes and the children', () => {
    render(
      <SoulThemeScope appearance={resolveAppearance({ theme: 'archive' })} data-testid="scope">
        <span>inside</span>
      </SoulThemeScope>,
    );
    const scope = screen.getByTestId('scope');
    expect(scope).toHaveAttribute('data-pa-skin', 'archive');
    expect(scope).toHaveAttribute('data-pa-pattern', 'ruled');
    expect(scope).toHaveAttribute('data-pa-frame', 'squircle');
    expect(scope).toHaveAttribute('data-pa-font', 'serif');
    expect(scope).toHaveAttribute('data-pa-layout', 'bubble');
    expect(scope).not.toHaveAttribute('data-pa-accent');
    expect(scope).toHaveTextContent('inside');
  });

  it('carries the journal, the polaroid and the guarded accent on a themed island', () => {
    render(
      <SoulThemeScope appearance={resolveAppearance({ theme: 'ink' }, { layout: 'journal', avatarFrame: 'polaroid', accent: '#74c6a3' })} data-testid="scope">
        <span>inside</span>
      </SoulThemeScope>,
    );
    const scope = screen.getByTestId('scope');
    expect(scope).toHaveAttribute('data-pa-layout', 'journal');
    expect(scope).toHaveAttribute('data-pa-frame', 'polaroid');
    expect(scope).toHaveAttribute('data-pa-accent', '');
    const guard = guardAccent('ink', '#74c6a3');
    if (!guard?.ok) throw new Error('the guard should accept #74c6a3 on ink');
    expect(scope.style.getPropertyValue('--pa-accent-l')).toBe(guard.light.accent);
    expect(scope.style.getPropertyValue('--pa-link-d')).toBe(guard.dark.link);
  });
});

/* ── theme tokens in styles/pa.css ────────────────────────────────────────────────────────── */

const SKIN_COLORS = ['paper', 'ink', 'soft', 'meta', 'line', 'in-bg', 'in-ink', 'in-soft', 'in-border', 'out-bg', 'out-ink', 'out-soft',
  'out-border', 'accent', 'accent-ink', 'link', 'quote', 'card-bg', 'pattern-ink'] as const;

type Decls = Map<string, string>;

function declarationsBySelector(css: string): Map<string, Decls> {
  const out = new Map<string, Decls>();
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent?.type === 'atrule') return;
    for (const raw of rule.selectors) {
      const selector = raw.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
      const decls = out.get(selector) ?? new Map<string, string>();
      rule.walkDecls((decl) => {
        decls.set(decl.prop, decl.value);
      });
      out.set(selector, decls);
    }
  });
  return out;
}

const PA_RULES = declarationsBySelector(PA_CSS);
const TOKEN_RULES = declarationsBySelector(TOKENS_CSS);

function skinBlock(theme: PaChatTheme, mode: 'light' | 'dark'): Decls {
  const selector =
    theme === 'fantay'
      ? mode === 'light' ? "[data-pa-skin='fantay']" : "[data-theme='dark'] [data-pa-skin='fantay']"
      : mode === 'light' ? `[data-pa-skin='${theme}']` : `[data-theme='dark'] [data-pa-skin='${theme}']`;
  return PA_RULES.get(selector) ?? new Map();
}

function baseToken(name: string, mode: 'light' | 'dark'): string {
  const light = TOKEN_RULES.get(":root")?.get(name) ?? TOKEN_RULES.get("[data-theme='light']")?.get(name);
  return (mode === 'dark' ? TOKEN_RULES.get("[data-theme='dark']")?.get(name) : undefined) ?? light ?? '';
}

function colorOf(value: string, mode: 'light' | 'dark'): string {
  const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return ref ? baseToken(ref[1] ?? '', mode) : value.trim();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme tokens (styles/pa.css)', () => {
  it('declares every colour of every theme in light and dark, plus weight and display face', () => {
    for (const theme of PA_CHAT_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const block = skinBlock(theme, mode);
        expect(SKIN_COLORS.filter((name) => !block.has(`--pa-skin-${name}`)), `${theme} ${mode}`).toEqual([]);
        expect(block.has('--pa-skin-out-weight'), `${theme} ${mode} weight`).toBe(true);
      }
      expect(skinBlock(theme, 'light').has('--pa-skin-display-font'), theme).toBe(true);
    }
    expect(PA_RULES.get(':root')?.get('--pa-skin-paper')).toBe('var(--paper)');
    expect(PA_RULES.get(':root')?.get('--pa-skin-radius')).toBe('14px');
    expect(PA_RULES.get(":root")?.get('--pa-loop-typing')).toBe('1.2s');
    for (const name of ['--pa-soul-portrait-ring', '--pa-soul-tag-bg', '--pa-soul-bar-fill', '--pa-soul-chrome-hover', '--pa-soul-veil', '--pa-soul-pattern-dot']) {
      expect(PA_RULES.get("[data-theme='dark']")?.has(name), name).toBe(true);
    }
  });

  it('keeps body text at 4.5:1 or better in every theme and mode (quote bar 3:1)', () => {
    const pairs: Array<[string, string]> = [
      ['ink', 'paper'], ['soft', 'paper'], ['meta', 'paper'], ['in-ink', 'in-bg'], ['in-soft', 'in-bg'], ['out-ink', 'out-bg'],
      ['out-soft', 'out-bg'], ['accent', 'paper'], ['accent-ink', 'accent'], ['link', 'in-bg'], ['ink', 'card-bg'],
      ['soft', 'card-bg'], ['meta', 'card-bg'], ['accent', 'card-bg'],
    ];
    const failures: string[] = [];
    for (const theme of PA_CHAT_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const block = skinBlock(theme, mode);
        const color = (name: string) => colorOf(block.get(`--pa-skin-${name}`) ?? '', mode);
        for (const [fg, bg] of pairs) {
          const ratio = contrast(color(fg), color(bg));
          if (!(ratio >= 4.5)) failures.push(`${theme} ${mode} ${fg}/${bg} ${ratio.toFixed(2)}`);
        }
        const quote = contrast(color('quote'), color('in-bg'));
        if (!(quote >= 3)) failures.push(`${theme} ${mode} quote/in-bg ${quote.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("matches the engine's theme surfaces (the accent guard measures against them)", () => {
    for (const theme of PA_CHAT_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const block = skinBlock(theme, mode);
        const read = (name: string) => colorOf(block.get(`--pa-skin-${name}`) ?? '', mode).toLowerCase();
        const surfaces = PA_THEME_SURFACES[theme][mode];
        if (theme === 'fantay') continue; // base-token references; the engine holds their resolved values
        expect({ paper: read('paper'), cardBg: read('card-bg'), inBg: read('in-bg') }, `${theme} ${mode}`).toEqual(surfaces);
      }
    }
  });

  it('declares the stage 2 tokens and puts the accent block after every theme block', () => {
    const root = PA_RULES.get(':root');
    expect(root?.get('--pa-soul-polaroid-tilt')).toBe('-2deg');
    expect(root?.get('--pa-soul-stage-w')).toBe('220px');
    expect(root?.get('--pa-loop-caret')).toBe('1s');
    const order: string[] = [];
    postcss.parse(PA_CSS).walkRules((rule) => {
      if (rule.parent?.type !== 'atrule') order.push(rule.selector.replace(/\s+/g, ' ').replace(/"/g, "'"));
    });
    const lastSkin = order.reduce((at, selector, index) => (selector.includes('[data-pa-skin=') ? index : at), -1);
    const light = order.indexOf('[data-pa-accent]');
    const dark = order.indexOf("[data-theme='dark'] [data-pa-accent]");
    expect(lastSkin).toBeGreaterThan(0);
    expect(light).toBeGreaterThan(lastSkin);
    expect(dark).toBeGreaterThan(light);
    const lightDecls = PA_RULES.get('[data-pa-accent]');
    expect(lightDecls?.get('--pa-skin-accent')).toBe('var(--pa-accent-l)');
    expect(lightDecls?.get('--pa-skin-accent-ink')).toBe('var(--pa-accent-ink-l)');
    expect(lightDecls?.get('--pa-skin-link')).toBe('var(--pa-link-l)');
    expect(lightDecls?.get('--pa-skin-quote')).toBe('var(--pa-link-l)');
    expect(lightDecls?.get('--pa-skin-pattern-ink')).toBe('var(--pa-accent-l)');
    expect(PA_RULES.get("[data-theme='dark'] [data-pa-accent]")?.get('--pa-skin-link')).toBe('var(--pa-link-d)');
  });
});

/* ── portraits ────────────────────────────────────────────────────────────────────────────── */

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };
const agent = { ...stamp, id: 'moon', name: 'Xiaoyue', role: 'Friend', avatar: 'paper', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' } } as unknown as PersonalAgent;

function character(patch: Partial<PaCharacterView>): PaCharacterView {
  return { ...stamp, id: 'moon', nickname: '', portraitAssetId: null, appearance: {}, ...patch } as unknown as PaCharacterView;
}

describe('portraits', () => {
  it('draws a monogram on the theme paper when there is no image', () => {
    render(<SoulPortrait src={null} name="小月" size={40} theme="sakura" />);
    const portrait = screen.getByRole('img', { name: '小月' });
    expect(portrait).toHaveAttribute('data-monogram');
    expect(portrait).toHaveAttribute('data-frame', 'circle');
    expect(portrait.style.getPropertyValue('--pa-portrait')).toBe('40px');
    const glyph = portrait.querySelector('[data-pa-skin]');
    expect(glyph).toHaveAttribute('data-pa-skin', 'sakura');
    expect(glyph).toHaveTextContent('小');
  });

  it('upper-cases a Latin monogram, keeps astral code points whole and defaults to the fantay paper', () => {
    const { rerender } = render(<SoulPortrait src={null} name="  luna" size={28} />);
    expect(screen.getByRole('img', { name: 'luna' }).querySelector('[data-pa-skin="fantay"]')).toHaveTextContent('L');
    rerender(<SoulPortrait src={null} name="𠮷野" size={28} />);
    expect(screen.getByRole('img', { name: '𠮷野' })).toHaveTextContent('𠮷');
  });

  it('shows the image cover-fit, and falls back after a load error', () => {
    render(<SoulPortrait src="/a.webp" name="小月" size={36} frame="squircle" fallback={<span data-testid="fallback" />} />);
    const image = document.querySelector('img');
    expect(image).toHaveAttribute('src', '/a.webp');
    expect(screen.getByRole('img', { name: '小月' })).toHaveAttribute('data-frame', 'squircle');
    fireEvent.error(image!);
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('SoulAgentPortrait: asset URL and the character frame, else the paper face', () => {
    const { rerender } = render(
      <SoulAgentPortrait agent={agent} character={character({ portraitAssetId: 'data:image/png;base64,AAAA', appearance: { theme: 'sakura' } })} fantay={false} size={40} />,
    );
    expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(document.querySelector('[data-slot="soul-portrait"]')).toHaveAttribute('data-frame', 'squircle');
    rerender(<SoulAgentPortrait agent={agent} character={character({})} fantay={false} size={40} frame="scope" />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[data-slot="soul-portrait"]')).toHaveAttribute('data-fallback');
    expect(document.querySelector('[data-slot="pa-avatar"]')).toHaveAttribute('aria-label', 'Xiaoyue');
    rerender(<SoulAgentPortrait agent={agent} character={null} fantay size={40} />);
    expect(document.querySelector('[data-slot="pa-avatar"]')).toHaveAttribute('data-fantay');
  });

  it('SoulPortraitCover: monogram on the theme paper with its pattern, or the mascot still', () => {
    const { rerender } = render(<SoulPortraitCover src={null} name="周行简" theme="archive" />);
    const cover = screen.getByRole('img', { name: '周行简' });
    expect(cover).toHaveAttribute('data-pa-skin', 'archive');
    expect(cover).toHaveAttribute('data-pa-pattern', 'ruled');
    expect(cover).toHaveTextContent('周');
    rerender(<SoulPortraitCover src={null} name="Fantay" mascot />);
    expect(screen.getByTestId('fantay-mascot-still')).toBeInTheDocument();
  });

  it('draws a polaroid from 28 px, a squircle below, and marks the large sizes that may tilt', () => {
    const { rerender } = render(<SoulPortrait src="/a.webp" name="小月" size={48} frame="polaroid" />);
    const portrait = () => screen.getByRole('img', { name: '小月' });
    expect(portrait()).toHaveAttribute('data-frame', 'polaroid');
    expect(portrait()).toHaveAttribute('data-size-lg');
    rerender(<SoulPortrait src="/a.webp" name="小月" size={28} frame="polaroid" />);
    expect(portrait()).toHaveAttribute('data-frame', 'polaroid');
    expect(portrait()).not.toHaveAttribute('data-size-lg');
    expect(portrait()).not.toHaveAttribute('data-size-sm');
    rerender(<SoulPortrait src="/a.webp" name="小月" size={24} frame="polaroid" />);
    expect(portrait()).toHaveAttribute('data-frame', 'squircle');
    expect(portrait()).toHaveAttribute('data-size-sm');
    rerender(<SoulPortrait src="/a.webp" name="小月" size={24} frame="scope" />);
    expect(portrait()).toHaveAttribute('data-frame', 'scope');
    expect(portrait()).toHaveAttribute('data-size-sm');
    // The character's own frame reaches SoulAgentPortrait unchanged.
    rerender(<SoulAgentPortrait agent={agent} character={character({ portraitAssetId: 'data:image/png;base64,AAAA', appearance: { avatarFrame: 'polaroid' } })} fantay={false} size={36} />);
    expect(document.querySelector('[data-slot="soul-portrait"]')).toHaveAttribute('data-frame', 'polaroid');
  });

  it('SoulAgentPortrait with an emotion: the sprite, else the neutral sprite, else the portrait', () => {
    const sprites = { happy: 'data:image/png;base64,HAPPY', neutral: 'data:image/png;base64,CALM' };
    const portraitAssetId = 'data:image/png;base64,FACE';
    const src = () => document.querySelector('img:not([aria-hidden])')?.getAttribute('src');
    const { rerender } = render(<SoulAgentPortrait agent={agent} character={character({ portraitAssetId, sprites })} fantay={false} size={36} emotion="happy" />);
    expect(src()).toBe(sprites.happy);
    rerender(<SoulAgentPortrait agent={agent} character={character({ portraitAssetId, sprites })} fantay={false} size={36} emotion="sleepy" />);
    expect(src()).toBe(sprites.neutral);
    rerender(<SoulAgentPortrait agent={agent} character={character({ portraitAssetId, sprites: { shy: 'data:image/png;base64,SHY' } })} fantay={false} size={36} emotion="sad" />);
    expect(src()).toBe(portraitAssetId);
    rerender(<SoulAgentPortrait agent={agent} character={character({ portraitAssetId, sprites })} fantay={false} size={36} emotion={null} />);
    expect(src()).toBe(portraitAssetId);
    // A stage 1 character row has no sprites at all.
    rerender(<SoulAgentPortrait agent={agent} character={character({ portraitAssetId })} fantay={false} size={36} emotion="happy" />);
    expect(src()).toBe(portraitAssetId);
  });

  it('crossfades a change of image: the old one stays under the new one until it has loaded and faded in', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SoulPortrait src="/calm.webp" name="小月" size={36} />);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    rerender(<SoulPortrait src="/happy.webp" name="小月" size={36} />);
    const under = document.querySelector('img[aria-hidden]');
    const next = document.querySelector('img:not([aria-hidden])')!;
    expect(under).toHaveAttribute('src', '/calm.webp');
    expect(under).not.toHaveAttribute('data-out');
    expect(next).toHaveAttribute('src', '/happy.webp');
    expect(next).toHaveAttribute('data-swap', 'wait');
    fireEvent.load(next);
    expect(next).toHaveAttribute('data-swap', 'in');
    expect(document.querySelector('img[aria-hidden]')).toHaveAttribute('data-out');
    // The fade's end (jsdom never reports animationend to React, so the settle timer ends it here).
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('img')).not.toHaveAttribute('data-swap');
    // From no image to an image there is nothing to fade from.
    rerender(<SoulPortrait src={null} name="小月" size={36} />);
    rerender(<SoulPortrait src="/calm.webp" name="小月" size={36} />);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('img')).not.toHaveAttribute('data-swap');
  });
});

/* ── roleplay text ────────────────────────────────────────────────────────────────────────── */

describe('roleplay text', () => {
  it('detects narration-only text', () => {
    expect(isNarrationOnly('*把杯子往你这边推了推*')).toBe(true);
    expect(isNarrationOnly('  （笑）  *点头*\n')).toBe(true);
    expect(isNarrationOnly('*点头* 好。')).toBe(false);
    expect(isNarrationOnly('「好」')).toBe(false);
    expect(isNarrationOnly('   ')).toBe(false);
    expect(isNarrationOnly('**bold**')).toBe(false);
  });

  it('styles actions without asterisks, keeps brackets and speech text, and splits paragraphs', () => {
    const { container } = render(<SoulRoleplayText text={'*推了推杯子* 「先坐吧」（笑）\n\n第二段'} side="in" markupLabel="卡片自带的标记" />);
    const actions = [...container.querySelectorAll('[data-kind="action"]')].map((node) => node.textContent);
    expect(actions).toEqual(['推了推杯子', '（笑）']);
    expect(container.querySelector('[data-kind="speech"]')).toHaveTextContent('「先坐吧」');
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.textContent).not.toContain('*');
    expect(container.querySelector('[data-side="in"]')).not.toBeNull();
  });

  it('renders markdown for agent text and never for owner text', () => {
    const { container, rerender } = render(<SoulRoleplayText text={'- 一\n- 二（小声）'} side="in" markupLabel="x" />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('em')).toHaveTextContent('（小声）');
    rerender(<SoulRoleplayText text={'- 一 **粗**'} side="out" markdown={false} markupLabel="x" />);
    expect(container.querySelector('li')).toBeNull();
    expect(container.textContent).toBe('- 一 **粗**');
  });

  it('folds imported card markup into one labelled disclosure', () => {
    render(<SoulRoleplayText text={'你好\n<status>\nHP 10\n</status>\n再见'} side="in" markupLabel="卡片自带的标记" />);
    expect(screen.getByRole('button', { name: /卡片自带的标记/ })).toHaveAttribute('aria-expanded', 'false');
  });
});

/* ── tag input ────────────────────────────────────────────────────────────────────────────── */

function TagHarness({ initial = [], ...props }: { initial?: string[]; max?: number; maxLength?: number; validate?(tag: string): boolean }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <>
      <SoulTagInput value={value} onChange={setValue} aria-label="keys" placeholder="add" {...props} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

const valueOf = () => JSON.parse(screen.getByTestId('value').textContent ?? '[]') as string[];

describe('SoulTagInput', () => {
  it('adds on Enter and on ASCII or full-width commas, trims and ignores duplicates', () => {
    render(<TagHarness />);
    const input = screen.getByRole('textbox', { name: 'keys' });
    fireEvent.change(input, { target: { value: ' 钟楼 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: '怀表,旧档室，钟楼，' } });
    expect(valueOf()).toEqual(['钟楼', '怀表', '旧档室']);
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '怀表' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(valueOf()).toEqual(['钟楼', '怀表', '旧档室']);
  });

  it('ignores Enter while an IME composes and keeps the draft', () => {
    render(<TagHarness />);
    const input = screen.getByRole('textbox', { name: 'keys' });
    fireEvent.change(input, { target: { value: 'zhong' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(valueOf()).toEqual([]);
    expect(input).toHaveValue('zhong');
  });

  it('removes the last tag with Backspace on an empty input and any tag with its remove button', () => {
    render(<TagHarness initial={['a', 'b', 'c']} />);
    const input = screen.getByRole('textbox', { name: 'keys' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(valueOf()).toEqual(['a', 'b']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(valueOf()).toEqual(['b']);
  });

  it('enforces max and maxLength, adds a pending draft on blur and marks invalid tags', () => {
    render(<TagHarness initial={['ok']} max={2} maxLength={4} validate={(tag) => !tag.includes('!')} />);
    const input = screen.getByRole('textbox', { name: 'keys' });
    expect(input).toHaveAttribute('maxlength', '4');
    fireEvent.change(input, { target: { value: 'bad!x, more' } });
    expect(valueOf()).toEqual(['ok', 'bad!']);
    expect(input).toHaveAttribute('readonly');
    fireEvent.blur(input);
    expect(valueOf()).toEqual(['ok', 'bad!']);
    expect(screen.getByRole('button', { name: 'bad!' })).toHaveAttribute('data-invalid');
    expect(screen.getByRole('button', { name: 'ok' })).not.toHaveAttribute('data-invalid');
  });

  it('adds the draft on blur when there is room', () => {
    render(<TagHarness />);
    const input = screen.getByRole('textbox', { name: 'keys' });
    fireEvent.change(input, { target: { value: '雨夜' } });
    fireEvent.blur(input);
    expect(valueOf()).toEqual(['雨夜']);
  });
});

/* ── stepper ──────────────────────────────────────────────────────────────────────────────── */

describe('SoulStepper', () => {
  function Stepper({ initial, ...props }: { initial: number; min: number; max: number; step?: number; format?(value: number): string }) {
    const [value, setValue] = useState(initial);
    return <SoulStepper value={value} onChange={setValue} aria-label="depth" {...props} />;
  }

  it('clamps to the bounds and disables the button at a bound', () => {
    render(<Stepper initial={7} min={0} max={8} />);
    const value = screen.getByRole('spinbutton', { name: 'depth' });
    const plus = screen.getByRole('button', { name: 'depth +' });
    fireEvent.click(plus);
    expect(value).toHaveTextContent('8');
    expect(plus).toBeDisabled();
    fireEvent.keyDown(value, { key: 'ArrowUp' });
    expect(value).toHaveTextContent('8');
    fireEvent.keyDown(value, { key: 'Home' });
    expect(value).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'depth −' })).toBeDisabled();
    fireEvent.keyDown(value, { key: 'PageUp' });
    expect(value).toHaveTextContent('8');
  });

  it('pulls an out-of-range value back inside and keeps decimal steps exact', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SoulStepper value={12} onChange={onChange} min={0} max={8} aria-label="depth" />);
    fireEvent.click(screen.getByRole('button', { name: 'depth −' }));
    expect(onChange).toHaveBeenLastCalledWith(8);
    rerender(<SoulStepper value={0.2} onChange={onChange} min={0} max={1} step={0.1} format={(v) => `${Math.round(v * 100)}%`} aria-label="depth" />);
    fireEvent.click(screen.getByRole('button', { name: 'depth +' }));
    expect(onChange).toHaveBeenLastCalledWith(0.3);
    expect(screen.getByRole('spinbutton', { name: 'depth' })).toHaveAttribute('aria-valuetext', '20%');
  });
});

/* ── bubbles and frames ───────────────────────────────────────────────────────────────────── */

type Corner = 'ss' | 'se' | 'ee' | 'es';
const CORNER_PROPS: Record<string, Corner> = {
  'border-start-start-radius': 'ss',
  'border-start-end-radius': 'se',
  'border-end-end-radius': 'ee',
  'border-end-start-radius': 'es',
};

/** The resolved corner tokens for one side and position, from the bubble rules of SoulPrimitives.module.css. */
function bubbleCorners(side: 'in' | 'out', position: string): Record<Corner, string> {
  const corners = {} as Record<Corner, string>;
  postcss.parse(PRIMITIVES_CSS).walkRules((rule) => {
    if (rule.parent?.type === 'atrule') return;
    const applies = rule.selectors.some((selector) => {
      if (!/^\.bubble(\[[^\]]+\])*$/.test(selector.trim())) return false;
      const sideAttr = /\[data-side='(\w+)'\]/.exec(selector)?.[1];
      const positionAttr = /\[data-position='(\w+)'\]/.exec(selector)?.[1];
      const others = selector.replace(/\[data-(?:side|position)='\w+'\]/g, '').replace('.bubble', '');
      return others === '' && (!sideAttr || sideAttr === side) && (!positionAttr || positionAttr === position);
    });
    if (!applies) return;
    rule.walkDecls((decl) => {
      const corner = CORNER_PROPS[decl.prop];
      if (corner) corners[corner] = decl.value.replace('var(--pa-skin-radius-join)', 'J').replace('var(--pa-skin-radius-tail)', 'T').replace('var(--pa-skin-radius)', 'R');
    });
  });
  return corners;
}

describe('bubble frame', () => {
  it('marks side, position and state on the bubble', () => {
    render(
      <SoulBubbleFrame side="out" position="last" pending hidden editing entering messageId="m1">
        hi
      </SoulBubbleFrame>,
    );
    const bubble = screen.getByTestId('pa-soul-bubble');
    expect(bubble).toHaveAttribute('data-side', 'out');
    expect(bubble).toHaveAttribute('data-position', 'last');
    expect(bubble).toHaveAttribute('data-message-id', 'm1');
    for (const state of ['data-pending', 'data-hidden', 'data-editing', 'data-enter']) expect(bubble).toHaveAttribute(state);
    expect(bubble).not.toHaveAttribute('data-dimmed');
    expect(bubble).not.toHaveAttribute('data-rich');
  });

  it('rounds the corners by position (incoming; outgoing mirrors)', () => {
    // top-start, top-end, bottom-end, bottom-start
    const incoming: Record<string, [string, string, string, string]> = {
      single: ['R', 'R', 'R', 'T'],
      first: ['R', 'R', 'R', 'J'],
      middle: ['J', 'R', 'R', 'J'],
      last: ['J', 'R', 'R', 'T'],
    };
    for (const [position, [ts, te, be, bs]] of Object.entries(incoming)) {
      expect(bubbleCorners('in', position), `in ${position}`).toEqual({ ss: ts, se: te, ee: be, es: bs });
      expect(bubbleCorners('out', position), `out ${position}`).toEqual({ ss: te, se: ts, ee: bs, es: be });
    }
  });

  it('frames a story item as a captioned note', () => {
    render(
      <SoulStoryFrame kind="roll" caption="故事 · 掷骰" ariaLabel="故事，掷骰，结果 14" entering>
        <span>14</span>
      </SoulStoryFrame>,
    );
    const card = screen.getByRole('note', { name: '故事，掷骰，结果 14' });
    expect(card).toHaveAttribute('data-testid', 'pa-soul-story');
    expect(card).toHaveAttribute('data-kind', 'roll');
    expect(card).toHaveTextContent('故事 · 掷骰');
  });

  it('opens the delta line as one button when it has an action', () => {
    const onClick = vi.fn();
    render(<SoulDeltaRow onClick={onClick}>生命 −2 · 获得 铜钥匙</SoulDeltaRow>);
    fireEvent.click(screen.getByRole('button', { name: '生命 −2 · 获得 铜钥匙' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByTestId('pa-soul-delta')).toBeInTheDocument();
  });

  it('shows the typing bubble as a status and pins its trailing action after 8 s', () => {
    vi.useFakeTimers();
    render(<SoulTypingBubble portrait={<span />} label="小月 正在输入" trailing={<span data-testid="stop">停止</span>} />);
    const status = screen.getByRole('status', { name: '小月 正在输入' });
    expect(status).toHaveAttribute('data-testid', 'pa-soul-typing');
    const slot = screen.getByTestId('stop').parentElement!;
    expect(slot).not.toHaveAttribute('data-pinned');
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(slot).toHaveAttribute('data-pinned');
  });

  it('clamps the state bar fill to 0–1', () => {
    const { container, rerender } = render(<SoulStateBar value={8} min={0} max={10} />);
    const bar = container.querySelector<HTMLElement>('[data-slot="soul-state-bar"]')!;
    expect(bar.style.getPropertyValue('--pa-bar')).toBe('0.8');
    rerender(<SoulStateBar value={14} min={0} max={10} size="md" />);
    expect(bar.style.getPropertyValue('--pa-bar')).toBe('1');
    expect(bar).toHaveAttribute('data-size', 'md');
  });

  it('paints tags, swatches and the preview from their props only', () => {
    render(
      <>
        <SoulTag tone="solid" skin>成功</SoulTag>
        <SoulThemeSwatch theme="deepsea" />
        <SoulPreviewChat
          portrait={<span data-testid="preview-portrait" />}
          labels={{ date: '今天 21:06', incoming: '你回来了。', narration: '把杯子推了推', outgoing: '先听我说吧。', rollCaption: '故事 · 掷骰', rollLabel: '翻墙检定', delta: '生命 −2' }}
        />
      </>,
    );
    expect(screen.getByText('成功')).toHaveAttribute('data-tone', 'solid');
    expect(screen.getByText('成功')).toHaveAttribute('data-skin');
    const swatch = document.querySelector('[data-slot="soul-theme-swatch"]');
    expect(swatch).toHaveAttribute('data-pa-skin', 'deepsea');
    expect(swatch).toHaveAttribute('data-pa-pattern', 'grid');
    const preview = document.querySelector('[data-slot="soul-preview-chat"]')!;
    expect(preview.querySelectorAll('[data-testid="pa-soul-bubble"]')).toHaveLength(2);
    expect(preview).toHaveTextContent('翻墙检定');
    expect(preview).toHaveTextContent('d20+2');
    expect(preview).toHaveTextContent('生命 −2');
    expect(screen.getByTestId('preview-portrait')).toBeInTheDocument();
    expect(preview.querySelector('[data-slot="soul-preview-head"]')).toBeNull();
  });

  it('gives the preview the journal head line when a name is given', () => {
    render(
      <SoulThemeScope appearance={resolveAppearance({ theme: 'sakura' }, { layout: 'journal', avatarFrame: 'polaroid' })} data-testid="scope">
        <SoulPreviewChat
          portrait={<span />}
          labels={{ date: '今天', incoming: '你回来了。', narration: '推了推', outgoing: '嗯。', rollCaption: '故事 · 掷骰', rollLabel: '检定', delta: '生命 −2', name: '小月', time: '21:06' }}
        />
      </SoulThemeScope>,
    );
    expect(screen.getByTestId('scope')).toHaveAttribute('data-pa-layout', 'journal');
    expect(screen.getByText('小月')).toBeInTheDocument();
    expect(screen.getByText('21:06')).toBeInTheDocument();
  });
});

/* ── live text (stage 2) ──────────────────────────────────────────────────────────────────── */

describe('live text in the typing bubble', () => {
  const part = (text: string) => <span data-slot="soul-text">{text}</span>;

  it('replaces the dots with the live bubbles, narration unboxed, the caret on the last part', () => {
    render(
      <SoulTypingBubble
        portrait={<span />}
        label="小月 正在回复"
        parts={[part('好呀'), part('*把伞递过来*'), part('一起走吧'), part('路上小心')]}
        narration={[false, true, false, false]}
        trailing={<span data-testid="stop">停止</span>}
      />,
    );
    const status = screen.getByRole('status', { name: '小月 正在回复' });
    expect(status).toHaveAttribute('data-testid', 'pa-soul-typing');
    const live = screen.getByTestId('pa-soul-live');
    expect(live).toHaveAttribute('data-tone', 'live');
    expect(live).toHaveAttribute('aria-live', 'off');
    expect(status.querySelector('[data-slot="soul-typing-dots"]')).toBeNull();
    const bubbles = within(live).getAllByTestId('pa-soul-bubble');
    expect(bubbles.map((bubble) => bubble.getAttribute('data-position'))).toEqual(['single', 'first', 'last']);
    expect(bubbles.every((bubble) => bubble.getAttribute('data-side') === 'in' && !bubble.hasAttribute('data-enter'))).toBe(true);
    expect(within(live).getAllByTestId('pa-soul-narration')).toHaveLength(1);
    const carets = live.querySelectorAll('[data-caret]');
    expect(carets).toHaveLength(1);
    expect(carets[0]).toHaveTextContent('路上小心');
    // The trailing action stays beside the last bubble.
    expect(screen.getByTestId('stop').closest('[data-slot="soul-live-part"]')).toHaveTextContent('路上小心');
  });

  it('keeps the stage 1 text prop as one plain bubble with a caret, and shows dots without text', () => {
    const { rerender } = render(<SoulTypingBubble portrait={<span />} label="x" text={'第一行\n第二行'} />);
    const bubble = within(screen.getByTestId('pa-soul-live')).getByTestId('pa-soul-bubble');
    expect(bubble).toHaveAttribute('data-position', 'single');
    expect(bubble).toHaveTextContent('第一行');
    expect(bubble.querySelector('[data-slot="soul-live-caret"]')).not.toBeNull();
    rerender(<SoulTypingBubble portrait={<span />} label="x" parts={[]} />);
    expect(screen.queryByTestId('pa-soul-live')).toBeNull();
    expect(screen.getByRole('status').querySelector('[data-slot="soul-typing-dots"]')).not.toBeNull();
  });

  it('draws a stopped or failed draft dimmed, without caret or dots, with its footer', () => {
    for (const tone of ['stopped', 'failed'] as const) {
      const { unmount } = render(
        <SoulTypingBubble portrait={<span />} label="x" parts={[part('说到一半')]} tone={tone} footer={<span data-testid="footer">没有保存</span>} />,
      );
      const live = screen.getByTestId('pa-soul-live');
      expect(live).toHaveAttribute('data-tone', tone);
      expect(screen.getByTestId('pa-soul-typing')).toHaveAttribute('data-tone', tone);
      expect(live.querySelector('[data-caret]')).toBeNull();
      expect(screen.getByTestId('footer')).toBeInTheDocument();
      expect(live).not.toContainElement(screen.getByTestId('footer'));
      unmount();
    }
    // A draft with no text keeps no dots either.
    render(<SoulTypingBubble portrait={<span />} label="x" parts={[]} tone="stopped" footer={<span data-testid="footer" />} />);
    expect(screen.getByRole('status').querySelector('[data-slot="soul-typing-dots"]')).toBeNull();
  });

  it('puts an optional head line above the dots and above the live bubbles', () => {
    const { rerender } = render(<SoulTypingBubble portrait={<span />} label="x" head={<div data-testid="head">小月</div>} />);
    expect(screen.getByTestId('head')).toBeInTheDocument();
    rerender(<SoulTypingBubble portrait={<span />} label="x" head={<div data-testid="head">小月</div>} parts={[part('好')]} />);
    expect(screen.getByTestId('head').nextElementSibling).toBe(screen.getByTestId('pa-soul-live'));
  });
});

/* ── voice bar (stage 2) ──────────────────────────────────────────────────────────────────── */

const VOICE_LABELS = { play: '播放', pause: '暂停', seek: '播放进度', loading: '正在生成语音…', error: '语音没有生成', retry: '重试' };

function voiceBar(props: Partial<Parameters<typeof SoulVoiceBar>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onSeek: vi.fn(), onRetry: vi.fn() };
  const view = render(
    <SoulVoiceBar state="paused" currentTime={12} duration={65} surface="bubble" labels={VOICE_LABELS} {...handlers} {...props} />,
  );
  return { ...handlers, view };
}

describe('SoulVoiceBar', () => {
  it('plays and pauses, and shows the time against the duration', () => {
    const { onToggle, view } = voiceBar({ state: 'paused' });
    const bar = screen.getByTestId('pa-soul-voice-bar');
    expect(bar).toHaveAttribute('data-state', 'paused');
    expect(bar).toHaveAttribute('data-surface', 'bubble');
    expect(bar).toHaveAttribute('data-side', 'in');
    expect(bar).toHaveTextContent('0:12 / 1:05');
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    expect(onToggle).toHaveBeenCalledOnce();
    view.rerender(<SoulVoiceBar state="playing" currentTime={30} duration={65} surface="paper" labels={VOICE_LABELS} onToggle={onToggle} onSeek={vi.fn()} />);
    expect(screen.getByTestId('pa-soul-voice-toggle')).toHaveAccessibleName('暂停');
    expect(screen.getByTestId('pa-soul-voice-bar')).toHaveAttribute('data-surface', 'paper');
    const slider = screen.getByRole('slider', { name: '播放进度' });
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '65');
    expect(slider).toHaveAttribute('aria-valuenow', '30');
    expect(slider.style.getPropertyValue('--pa-voice')).toBe('0.4615');
  });

  it('seeks with the keys: ±5 s, Home and End', () => {
    const { onSeek } = voiceBar({ currentTime: 20, duration: 40 });
    const slider = screen.getByRole('slider', { name: '播放进度' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(25 / 40);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(15 / 40);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onSeek).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: 'a' });
    expect(onSeek).toHaveBeenCalledTimes(4);
  });

  it('seeks where the pointer goes down and while it drags', () => {
    const { onSeek } = voiceBar({ currentTime: 0, duration: 100 });
    const slider = screen.getByRole('slider', { name: '播放进度' });
    slider.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, right: 300, bottom: 20, height: 20, x: 100, y: 0, toJSON: () => ({}) });
    fireEvent(slider, new MouseEvent('pointerdown', { bubbles: true, clientX: 150, button: 0 }));
    expect(onSeek).toHaveBeenLastCalledWith(0.25);
    expect(slider).toHaveAttribute('data-dragging');
    fireEvent(slider, new MouseEvent('pointermove', { bubbles: true, clientX: 260 }));
    expect(onSeek).toHaveBeenLastCalledWith(0.8);
    fireEvent(slider, new MouseEvent('pointermove', { bubbles: true, clientX: 999 }));
    expect(onSeek).toHaveBeenLastCalledWith(1);
    fireEvent(slider, new MouseEvent('pointerup', { bubbles: true, clientX: 999 }));
    expect(slider).not.toHaveAttribute('data-dragging');
    fireEvent(slider, new MouseEvent('pointermove', { bubbles: true, clientX: 120 }));
    expect(onSeek).toHaveBeenCalledTimes(3);
  });

  it('does not seek while the duration is unknown', () => {
    const { onSeek } = voiceBar({ currentTime: 0, duration: null });
    const slider = screen.getByRole('slider', { name: '播放进度' });
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('pa-soul-voice-bar')).toHaveTextContent('0:00 / —:—');
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent(slider, new MouseEvent('pointerdown', { bubbles: true, clientX: 10, button: 0 }));
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('shows loading, the failure with a retry, and the blocked hint in place of the time', () => {
    const { onRetry, view } = voiceBar({ state: 'loading' });
    expect(screen.getByTestId('pa-soul-voice-bar')).toHaveTextContent('正在生成语音…');
    expect(screen.queryByRole('slider')).toBeNull();
    view.rerender(<SoulVoiceBar state="error" currentTime={0} duration={null} surface="bubble" labels={VOICE_LABELS} onToggle={vi.fn()} onSeek={vi.fn()} onRetry={onRetry} />);
    expect(screen.getByTestId('pa-soul-voice-bar')).toHaveTextContent('语音没有生成');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
    view.rerender(
      <SoulVoiceBar state="paused" currentTime={0} duration={9} surface="bubble" labels={{ ...VOICE_LABELS, blocked: '点播放开始收听' }} onToggle={vi.fn()} onSeek={vi.fn()} />,
    );
    expect(screen.getByTestId('pa-soul-voice-bar')).toHaveTextContent('点播放开始收听');
    expect(screen.getByTestId('pa-soul-voice-bar')).not.toHaveTextContent('0:00 / 0:09');
  });
});

/* ── standing picture (stage 2) ───────────────────────────────────────────────────────────── */

describe('SoulStage', () => {
  it('shows the sprite as one labelled picture and crossfades a new one', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SoulStage src="data:image/png;base64,CALM" name="小月" label="小月，平静" />);
    const stage = screen.getByTestId('pa-soul-stage');
    expect(stage).toHaveAttribute('role', 'img');
    expect(stage).toHaveAccessibleName('小月，平静');
    expect(stage.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,CALM');
    rerender(<SoulStage src="data:image/png;base64,HAPPY" name="小月" label="小月，开心" />);
    expect(stage.querySelectorAll('img')).toHaveLength(2);
    const next = stage.querySelector('img:not([aria-hidden])')!;
    fireEvent.load(next);
    expect(stage.querySelector('img[aria-hidden]')).toHaveAttribute('data-out');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(stage.querySelectorAll('img')).toHaveLength(1);
    expect(stage.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,HAPPY');
  });

  it('leaves the plain paper when the image fails', () => {
    render(<SoulStage src="/missing.webp" name="小月" label="小月" />);
    fireEvent.error(screen.getByTestId('pa-soul-stage').querySelector('img')!);
    expect(screen.getByTestId('pa-soul-stage').querySelector('img')).toBeNull();
    // plain paper is not announced as a picture
    expect(screen.getByTestId('pa-soul-stage')).not.toHaveAttribute('role');
    expect(screen.getByTestId('pa-soul-stage')).toHaveAttribute('aria-hidden', 'true');
  });
});
