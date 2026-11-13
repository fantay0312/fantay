// The cover above a design system's brand book, after Claude Design's cover rules: the palette as a
// few big blocks, one pattern picked from what the system says about itself, and the name in the
// display face, bottom-left on the ground. It is drawn from the resolved tokens of the theme on show,
// one 960-wide picture that scales down with the page, so it reads the same at every width.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveStudioToken, type StudioDocument, type StudioToken } from '@open-design/contracts';
import { contrastRatio, hexOf, mixRgb, parseStudioColor, relativeLuminance, studioPalette, type Rgb } from '../runtime/studio-palette';
import styles from './StudioCover.module.css';

const W = 960;
const H = 288;
const BAND_H = 320;
const BAND = 112;
const LEFT = 48;
const ZONE = 440;
const ZONE_X = 480;
const NAME_MAX = 120;
const NAME_MIN = 64;
const TAGLINE = 14;
const FALLBACK_GROUND: Rgb = [246, 245, 242];
const FALLBACK_INK: Rgb = [32, 32, 32];

type CoverStyle = 'editorial' | 'technical' | 'soft' | 'modular';
interface Colours { ground: Rgb; ink: Rgb; muted: Rgb; primary: Rgb; secondary: Rgb; deep: Rgb; tint: Rgb }
interface Traits { style: CoverStyle; radius: number; display: string | null; body: string | null; weight: string | null; tracking: string | null }
interface NameLayout { lines: string[]; size: number; band: boolean }

const css = (rgb: Rgb) => '#' + hexOf(rgb);
const chroma = (rgb: Rgb) => (Math.max(...rgb) - Math.min(...rgb)) / 255;
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const BRAND = /(^|-)(brand|primary|accent)(-|$)/;
const STATUS = /danger|error|success|warn|info|positive|negative|critical|caution|alert/;
const SERIF = /(^|[^-])\bserif\b|georgia|garamond|times|baskerville|caslon|playfair|lora|merriweather|fraunces|newsreader|source serif|noto serif|instrument serif|crimson|libre|song|宋|明|ming|kinghwa|tiempos|charter|copernicus|domaine|canela/i;
const MONO = /mono|code|courier|consol|menlo|jetbrains/i;

function px(value: string | null | undefined): number | null {
  const match = value ? /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(value.trim()) : null;
  if (!match) return null;
  return Number(match[1]) * (match[2] && match[2] !== 'px' ? 16 : 1);
}
function firstFamily(stack: string | null): string {
  return stack?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
}

function readTraits(tokens: StudioToken[], scope: string): Traits {
  const read = (name: string | undefined) => (name ? resolveStudioToken(name, tokens, scope)?.trim() || null : null);
  const names = (group: StudioToken['group']) => Array.from(new Set(tokens.filter((token) => token.group === group).map((token) => token.name)));
  const families = names('typography').filter((name) => /font|family/.test(name) && !/size|weight|mono|code/.test(name));
  const display = read('--font-display') ?? read('--font-heading') ?? read(families[0]);
  const body = read('--font-body') ?? read('--font-sans') ?? read(families[1]) ?? display;
  const radii = names('radius');
  const radius = px(read('--radius-md') ?? read('--radius') ?? read(radii.find((name) => /md|base|default/.test(name)) ?? radii[0])) ?? 8;
  const large = px(read('--radius-lg') ?? read('--radius-xl')) ?? radius;
  const small = px(read('--radius-sm') ?? read('--radius-xs')) ?? radius;
  const head = firstFamily(display);
  const style: CoverStyle = SERIF.test(head) && !/sans/i.test(head) ? 'editorial'
    : MONO.test(head) || MONO.test(firstFamily(body)) ? 'technical'
    : large >= 18 || radius >= 14 ? 'soft'
    : 'modular';
  return {
    style,
    radius: small <= 2 && radius <= 4 ? 0 : Math.min(20, Math.max(2, radius)),
    display, body,
    weight: read('--font-weight-display') ?? read('--weight-display'),
    tracking: read('--tracking-display'),
  };
}

function flatten(value: string | null | undefined, over: Rgb): Rgb | null {
  const parsed = value ? parseStudioColor(value) : null;
  if (!parsed) return null;
  return parsed.alpha < 1 ? mixRgb(over, parsed.rgb, parsed.alpha) : parsed.rgb;
}

/**
 * Identity first: the hues people know the brand by take the big blocks even where the UI spends them
 * sparingly; a colour that only means a state stays out unless nothing else has a hue.
 */
function readColours(tokens: StudioToken[], scope: string, notes: StudioDocument['tokenNotes'], chinese: boolean): Colours {
  const palette = studioPalette(tokens, scope, notes, chinese);
  const ground = flatten(palette.ground, [255, 255, 255]) ?? FALLBACK_GROUND;
  const ink = flatten(palette.ink, ground) ?? FALLBACK_INK;
  const seen = new Set<string>();
  const cards = palette.cards.filter((card) => {
    if (!card.rgb || !card.hex || seen.has(card.hex)) return false;
    seen.add(card.hex);
    return true;
  }) as (typeof palette.cards[number] & { rgb: Rgb })[];
  const muted = cards.find((card) => /(^|-)(muted|fg-2|ink-soft|text-secondary)(-|$)/.test(card.name))?.rgb ?? mixRgb(ground, ink, 0.62);
  const visible = cards.filter((card) => contrastRatio(card.rgb, ground) >= 1.2 || distance(card.rgb, ground) > 48);
  const hued = visible.filter((card) => chroma(card.rgb) >= 0.2);
  const rank = (card: typeof hued[number]) => (BRAND.test(card.name) ? 2 : 0) + (STATUS.test(card.name) ? -2 : 0) + chroma(card.rgb);
  const hues = [...hued].sort((a, b) => rank(b) - rank(a)).filter((card, index, list) => index === 0 || distance(card.rgb, list[0]!.rgb) > 60 || list.length < 3);
  const darkGround = relativeLuminance(ground) < 0.2;
  // The deep block is the strongest neutral against the ground: ink on paper, paper on a dark theme.
  const neutrals = visible.filter((card) => chroma(card.rgb) < 0.2);
  const deep = [...neutrals].sort((a, b) => contrastRatio(b.rgb, ground) - contrastRatio(a.rgb, ground))[0]?.rgb ?? ink;
  const tintCard = cards.find((card) => chroma(card.rgb) < 0.3 && contrastRatio(card.rgb, ground) >= 1.06 && contrastRatio(card.rgb, ground) <= 1.7);
  const tint = tintCard?.rgb ?? mixRgb(ground, darkGround ? [255, 255, 255] : ink, darkGround ? 0.1 : 0.09);
  const primary = hues[0]?.rgb ?? deep;
  const secondary = hues[1]?.rgb ?? (hues[0] ? mixRgb(hues[0].rgb, ground, 0.45) : mixRgb(deep, ground, 0.5));
  return { ground, ink, muted, primary, secondary, deep, tint };
}

/** Width of a line of text at a size, measured in the real face once it has loaded. */
function measurer(family: string | null, weight: string | number): (text: string, size: number) => number {
  const canvas = typeof document !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  const face = firstFamily(family);
  const em = SERIF.test(face) && !/sans/i.test(face) ? 0.52 : MONO.test(face) ? 0.62 : 0.57;
  return (text, size) => {
    if (canvas && family) {
      canvas.font = weight + ' ' + size + 'px ' + family;
      const width = canvas.measureText(text).width;
      if (width > 0) return width;
    }
    // A fallback face can run a fifth wider; CJK glyphs fill the em.
    let units = 0;
    for (const char of text) units += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 1 : /\s/.test(char) ? 0.28 : /[A-Z0-9]/.test(char) ? em * 1.18 : em;
    return units * size * 1.08;
  };
}

/**
 * From 120px down to 64px, the largest size at which the name's longest line fits its 440px zone,
 * breaking only at a space or hyphen it already has, two lines at most. A name too wide even then
 * takes the band skeleton: blocks across the top, the name beneath on the full width.
 */
function layoutName(name: string, measure: (text: string, size: number) => number): NameLayout {
  for (let size = NAME_MAX; size >= NAME_MIN; size -= 2) if (measure(name, size) <= ZONE) return { lines: [name], size, band: false };
  const breaks = Array.from(name.matchAll(/[\s-]/g)).map((match) => match.index ?? 0).filter((index) => index > 0 && index < name.length - 1);
  // Two lines plus the tagline must fit the cover's height with a step of air above.
  const twoLineMax = Math.floor((H - 44 - TAGLINE - 18 - 40) / 1.9);
  let best: NameLayout | null = null;
  for (const at of breaks) {
    const lines = [name.slice(0, at + (name[at] === '-' ? 1 : 0)).trim(), name.slice(at + 1).trim()];
    for (let size = Math.min(NAME_MAX, twoLineMax); size >= NAME_MIN; size -= 2) {
      if (Math.max(...lines.map((line) => measure(line, size))) <= ZONE) {
        if (!best || size > best.size) best = { lines, size, band: false };
        break;
      }
    }
  }
  if (best) return best;
  let size = 64;
  while (size > 28 && measure(name, size) > W - LEFT * 2) size -= 2;
  return { lines: [name], size, band: true };
}

function fitLine(text: string, width: number, size: number, measure: (text: string, size: number) => number): string {
  if (!text || measure(text, size) <= width) return text;
  let cut = text.length;
  while (cut > 1 && measure(text.slice(0, cut) + '…', size) > width) cut -= 1;
  return text.slice(0, cut).trimEnd() + '…';
}

/** The first sentence of the intro, as one quiet line. */
function taglineOf(intro: string): string {
  const paragraph = intro.split(/\n\s*\n/).find((part) => part.trim()) ?? '';
  const plain = paragraph.split('\n').map((line) => line.replace(/^\s*>\s?/, '').trim()).filter(Boolean).join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|\*|`/g, '').trim();
  // A CJK stop ends a sentence by itself; a Latin one only before a space or the end.
  return (/^.+?(?:[。！？]|[.!?](?=\s|$))/.exec(plain)?.[0] ?? plain).trim();
}

/** Blocks and one pattern in the zone right of x = 480, arranged the way each kind of system composes. */
function blocks(style: CoverStyle, c: Colours, r: number): ReactNode {
  const fill = (rgb: Rgb) => css(rgb);
  const rule = css(mixRgb(c.tint, c.deep, 0.32));
  switch (style) {
    // Editorial, "borders not shadows": a tall slab with satellites, a few hairlines crossing a tint.
    case 'editorial': {
      const tile = { x: 556, y: 44, w: 184, h: 168 };
      const cells = [1, 2, 3].map((step) => step / 4);
      return <>
        <rect x={812} y={-r} width={200} height={H + r * 2} rx={r} fill={fill(c.deep)} />
        <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h} rx={Math.min(r, 6)} fill={fill(c.tint)} />
        <g stroke={rule} strokeWidth={1} fill="none">
          <rect x={tile.x + 14.5} y={tile.y + 14.5} width={tile.w - 29} height={tile.h - 29} />
          {cells.map((part) => <line key={'v' + part} x1={tile.x + 14.5 + (tile.w - 29) * part} y1={tile.y + 14.5} x2={tile.x + 14.5 + (tile.w - 29) * part} y2={tile.y + tile.h - 14.5} />)}
          {cells.map((part) => <line key={'h' + part} x1={tile.x + 14.5} y1={tile.y + 14.5 + (tile.h - 29) * part} x2={tile.x + tile.w - 14.5} y2={tile.y + 14.5 + (tile.h - 29) * part} />)}
        </g>
        <rect x={632} y={-8} width={14} height={204} fill={fill(c.secondary)} />
        <rect x={704} y={168} width={84} height={84} rx={Math.min(r, 4)} fill={fill(c.primary)} />
      </>;
    }
    // Precise, mono, a 4px grid: modular tiles with a dot field at one spacing step.
    case 'technical': {
      const tiles: [number, number, number, number, Rgb][] = [
        [624, 32, 80, 80, c.tint], [712, 32, 168, 80, c.primary], [888, 32, 120, 80, c.tint],
        [624, 120, 80, 136, c.deep], [712, 120, 80, 80, c.tint], [800, 120, 80, 136, c.secondary],
        [888, 120, 120, 136, c.tint], [712, 208, 80, 48, c.primary],
      ];
      const dots: ReactNode[] = [];
      for (let column = 0; column < 4; column += 1) for (let row = 0; row < 10; row += 1) dots.push(<circle key={column + '-' + row} cx={512 + column * 24} cy={36 + row * 24} r={1.8} fill={fill(c.deep)} opacity={0.5} />);
      return <>
        {dots}
        {tiles.map(([x, y, w, h, rgb], index) => <rect key={index} x={x} y={y} width={w} height={h} rx={Math.min(r, 6)} fill={fill(rgb)} />)}
      </>;
    }
    // Soft, friendly, large radii: discs, pills and a half-round cut from the radius scale.
    case 'soft':
      return <>
        <circle cx={872} cy={92} r={132} fill={fill(c.primary)} />
        <rect x={540} y={180} width={272} height={76} rx={38} fill={fill(c.tint)} />
        {[0, 1, 2, 3, 4].map((index) => <circle key={index} cx={580 + index * 36} cy={218} r={7} fill={fill(c.deep)} opacity={index === 0 ? 1 : 0.28} />)}
        <circle cx={640} cy={92} r={46} fill={fill(c.deep)} />
        <rect x={704} y={40} width={104} height={44} rx={22} fill={fill(c.secondary)} />
        <path d={`M 848 ${H} a 68 68 0 0 1 136 0 Z`} fill={fill(c.secondary)} />
      </>;
    // Geometric, modular UI: tiles cut by the radius tokens, one merged two-wide, a row of small units.
    default:
      return <>
        <rect x={520} y={32} width={184} height={136} rx={r} fill={fill(c.primary)} />
        <rect x={716} y={32} width={124} height={136} rx={r} fill={fill(c.tint)} />
        <rect x={852} y={32} width={140} height={224} rx={r} fill={fill(c.deep)} />
        <rect x={520} y={180} width={320} height={76} rx={r} fill={fill(c.tint)} />
        {[0, 1, 2, 3, 4, 5].map((index) => <rect key={index} x={544 + index * 30} y={210} width={16} height={16} rx={Math.min(r, 4)} fill={fill(index === 2 ? c.primary : c.secondary)} />)}
      </>;
  }
}

/** The band skeleton: unequal blocks across the top, for a name too wide for its zone. */
function band(c: Colours, r: number): ReactNode {
  const widths = [0.3, 0.1, 0.24, 0.07, 0.29];
  const fills = [c.primary, c.tint, c.deep, c.secondary, c.tint];
  let x = 0;
  return widths.map((part, index) => {
    const width = part * W;
    const node = <rect key={index} x={x} y={index % 2 ? 0 : -r} width={width - 8} height={BAND + (index % 2 ? 0 : r)} rx={index % 2 ? 0 : r} fill={css(fills[index]!)} />;
    x += width;
    return node;
  });
}

export function StudioCover({ name, intro, tokens, scope, notes, chinese }: {
  name: string; intro: string; tokens: StudioToken[]; scope: string; notes: StudioDocument['tokenNotes']; chinese: boolean;
}) {
  const traits = useMemo(() => readTraits(tokens, scope), [tokens, scope]);
  const colours = useMemo(() => readColours(tokens, scope, notes, chinese), [tokens, scope, notes, chinese]);
  // Web fonts land after the first paint and measure differently from the fallback; re-measure then.
  const [fontsLoaded, setFontsLoaded] = useState(0);
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? null : document.fonts;
    if (!fonts) return undefined;
    let live = true;
    const bump = () => { if (live) setFontsLoaded((value) => value + 1); };
    fonts.addEventListener('loadingdone', bump);
    void fonts.ready.then(bump);
    return () => { live = false; fonts.removeEventListener('loadingdone', bump); };
  }, []);
  const weight = traits.weight ?? (traits.style === 'editorial' ? 500 : 600);
  const layout = useMemo(() => layoutName(name, measurer(traits.display, weight)), [name, traits.display, weight, fontsLoaded]);
  const height = layout.band ? BAND_H : H;
  const tagline = useMemo(() => fitLine(taglineOf(intro), layout.band ? W - LEFT * 2 : ZONE, TAGLINE, measurer(traits.body, 400)), [intro, layout.band, traits.body, fontsLoaded]);
  const taglineY = height - 44;
  const lastBaseline = tagline ? taglineY - TAGLINE - 18 : taglineY;
  const lead = layout.size * (layout.lines.length > 1 ? 0.95 : 0.92);

  return <figure className={styles.cover} style={{ backgroundColor: css(colours.ground) }} data-testid="studio-overview-cover" data-cover-style={traits.style}>
    <svg className={styles.art} viewBox={`0 0 ${W} ${height}`} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <rect width={W} height={height} fill={css(colours.ground)} />
      {layout.band ? band(colours, traits.radius) : blocks(traits.style, colours, traits.radius)}
      <text
        x={LEFT}
        fill={css(colours.ink)}
        fontSize={layout.size}
        fontWeight={weight}
        style={{ fontFamily: traits.display ?? undefined, letterSpacing: traits.tracking ?? (traits.style === 'editorial' ? '-0.01em' : '-0.03em') }}
      >
        {layout.lines.map((line, index) => <tspan key={index} x={LEFT} y={lastBaseline - (layout.lines.length - 1 - index) * lead}>{line}</tspan>)}
      </text>
      {tagline && <text x={LEFT} y={taglineY} fill={css(colours.muted)} fontSize={TAGLINE} style={{ fontFamily: traits.body ?? undefined }}>{tagline}</text>}
    </svg>
  </figure>;
}
