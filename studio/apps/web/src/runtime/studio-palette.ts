// The model behind the design system colour board: every colour token becomes a measured card
// (name, number, Hex / RGB / CMYK, the ink that reads best on it, its tint steps). Pure apart from
// the optional canvas fallback that normalises CSS colour syntaxes the parser does not cover.
import { resolveStudioToken, type StudioDocument, type StudioToken, type StudioTheme } from '@open-design/contracts';

export type PaletteTier = 'foundation' | 'role' | 'detail';
export type Rgb = readonly [number, number, number];
export interface ParsedColor { rgb: Rgb; alpha: number }
export interface PaletteStep { percent: number; color: string; ink: string }
export interface PaletteCard {
  name: string;
  number: string;
  label: string;
  note: string;
  tier: PaletteTier;
  /** Resolved CSS value for this scope; empty when the token cannot be resolved. */
  value: string;
  /** The value declared in this scope; null when it is inherited from the base theme. */
  own: string | null;
  rgb: Rgb | null;
  alpha: number;
  /** Uppercase, without the leading #. Null when the value is not a measurable colour. */
  hex: string | null;
  rgbText: string | null;
  cmykText: string | null;
  /** The text colour that reads best on this card: the system's ink, its paper, or white. */
  ink: string;
  /** Contrast against the ground colour, for text-like tokens. */
  contrast: number | null;
  steps: PaletteStep[];
}
/** One colour as the board shows it: the first token with this value, and every token that repeats it. */
export interface DistinctCard extends PaletteCard {
  /** The later tokens that resolve to the same colour in this scope, in token order. */
  aliases: string[];
}
export interface Palette {
  /** Every colour token, one card each. */
  cards: PaletteCard[];
  /** One card per colour in this scope, renumbered; unmeasurable values never merge. */
  distinct: DistinctCard[];
  ground: string;
  ink: string;
  counts: Record<PaletteTier, number>;
  distinctCounts: Record<PaletteTier, number>;
}

/** The four tints a card opens into, as a percentage of the full colour. */
export const PALETTE_STEPS = [60, 40, 22, 13] as const;

interface RoleCopy { zh: string; en: string; noteZh: string; noteEn: string }
const ROLES: Record<string, RoleCopy> = {
  bg: { zh: '底色', en: 'Ground', noteZh: '页面的底，所有内容落在这里', noteEn: 'The ground everything sits on' },
  surface: { zh: '表面', en: 'Surface', noteZh: '面板与卡片', noteEn: 'Panels and cards' },
  'surface-warm': { zh: '托盘', en: 'Tray', noteZh: '把卡片托起来的一层', noteEn: 'The tone that holds cards' },
  paper: { zh: '纸面', en: 'Paper', noteZh: '内容落在其上的纸', noteEn: 'The sheet content sits on' },
  canvas: { zh: '画布', en: 'Canvas', noteZh: '托住纸面的一层', noteEn: 'The tone behind the sheet' },
  fg: { zh: '墨色', en: 'Ink', noteZh: '标题，以及需要精确的内容', noteEn: 'Headings, and what is exact' },
  ink: { zh: '墨色', en: 'Ink', noteZh: '标题，以及需要精确的内容', noteEn: 'Headings, and what is exact' },
  'ink-soft': { zh: '柔墨', en: 'Soft ink', noteZh: '连续阅读的文字', noteEn: 'Running text' },
  'ink-faint': { zh: '淡墨', en: 'Faint ink', noteZh: '时间、计数与小字', noteEn: 'Timestamps, counts and small print' },
  secondary: { zh: '次要色', en: 'Secondary', noteZh: '排在强调色之后的颜色', noteEn: 'The colour after the accent' },
  'base-white': { zh: '基础白', en: 'Base white', noteZh: '不随主题变化的白', noteEn: 'White that ignores themes' },
  'base-ink': { zh: '基础墨', en: 'Base ink', noteZh: '不随主题变化的墨', noteEn: 'Ink that ignores themes' },
  link: { zh: '链接', en: 'Link', noteZh: '可点击的文字', noteEn: 'Text you can follow' },
  'fg-2': { zh: '正文', en: 'Body', noteZh: '连续阅读的文字', noteEn: 'Running text' },
  muted: { zh: '次要', en: 'Muted', noteZh: '辅助说明', noteEn: 'Supporting text' },
  meta: { zh: '元信息', en: 'Meta', noteZh: '时间、计数与小字', noteEn: 'Timestamps, counts and small print' },
  border: { zh: '描边', en: 'Border', noteZh: '分组与控件边界', noteEn: 'Groups and control edges' },
  'border-soft': { zh: '细线', en: 'Hairline', noteZh: '最轻的分隔', noteEn: 'The lightest divider' },
  line: { zh: '描边', en: 'Line', noteZh: '分组与控件边界', noteEn: 'Groups and control edges' },
  'line-soft': { zh: '细线', en: 'Hairline', noteZh: '最轻的分隔', noteEn: 'The lightest divider' },
  accent: { zh: '强调', en: 'Accent', noteZh: '主要操作与需要被注意的地方', noteEn: 'Primary actions and what needs attention' },
  'accent-on': { zh: '强调上的字', en: 'On accent', noteZh: '落在强调色上的文字', noteEn: 'Text placed on the accent' },
  'accent-hover': { zh: '强调·悬停', en: 'Accent hover', noteZh: '指针停留时', noteEn: 'While hovered' },
  'accent-active': { zh: '强调·按下', en: 'Accent pressed', noteZh: '按下时', noteEn: 'While pressed' },
  success: { zh: '成功', en: 'Success', noteZh: '完成与通过', noteEn: 'Done and passed' },
  warn: { zh: '警告', en: 'Warning', noteZh: '需要留意', noteEn: 'Needs attention' },
  danger: { zh: '危险', en: 'Danger', noteZh: '错误与不可逆操作', noteEn: 'Errors and irreversible actions' },
};
const GROUND = ['bg', 'background', 'paper', 'canvas', 'page', 'bg-primary', 'background-primary'];
const INK = ['fg', 'foreground', 'ink', 'text', 'text-primary', 'text-strong', 'fg-primary'];
const ACCENT = ['accent', 'primary', 'brand', 'brand-primary', 'color-primary'];
const DETAIL = /border|line|stroke|divider|outline|ring|success|warn|danger|error|info|positive|negative|(^|-)on(-|$)/;

const slug = (name: string) => name.replace(/^--/, '').replace(/^color-/, '');
const clamp255 = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

export function hexOf(rgb: Rgb): string {
  return rgb.map((channel) => clamp255(channel).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [0, 1, 2].map((index) => from[index]! + (to[index]! - from[index]!) * amount) as unknown as Rgb;
}
export function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Device CMYK from sRGB, the same naive conversion printed on a swatch card. */
export function cmykOf(rgb: Rgb): [number, number, number, number] {
  const [r, g, b] = rgb.map((channel) => channel / 255) as [number, number, number];
  const key = 1 - Math.max(r, g, b);
  if (key >= 1) return [0, 0, 0, 100];
  const ink = (channel: number) => Math.round(((1 - channel - key) / (1 - key)) * 100);
  return [ink(r), ink(g), ink(b), Math.round(key * 100)];
}
function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const colorCache = new Map<string, ParsedColor | null>();
function canvasColor(value: string): ParsedColor | null {
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return null;
  const cached = colorCache.get(value);
  if (cached !== undefined) return cached;
  let parsed: ParsedColor | null = null;
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (context) {
    context.canvas.width = context.canvas.height = 1;
    context.fillStyle = '#010203';
    context.fillStyle = value;
    if (context.fillStyle !== '#010203' || value.trim().toLowerCase() === '#010203') {
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      parsed = { rgb: [r!, g!, b!], alpha: a! / 255 };
    }
  }
  colorCache.set(value, parsed);
  return parsed;
}
/** Parses any CSS colour the page can draw; hex, rgb() and hsl() need no browser. */
export function parseStudioColor(input: string): ParsedColor | null {
  const value = input.trim().toLowerCase();
  const hex = /^#([\da-f]{3,8})$/.exec(value)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    return { rgb: [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)], alpha: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value);
  if (fn) {
    const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
    const number = (raw: string | undefined, scale: number) => raw === undefined ? NaN : raw.endsWith('%') ? parseFloat(raw) * scale / 100 : parseFloat(raw);
    const alpha = parts[3] === undefined ? 1 : number(parts[3], 1);
    if (parts.length >= 3 && Number.isFinite(alpha)) {
      if (fn[1]!.startsWith('rgb')) {
        const rgb = [number(parts[0], 255), number(parts[1], 255), number(parts[2], 255)];
        if (rgb.every(Number.isFinite)) return { rgb: rgb.map(clamp255) as unknown as Rgb, alpha };
      } else {
        const [h, s, l] = [parseFloat(parts[0]!), number(parts[1], 1), number(parts[2], 1)];
        if ([h, s, l].every(Number.isFinite)) return { rgb: hslToRgb(((h % 360) + 360) % 360, s > 1 ? s / 100 : s, l > 1 ? l / 100 : l).map(clamp255) as unknown as Rgb, alpha };
      }
    }
  }
  return canvasColor(input);
}

/** The text colour that reads best on `background`: the system's ink, its paper, or white. */
export function readableInk(background: Rgb, ink: string, paper: string): string {
  const candidates = [ink, paper, '#ffffff'].flatMap((color) => { const parsed = parseStudioColor(color); return parsed ? [{ color, rgb: parsed.rgb }] : []; });
  return candidates.reduce((best, item) => contrastRatio(background, item.rgb) > contrastRatio(background, best.rgb) ? item : best, candidates[0] ?? { color: '#121211', rgb: [18, 18, 17] as Rgb }).color;
}

export function studioTokenLabel(name: string, chinese: boolean): string {
  const role = ROLES[slug(name)];
  if (role) return chinese ? role.zh : role.en;
  const words = slug(name).replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}
export function studioTokenNote(name: string, notes: StudioDocument['tokenNotes'], chinese: boolean): string {
  const own = notes[name]?.description?.trim();
  if (own) return own;
  const role = ROLES[slug(name)];
  return role ? (chinese ? role.noteZh : role.noteEn) : '';
}

function pickFoundation(names: string[]): string[] {
  const picked: string[] = [];
  for (const family of [GROUND, INK, ACCENT]) {
    const match = family.flatMap((key) => names.filter((name) => slug(name) === key))[0];
    if (match) picked.push(match);
  }
  return picked;
}

/** Every colour token of a theme, ordered ground, ink, accent, roles, details, and numbered. */
export function studioPalette(tokens: StudioToken[], scope: string, notes: StudioDocument['tokenNotes'], chinese: boolean): Palette {
  const colorTokens = tokens.filter((token) => token.group === 'colors');
  const names = Array.from(new Set(colorTokens.map((token) => token.name)));
  const foundation = pickFoundation(names);
  const value = (name: string) => resolveStudioToken(name, tokens, scope) ?? '';
  const groundName = foundation.find((name) => GROUND.includes(slug(name)));
  const inkName = foundation.find((name) => INK.includes(slug(name)));
  const ground = (groundName && value(groundName)) || '#ffffff';
  const ink = (inkName && value(inkName)) || '#121211';
  const groundRgb = parseStudioColor(ground)?.rgb ?? [255, 255, 255] as Rgb;
  const rest = names.filter((name) => !foundation.includes(name));
  const ordered: { name: string; tier: PaletteTier }[] = [
    ...foundation.map((name) => ({ name, tier: 'foundation' as const })),
    ...rest.filter((name) => !DETAIL.test(slug(name))).map((name) => ({ name, tier: 'role' as const })),
    ...rest.filter((name) => DETAIL.test(slug(name))).map((name) => ({ name, tier: 'detail' as const })),
  ];
  const cards = ordered.map(({ name, tier }, index): PaletteCard => {
    const resolved = value(name);
    const parsed = resolved ? parseStudioColor(resolved) : null;
    const flat = parsed ? (parsed.alpha < 1 ? mixRgb(groundRgb, parsed.rgb, parsed.alpha) : parsed.rgb) : null;
    return {
      name, tier, number: String(index + 1).padStart(2, '0'),
      label: studioTokenLabel(name, chinese), note: studioTokenNote(name, notes, chinese),
      value: resolved, own: colorTokens.filter((token) => token.name === name && token.scope === scope).at(-1)?.value ?? null,
      rgb: flat, alpha: parsed?.alpha ?? 1,
      hex: flat ? hexOf(flat) : null,
      rgbText: flat ? flat.map(clamp255).join(' ') : null,
      cmykText: flat ? cmykOf(flat).join(' ') : null,
      ink: flat ? readableInk(flat, ink, ground) : ink,
      contrast: flat && /ink|text|foreground|fg|muted|meta|on-|-on$|link/.test(slug(name)) ? Math.round(contrastRatio(flat, groundRgb) * 100) / 100 : null,
      steps: flat ? PALETTE_STEPS.map((percent) => {
        const tint = mixRgb(flat, [255, 255, 255], 1 - percent / 100);
        return { percent, color: '#' + hexOf(tint), ink: readableInk(tint, ink, ground) };
      }) : [],
    };
  });
  const distinct = distinctCards(cards, notes, chinese);
  const count = (list: PaletteCard[], tier: PaletteTier) => list.filter((card) => card.tier === tier).length;
  const counts = (list: PaletteCard[]) => ({ foundation: count(list, 'foundation'), role: count(list, 'role'), detail: count(list, 'detail') });
  return { cards, distinct, ground, ink, counts: counts(cards), distinctCounts: counts(distinct) };
}

/**
 * Folds tokens that resolve to the same colour in this scope into the first card that shows it.
 * Per scope on purpose: two tokens that alias in the light theme can part ways in the dark one.
 */
function distinctCards(cards: PaletteCard[], notes: StudioDocument['tokenNotes'], chinese: boolean): DistinctCard[] {
  const merged: DistinctCard[] = [];
  const byColour = new Map<string, DistinctCard>();
  for (const card of cards) {
    const key = card.hex ? `${card.hex}/${card.alpha}` : null;
    const first = key ? byColour.get(key) : undefined;
    if (first) { first.aliases.push(card.name); continue; }
    const kept: DistinctCard = { ...card, aliases: [] };
    if (key) byColour.set(key, kept);
    merged.push(kept);
  }
  // Two cards may still share a role name, say `--accent` and `--color-accent` with different
  // values. The later ones are numbered in the UI language ('强调 2', 'Accent 2'), so no two cards
  // read the same; each card's token row still names its token. A stock note describes one role, so
  // where several cards share it, it describes none of them and only notes the author wrote remain.
  const shared = new Map<string, number>();
  for (const card of merged) shared.set(card.label, (shared.get(card.label) ?? 0) + 1);
  // A number skips every label some card already carries, so `--accent-2` never meets a second 'Accent 2'.
  const taken = new Set(shared.keys());
  const labels = new Set<string>();
  return merged.map((card, index) => {
    let label = card.label;
    for (let ordinal = 2; labels.has(label); ordinal += 1) {
      label = `${card.label} ${ordinal}`;
      if (taken.has(label)) label = card.label;
    }
    labels.add(label);
    const note = shared.get(card.label)! > 1 ? notes[card.name]?.description?.trim() ?? '' : card.note;
    return { ...card, label, note, number: String(index + 1).padStart(2, '0') };
  });
}

/** Splits cards into balanced rows, so a short last row never stretches a lone card across the board. */
export function paletteRows<T>(cards: readonly T[], perRow: number): T[][] {
  if (!cards.length) return [];
  const rowCount = Math.ceil(cards.length / Math.max(1, perRow));
  const rows: T[][] = [];
  let start = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const size = Math.ceil((cards.length - start) / (rowCount - row));
    rows.push(cards.slice(start, start + size));
    start += size;
  }
  return rows;
}

/**
 * The themes a design system can be previewed in, base theme first. `:root` only joins when a colour
 * is declared there (or nothing else is), so a package written as `:root, .light {…}` or `html {…}`
 * opens on the scope that actually holds its colours.
 */
export function studioThemeScopes(tokens: StudioToken[], themes: StudioTheme[]): string[] {
  const declared = tokens.filter((token) => token.group === 'colors').map((token) => token.scope);
  const rest = Array.from(new Set([...themes.map((theme) => theme.selector), ...declared])).filter((scope) => scope !== ':root');
  return declared.includes(':root') || !rest.length ? [':root', ...rest] : rest;
}
export function studioScopeLabel(scope: string, themes: StudioTheme[], chinese: boolean): string {
  const named = themes.find((theme) => theme.selector === scope)?.name;
  if (named) return named;
  if (scope === ':root') return chinese ? '浅色' : 'Light';
  return /dark/.test(scope) ? (chinese ? '深色' : 'Dark') : scope;
}
