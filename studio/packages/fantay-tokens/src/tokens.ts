/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/styles.css (@theme L10-128, :root L130-235, .dark L356-397) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: typed token tables as the single
 *   source of truth for tokens.css; neutral primary with one blue accent; danger fill, sidebar, scrim, focus/selection, control-height and z-ladder
 *   tokens; --type-* / --motion-* / --radius-chip names that do not collide with upstream Open Design.
 *
 * Spec: 01-ui-foundation §3.2, amended by 91 A1 (focus ring = 100% brand) and A2 (dark brand fill).
 * Edit these tables, then run `pnpm --filter @fantay/tokens generate` and commit tokens.css.
 */

export type ThemeName = 'light' | 'dark';

/** One value per theme. Every colour and shadow token carries both. */
export interface ThemedTokenValue {
  readonly light: string;
  readonly dark: string;
}

/** Token names are stored without the leading `--`. */
export type TokenTable = Readonly<Record<string, string>>;
export type ThemedTokenTable = Readonly<Record<string, ThemedTokenValue>>;

/**
 * Colours. Light neutrals are measured from Claude desktop, dark neutrals from ChatGPT desktop (2026-11-02):
 * neutrals carry the interface, --info is the only chromatic accent, status colours stay semantic.
 * Declaration order here is the declaration order in tokens.css.
 */
export const COLOR_TOKENS = {
  /** canvas / page ground */
  paper: { light: '#ffffff', dark: '#181818' },
  /** pressed / selected fill, hover fill */
  'paper-deep': { light: '#e5e5e5', dark: '#343434' },
  /** panels, cards, menus, controls */
  surface: { light: '#ffffff', dark: '#232323' },
  /** wells, menu row highlight */
  sub: { light: '#f3f3f3', dark: '#2a2a2a' },
  /** app sidebar ground */
  sidebar: { light: '#fafafa', dark: '#222222' },
  /** primary text, primary fill */
  ink: { light: '#181818', dark: '#ffffff' },
  /** secondary text */
  'ink-soft': { light: '#666666', dark: '#b4b4b4' },
  /** meta, placeholders, icons at rest */
  'ink-faint': { light: '#888888', dark: '#919191' },
  /** quietest text, disabled text */
  'ink-ghost': { light: '#b0b0b0', dark: '#666666' },
  /** hairlines, field borders */
  line: { light: '#e5e5e5', dark: '#353535' },
  /** separators */
  'line-soft': { light: '#f0f0f0', dark: '#2c2c2c' },
  /** board dot grid */
  dot: { light: '#e5e5e5', dark: '#2f2f2f' },
  /** primary fill and CTA: ink in light (Claude desktop), white in dark (ChatGPT accent) */
  brand: { light: '#181818', dark: '#ffffff' },
  /** primary fill hover */
  'brand-hover': { light: '#333333', dark: '#e5e5e5' },
  /** text on paper that carries the primary role */
  'brand-ink': { light: '#181818', dark: '#ffffff' },
  /** selected row / chip fill */
  'brand-soft': { light: '#e5e5e5', dark: '#343434' },
  /** text on brand fill */
  'on-brand': { light: '#ffffff', dark: '#181818' },
  /** the one chromatic accent: switches on, links, focus ring (sampled from Claude / ChatGPT desktop) */
  info: { light: '#407bd9', dark: '#4d81ef' },
  /** blue text on paper (AA on paper and surface) */
  'info-ink': { light: '#2f67c4', dark: '#8fb2f7' },
  /** blue tint */
  'info-soft': { light: 'rgba(64, 123, 217, 0.12)', dark: 'rgba(77, 129, 239, 0.18)' },
  /** text on info fill */
  'on-info': { light: '#ffffff', dark: '#ffffff' },
  /** danger text / failure (Doop name) */
  'accent-ink': { light: '#d0341f', dark: '#ff6b57' },
  /** danger fill */
  danger: { light: '#d0341f', dark: '#d0341f' },
  /** danger fill hover */
  'danger-hover': { light: '#b42a17', dark: '#b42a17' },
  /** text on danger fill */
  'on-danger': { light: '#ffffff', dark: '#ffffff' },
  /** success fill / dot */
  success: { light: '#1fc16b', dark: '#2fd47c' },
  /** success text */
  'success-ink': { light: '#0f7a45', dark: '#6fd8a0' },
  /** success on ink */
  'success-on-ink': { light: '#6fd8a0', dark: '#0f7a45' },
  /** warning fill / dot */
  warning: { light: '#ff8447', dark: '#ff9a66' },
  /** warning text */
  'warning-ink': { light: '#a8481a', dark: '#ffb58c' },
  /** code well (dark in both themes) */
  code: { light: '#181818', dark: '#181818' },
  /** code text */
  'code-ink': { light: '#ededed', dark: '#ededed' },
  /** working-agent avatar ring */
  'glaze-ring': { light: '#c9c9c9', dark: '#666666' },
  /** modal overlay */
  scrim: { light: 'rgba(0, 0, 0, 0.4)', dark: 'rgba(0, 0, 0, 0.5)' },
} as const satisfies ThemedTokenTable;

/** Shadows (Doop src/styles.css:174-188 light, :386-396 dark, verbatim). */
export const SHADOW_TOKENS = {
  'shadow-ring': {
    light: '0 0 0 1px rgba(0, 0, 0, 0.06), 0 1px 2px -1px rgba(0, 0, 0, 0.06), 0 2px 4px rgba(0, 0, 0, 0.04)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.25)',
  },
  'shadow-ring-hover': {
    light: '0 0 0 1px rgba(0, 0, 0, 0.08), 0 1px 2px -1px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.06)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.13), 0 1px 2px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3)',
  },
  'shadow-float': {
    light: '0 12px 40px -10px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.09), 0 12px 40px -10px rgba(0, 0, 0, 0.7)',
  },
  'shadow-pop': {
    light: '0 25px 80px -12px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.06)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.11), 0 4px 12px rgba(0, 0, 0, 0.45), 0 24px 56px -16px rgba(0, 0, 0, 0.75)',
  },
  'shadow-modal': {
    light:
      '0 0 0 0.5px rgba(0, 0, 0, 0.07), 0 2px 3px -2px rgba(0, 0, 0, 0.1), 0 3px 12px -4px rgba(0, 0, 0, 0.1), 0 4px 16px -8px rgba(0, 0, 0, 0.1)',
    dark:
      '0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 2px 3px -2px rgba(0, 0, 0, 0.5), 0 3px 12px -4px rgba(0, 0, 0, 0.5), 0 4px 16px -8px rgba(0, 0, 0, 0.6)',
  },
  'shadow-elevation-1-focus': {
    light:
      '0 0 0 2px color-mix(in srgb, var(--brand) 18%, transparent), 0 0 0 1px rgba(0, 0, 0, 0.08), 0 5px 7px -2px rgba(0, 0, 0, 0.05), 0 7px 20px -4px rgba(0, 0, 0, 0.06)',
    dark:
      '0 0 0 2px color-mix(in srgb, var(--brand) 32%, transparent), 0 0 0 1px rgba(255, 255, 255, 0.12), 0 4px 14px -3px rgba(0, 0, 0, 0.4)',
  },
} as const satisfies ThemedTokenTable;

/**
 * Derived tokens reference other tokens. They are emitted in BOTH theme blocks so they re-resolve on any
 * themed element (theme islands, `data-theme` on a subtree) instead of inheriting the root's computed value.
 */
export const DERIVED_TOKENS = {
  'shadow-card': 'var(--shadow-ring)',
  'shadow-elevation-1': 'var(--shadow-ring)',
  'shadow-elevation-1-hover': 'var(--shadow-ring-hover)',
  'shadow-elevation-2': 'var(--shadow-float)',
  /** The one focus ring: --info stays ≥ 3:1 (WCAG 1.4.11) on every surface in both themes. */
  'focus-ring-color': 'var(--info)',
  'selection-bg': 'color-mix(in srgb, var(--info) 22%, transparent)',
} as const satisfies TokenTable;

export interface StaticTokenGroup {
  readonly id: string;
  /** Rendered as a comment above the group in tokens.css. */
  readonly label: string;
  readonly tokens: TokenTable;
}

/** Theme-independent tokens, declared once on `:root`. */
export const STATIC_TOKEN_GROUPS = [
  {
    id: 'radii',
    label: 'radii (D2) — --radius-chip is the 10px "pill"; upstream keeps --radius-pill: 999px',
    tokens: {
      'radius-tag': '4px',
      'radius-row': '7px',
      'radius-control': '8px',
      'radius-chip': '10px',
      'radius-card': '12px',
      'radius-panel': '14px',
      'radius-modal': '18px',
    },
  },
  {
    id: 'fonts',
    label: 'fonts (D1) — Inter + CJK fallback, ui-monospace',
    tokens: {
      'font-ui':
        "'Inter Variable', 'Inter', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, -apple-system, 'Segoe UI', sans-serif",
      'font-mono': "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    },
  },
  {
    id: 'type',
    label: 'type scale by role (Doop styles.css:110-127); --type-micro is Latin/numeric only',
    tokens: {
      'type-micro': '10px',
      'type-micro-lh': '1.4',
      'type-caption': '11px',
      'type-caption-lh': '1.4',
      'type-label': '12px',
      'type-label-lh': '1.4',
      'type-body': '12.5px',
      'type-body-lh': '1.45',
      'type-copy': '13.5px',
      'type-copy-lh': '1.55',
      'type-lead': '15px',
      'type-lead-lh': '1.5',
      'type-heading': '18px',
      'type-heading-lh': '1.25',
      'type-title': '24px',
      'type-title-lh': '1.15',
      'type-display': '46px',
      'type-display-lh': '1',
    },
  },
  {
    id: 'motion',
    label: 'motion (D1) — enter 200ms / exit 140ms, ease-out-quint; upstream owns --duration-*',
    tokens: {
      'ease-out-quint': 'cubic-bezier(0.23, 1, 0.32, 1)',
      'ease-out-cubic': 'cubic-bezier(0.215, 0.61, 0.355, 1)',
      'ease-out-quad': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      'ease-in-out-cubic': 'cubic-bezier(0.645, 0.045, 0.355, 1)',
      'motion-instant': '50ms',
      'motion-micro': '100ms',
      'motion-fast': '150ms',
      'motion-enter': '200ms',
      'motion-exit': '140ms',
      'motion-slow': '300ms',
    },
  },
  {
    id: 'state',
    label: 'focus / state (D3)',
    tokens: {
      'focus-ring-width': '2px',
      'focus-ring-offset': '2px',
      'disabled-opacity': '0.45',
    },
  },
  {
    id: 'controls',
    label: 'control heights (D3), for non-Tailwind consumers',
    tokens: {
      'control-sm': '28px',
      'control-md': '32px',
      'control-lg': '40px',
    },
  },
  {
    id: 'z',
    label: 'z ladder — above upstream dialogs (1500), aligned with --z-menu: 9000',
    tokens: {
      'z-fx-overlay': '5000',
      'z-fx-floating': '9000',
      'z-fx-confirm': '9100',
      'z-fx-tooltip': '9200',
      'z-fx-toast': '9300',
    },
  },
] as const satisfies readonly StaticTokenGroup[];

/** Flat view of STATIC_TOKEN_GROUPS, in declaration order. */
export const STATIC_TOKENS: TokenTable = Object.freeze(
  Object.assign({}, ...STATIC_TOKEN_GROUPS.map((group) => group.tokens)) as Record<string, string>,
);

/** CJK labels never render below 12px (D1): applied under `:root:lang(zh|ja|ko)`. */
export const CJK_OVERRIDES = {
  'type-caption': '12px',
} as const satisfies TokenTable;

export const CJK_LANGS = ['zh', 'ja', 'ko'] as const;

/**
 * Raw token names that intentionally reuse an upstream Open Design name (upstream neon green → violet).
 * Every other Fantay token name is new to the cascade.
 */
export const UPSTREAM_SHARED_TOKEN_NAMES = ['brand', 'brand-ink', 'brand-soft'] as const;

/** Every token name, without the leading `--`, in tokens.css declaration order (duplicates included). */
export function listTokenNames(): string[] {
  return [
    ...Object.keys(STATIC_TOKENS),
    ...Object.keys(COLOR_TOKENS),
    ...Object.keys(SHADOW_TOKENS),
    ...Object.keys(DERIVED_TOKENS),
  ];
}
