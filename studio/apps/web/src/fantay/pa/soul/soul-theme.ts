// SPDX-License-Identifier: AGPL-3.0-only
// Soul chat appearance → the data attributes that select the `--pa-skin-*` theme blocks of styles/pa.css (Soul UI spec
// §8.4). Every resolved key is drawn (stage 2): `pattern`, `avatarFrame` (polaroid included), `layout` (bubble or
// journal) and `accent`. The accent is never drawn as stored: the engine's `guardAccent` moves its lightness per mode
// until it reads on the theme's paper, cards and incoming bubbles, and the result arrives as inline `--pa-accent-*`.
import type { CSSProperties } from 'react';
import type { PaChatTheme, PaResolvedAppearance } from '@open-design/contracts';
import { PA_THEME_META, guardAccent } from '@open-design/contracts/soul';

export interface SoulThemeAttrs {
  'data-pa-skin': PaChatTheme;
  'data-pa-shape': 'round' | 'soft' | 'square';
  'data-pa-font': 'ui' | 'serif' | 'kai' | 'mono';
  'data-pa-scale': 'sm' | 'md' | 'lg';
  'data-pa-pattern': 'none' | 'grid' | 'ruled' | 'dots';
  'data-pa-frame': 'circle' | 'squircle' | 'polaroid';
  'data-pa-layout': 'bubble' | 'journal';
  'data-pa-accent'?: '';
}

/** One shared object: no custom accent sets no inline property, and a stable value keeps `style` from churning. */
const NO_STYLE: CSSProperties = Object.freeze({}) as CSSProperties;

/** The guarded accent per theme and stored colour; small, so the style object of one chat stays the same object. */
const ACCENT_STYLES = new Map<string, CSSProperties | null>();
const ACCENT_STYLES_MAX = 32;

/** The inline accent properties for a stored colour, or null when the theme's own accent applies (none stored, an
 *  invalid value, or a colour no lightness can make readable). */
function accentStyle(theme: PaChatTheme, accent: string | null): CSSProperties | null {
  if (accent === null) return null;
  const key = `${theme}|${accent}`;
  const known = ACCENT_STYLES.get(key);
  if (known !== undefined) return known;
  const guard = guardAccent(theme, accent);
  const style = guard?.ok
    ? (Object.freeze({
        '--pa-accent-l': guard.light.accent,
        '--pa-accent-ink-l': guard.light.accentInk,
        '--pa-link-l': guard.light.link,
        '--pa-accent-d': guard.dark.accent,
        '--pa-accent-ink-d': guard.dark.accentInk,
        '--pa-link-d': guard.dark.link,
      }) as CSSProperties)
    : null;
  if (ACCENT_STYLES.size >= ACCENT_STYLES_MAX) {
    const oldest = ACCENT_STYLES.keys().next();
    if (!oldest.done) ACCENT_STYLES.delete(oldest.value);
  }
  ACCENT_STYLES.set(key, style);
  return style;
}

/** The frame the portraits of this appearance are drawn in (a size below 28 draws polaroid as squircle). */
export function soulFrameOf(appearance: PaResolvedAppearance): 'circle' | 'squircle' | 'polaroid' {
  return appearance.avatarFrame === 'circle' || appearance.avatarFrame === 'polaroid' ? appearance.avatarFrame : 'squircle';
}

/** Data attributes for the element that owns a themed area. `data-pa-accent` only while a guarded accent is drawn. */
export function soulThemeAttrs(appearance: PaResolvedAppearance): SoulThemeAttrs {
  const attrs: SoulThemeAttrs = {
    'data-pa-skin': appearance.theme,
    'data-pa-shape': appearance.shape,
    'data-pa-font': appearance.font,
    'data-pa-scale': appearance.scale,
    'data-pa-pattern': appearance.pattern,
    'data-pa-frame': soulFrameOf(appearance),
    'data-pa-layout': appearance.layout === 'journal' ? 'journal' : 'bubble',
  };
  if (accentStyle(appearance.theme, appearance.accent) !== null) attrs['data-pa-accent'] = '';
  return attrs;
}

/** Inline custom properties for the same element: the guarded accent (light and dark values; pa.css picks the mode),
 *  else the shared empty object. */
export function soulThemeStyle(appearance: PaResolvedAppearance): CSSProperties {
  return accentStyle(appearance.theme, appearance.accent) ?? NO_STYLE;
}

/** Display name from PA_THEME_META. */
export function soulThemeName(theme: PaChatTheme, locale: 'zh' | 'en'): string {
  return PA_THEME_META[theme]?.name[locale] ?? theme;
}
