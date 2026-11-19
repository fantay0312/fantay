import { describe, expect, it } from 'vitest';
import {
  PA_CHAT_THEMES,
  PA_DEFAULT_APPEARANCE,
  PA_THEME_META,
  exportCharacterCard,
  paCharacterInputSchema,
  paChatAppearanceSchema,
  parseCharacterCard,
  resolveAppearance,
} from '../../src/soul/index';
import type { PaChatAppearance, PaCharacter } from '../../src/soul/index';

const stage2: PaChatAppearance = { layout: 'journal', pattern: 'dots', avatarFrame: 'polaroid', accent: '#a1b2c3', stage: 'side' };

describe('resolveAppearance', () => {
  it('starts from the default and lets later layers win', () => {
    expect(resolveAppearance()).toEqual(PA_DEFAULT_APPEARANCE);
    expect(resolveAppearance(null, undefined)).toEqual(PA_DEFAULT_APPEARANCE);
    const resolved = resolveAppearance(
      { theme: 'rain', shape: 'round', scale: 'lg' },
      null,
      { shape: 'square', theme: undefined },
      { pacing: 'instant' },
    );
    expect(resolved).toMatchObject({ theme: 'rain', shape: 'square', scale: 'lg', pacing: 'instant' });
    expect(resolveAppearance({ accent: '#112233' }, {})).toMatchObject({ accent: '#112233' });
    expect(resolveAppearance({ accent: '#112233' }, { accent: null })).toMatchObject({ accent: null });
  });

  it('takes font, pattern and frame from the resolved theme unless a layer sets them', () => {
    expect(resolveAppearance({ theme: 'archive' })).toMatchObject({ font: 'serif', pattern: 'ruled', avatarFrame: 'squircle' });
    expect(resolveAppearance({ theme: 'sakura' }, {})).toMatchObject({ font: 'kai', pattern: 'dots', avatarFrame: 'squircle' });
    expect(resolveAppearance({ font: 'mono', pattern: 'grid' }, { theme: 'archive' }))
      .toMatchObject({ theme: 'archive', font: 'mono', pattern: 'grid', avatarFrame: 'squircle' });
    expect(resolveAppearance({ theme: 'sakura' }, { theme: 'deepsea' }))
      .toMatchObject({ font: 'ui', pattern: 'grid', avatarFrame: 'circle', layout: 'bubble', accent: null });
  });

  it('ignores values a layer cannot hold', () => {
    const stored = { theme: 'neon', shape: 'blob', accent: 'red' } as unknown as PaChatAppearance;
    expect(resolveAppearance({ shape: 'round' }, stored)).toEqual({ ...PA_DEFAULT_APPEARANCE, shape: 'round' });
  });
});

describe('stage 2 appearance fields', () => {
  it('parse and resolve', () => {
    expect(paChatAppearanceSchema.parse(stage2)).toEqual(stage2);
    expect(paChatAppearanceSchema.safeParse({ accent: 'red' }).success).toBe(false);
    expect(paChatAppearanceSchema.safeParse({ accent: '#fff' }).success).toBe(false);
    expect(paChatAppearanceSchema.safeParse({ frame: 'circle' }).success).toBe(false);
    expect(resolveAppearance({ theme: 'ink' }, stage2)).toEqual({
      theme: 'ink', shape: 'soft', font: 'kai', scale: 'md', pacing: 'paced',
      layout: 'journal', pattern: 'dots', avatarFrame: 'polaroid', accent: '#a1b2c3', stage: 'side',
    });
  });

  it('resolves stage through the layers and defaults it to off', () => {
    expect(PA_DEFAULT_APPEARANCE.stage).toBe('off');
    expect(resolveAppearance().stage).toBe('off');
    expect(resolveAppearance({ theme: 'rain' }).stage).toBe('off');
    expect(resolveAppearance({ stage: 'side' }).stage).toBe('side');
    expect(resolveAppearance({ stage: 'side' }, { stage: 'off' }).stage).toBe('off');
    expect(resolveAppearance({ stage: 'side' }, { theme: 'ink' }, null).stage).toBe('side');
    expect(resolveAppearance({ stage: 'top' } as unknown as PaChatAppearance).stage).toBe('off');
  });

  it('survive a card export round trip', () => {
    const appearance: PaChatAppearance = { theme: 'archive', shape: 'square', ...stage2 };
    const character: PaCharacter = {
      id: 'agent-1', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, revision: 1,
      ...paCharacterInputSchema.parse({ description: 'Keeps the old letters.', appearance }),
      origin: null, preserved: {}, needsReview: [],
    };
    const card = exportCharacterCard({ name: 'Mira', character, lorebooks: [], now: 1_800_000_000_000 });
    const preview = parseCharacterCard(card, { now: 1_800_000_000_000 });
    if (!preview.ok) throw new Error(`card did not parse: ${preview.error}`);
    expect(preview.character.appearance).toEqual(appearance);
    expect(resolveAppearance(preview.character.appearance)).toEqual(resolveAppearance(appearance));
  });
});

describe('theme meta', () => {
  it('covers every theme with both locale names', () => {
    expect(Object.keys(PA_THEME_META).sort()).toEqual([...PA_CHAT_THEMES].sort());
    for (const theme of PA_CHAT_THEMES) {
      const meta = PA_THEME_META[theme];
      expect(meta.name.zh.length, theme).toBeGreaterThan(0);
      expect(meta.name.en.length, theme).toBeGreaterThan(0);
      expect(paChatAppearanceSchema.safeParse({ theme, font: meta.font, pattern: meta.pattern, avatarFrame: meta.avatarFrame }).success)
        .toBe(true);
    }
    expect(PA_THEME_META.fantay).toMatchObject({ font: PA_DEFAULT_APPEARANCE.font, pattern: PA_DEFAULT_APPEARANCE.pattern });
    expect(PA_THEME_META.sakura.name).toEqual({ zh: '樱花手帐', en: 'Sakura journal' });
  });
});
