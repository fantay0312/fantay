// The colour board: every colour token is a physical, measured card, and one card at a time opens
// into its tints. A tint opens like a card too: the card's own details fold into a spine on the left
// and the tint takes the room, with its own values. Clicks report which token is selected; the
// tumbling mark rests in the free space of whatever is open, never over the tints.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { VisuallyHidden } from '@open-design/components';
import type { StudioDocument, StudioToken } from '@open-design/contracts';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { cmykOf, paletteRows, parseStudioColor, relativeLuminance, studioPalette, type DistinctCard, type Palette, type PaletteCard, type PaletteStep, type PaletteTier } from '../runtime/studio-palette';
import { StudioColorMark, type StudioColorMarkTarget } from './StudioColorMark';
import styles from './StudioColorBoard.module.css';

interface Columns { foundation: number; role: number; detail: number }
// Seven roles fit one row, as on the reference board, so every tier reads as a single line.
const WIDE: Columns = { foundation: 3, role: 7, detail: 9 };
const COPIED_MS = 1100;
const ACCENT_TOKEN = /(^|-)(accent|primary|brand)(-|$)/;
// Past these luminances a card would dissolve into a white page, or into the dark app theme.
const LIGHT_EDGE = 0.78;
const DARK_EDGE = 0.012;

function columnsFor(width: number): Columns {
  if (width >= 960) return WIDE;
  if (width >= 640) return { foundation: 3, role: 4, detail: 6 };
  if (width >= 480) return { foundation: 3, role: 3, detail: 4 };
  return { foundation: 2, role: 2, detail: 3 };
}
const sameColumns = (a: Columns, b: Columns) => a.foundation === b.foundation && a.role === b.role && a.detail === b.detail;

function needsEdge(card: PaletteCard): boolean {
  if (!card.rgb) return true;
  const luminance = relativeLuminance(card.rgb);
  return luminance >= LIGHT_EDGE || luminance <= DARK_EDGE;
}
/** The card that is open before anyone touches the board: the accent, or the first measurable colour. */
function defaultCard(cards: PaletteCard[]): string | null {
  const measured = cards.filter((card) => card.hex);
  return (measured.find((card) => card.tier === 'foundation' && ACCENT_TOKEN.test(card.name))
    ?? measured.find((card) => card.tier === 'role')
    ?? measured[0]
    ?? cards[0])?.name ?? null;
}
/** The board's count is colours; when tokens repeat a value, the token count follows it. */
function legend({ distinctCounts: counts, distinct, cards }: Palette, chinese: boolean): [string, string] {
  const tiers: [number, string, string][] = [[counts.foundation, '基底', 'foundation'], [counts.role, '角色', 'role'], [counts.detail, '细节', 'detail']];
  const present = tiers.filter(([count]) => count > 0);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const repeated = distinct.length !== cards.length;
  if (chinese) return [`${distinct.length} 色${repeated ? ` · ${cards.length} 变量` : ''}`, present.map(([count, zh]) => `${count} ${zh}`).join(' · ')];
  return [`${plural(distinct.length, 'colour')}${repeated ? ` · ${plural(cards.length, 'token')}` : ''}`, present.map(([count, , en]) => plural(count, en)).join(', ')];
}
/** The card that shows a token: its own, or the one whose colour it repeats. */
function ownerOf(cards: DistinctCard[], name: string): DistinctCard | null {
  return cards.find((card) => card.name === name) ?? cards.find((card) => card.aliases.includes(name)) ?? null;
}
function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Hex, RGB and CMYK of one tint, the same three lines a card prints for itself. */
function stepValues(step: PaletteStep): { hex: string; rgb: string; cmyk: string } {
  const rgb = parseStudioColor(step.color)?.rgb;
  return {
    hex: step.color.replace(/^#/, '').toUpperCase(),
    rgb: rgb ? rgb.map((channel) => Math.round(channel)).join(' ') : '—',
    cmyk: rgb ? cmykOf(rgb).join(' ') : '—',
  };
}

function StepButton({ step, cardLabel, active, chinese, focusable, onPick, onBack, onCopied }: {
  step: PaletteStep; cardLabel: string; active: boolean; chinese: boolean; focusable: boolean;
  onPick: (percent: number) => void; onBack: () => void; onCopied: (hex: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const values = stepValues(step);
  // The first click opens the tint like a card; a click on the open tint copies it.
  const press = async () => {
    if (!active) { onPick(step.percent); return; }
    if (!await copyToClipboard(step.color)) return;
    setCopied(true);
    onCopied(step.color);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); onBack(); }
  };
  const label = active
    ? (chinese ? `复制 ${cardLabel} ${step.percent}% 色阶 ${step.color}` : `Copy ${cardLabel} ${step.percent}% tint ${step.color}`)
    : (chinese ? `查看 ${cardLabel} ${step.percent}% 色阶 ${step.color}` : `Open ${cardLabel} ${step.percent}% tint ${step.color}`);
  return (
    <button
      type="button"
      className={styles.step}
      style={{ backgroundColor: step.color, color: step.ink }}
      tabIndex={focusable ? 0 : -1}
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      data-copied={copied || undefined}
      data-mark-zone={'step-' + step.percent}
      onClick={() => void press()}
      onKeyDown={keys}
    >
      <span className={styles.stepTop} data-mark-ceiling="">
        <span className={styles.stepValue}>{step.percent}</span>
        <span className={styles.stepUnit}>%</span>
        <svg className={styles.stepCheck} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 6.4 5 8.8l4.5-5.3" /></svg>
      </span>
      <span className={styles.stepHex}>{values.hex}</span>
      <dl className={styles.stepDetail} data-mark-floor="" aria-hidden={!active}>
        <div className={styles.footRow}><dt className={styles.footLabel}>Hex</dt><dd className={styles.footValue}>{values.hex}</dd></div>
        <div className={styles.footRow}><dt className={styles.footLabel}>RGB</dt><dd className={styles.footValue}>{values.rgb}</dd></div>
        <div className={styles.footRow}><dt className={styles.footLabel}>CMYK</dt><dd className={styles.footValue}>{values.cmyk}</dd></div>
        <div className={styles.stepHint}>{copied ? (chinese ? '已复制' : 'Copied') : (chinese ? '点击复制' : 'Click to copy')}</div>
      </dl>
    </button>
  );
}

function StepStrip({ card, open, active, chinese, onPick, onBack, onCopied }: {
  card: PaletteCard; open: boolean; active: number | null; chinese: boolean;
  onPick: (percent: number) => void; onBack: () => void; onCopied: (hex: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Set by hand: React 18 has no `inert` prop, and the attribute must also survive React 19.
  useLayoutEffect(() => { stripRef.current?.toggleAttribute('inert', !open); }, [open]);
  return (
    <div ref={stripRef} className={styles.steps} data-palette-steps="" aria-hidden={!open}>
      {card.steps.map((step) => <StepButton key={step.percent} step={step} cardLabel={card.label} active={active === step.percent} chinese={chinese} focusable={open} onPick={onPick} onBack={onBack} onCopied={onCopied} />)}
    </div>
  );
}

function Foot({ card, chinese }: { card: DistinctCard; chinese: boolean }) {
  if (!card.hex) return <p className={styles.raw} data-mark-floor="">{card.value || '—'}</p>;
  const rows: [string, string | null][] = [['RGB', card.rgbText], ['CMYK', card.cmykText]];
  const names = [card.name, ...card.aliases];
  return (
    <dl className={styles.foot} data-mark-floor="">
      <div className={styles.footRow + ' ' + styles.footToken}>
        <dt className={styles.footLabel}>{chinese ? '变量' : 'Token'}</dt>
        <dd className={styles.footValue} title={names.join('\n')}>{names.map((name) => name.replace(/^--/, '')).join(' · ')}</dd>
      </div>
      <div className={styles.footRow}>
        <dt className={styles.footLabel}>Hex</dt>
        <dd className={styles.footValue}>{card.hex}{card.alpha < 1 && <span className={styles.alpha}>{Math.round(card.alpha * 100)}%</span>}</dd>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className={styles.footRow}>
          <dt className={styles.footLabel}>{label}</dt>
          <dd className={styles.footValue}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Card({ card, open, step, chinese, onToggle, onStep, onCopied }: {
  card: DistinctCard; open: boolean; step: number | null; chinese: boolean;
  onToggle: (name: string) => void; onStep: (percent: number | null) => void; onCopied: (hex: string) => void;
}) {
  const small = card.tier === 'detail';
  const stepping = open && step !== null;
  const classes = [styles.card, small && styles.small, open && styles.open, stepping && styles.stepping, needsEdge(card) && styles.edge].filter(Boolean).join(' ');
  const back = chinese ? `返回 ${card.label}` : `Back to ${card.label}`;
  return (
    <div
      className={classes}
      style={card.hex ? { backgroundColor: `#${card.hex}`, color: card.ink } : { background: card.value || undefined, color: card.ink }}
      data-palette-card={card.name}
      data-palette-aliases={card.aliases.length ? card.aliases.join(' ') : undefined}
    >
      {/* With a tint open, the folded card is a spine, and a press on it brings the card back. */}
      <button type="button" className={styles.hit} aria-pressed={open} aria-label={stepping ? back : `${card.label} ${card.hex ?? card.value}`.trim()} title={stepping ? back : card.name} onClick={() => (stepping ? onStep(null) : onToggle(card.name))} />
      <div className={styles.copy} data-mark-zone="card">
        <div className={styles.copyInner}>
          <div className={styles.lead} data-mark-ceiling="">
            <header className={styles.head}>
              <h3 className={styles.name}>{card.label}</h3>
              <span className={styles.number}>{card.number}</span>
            </header>
            {!small && card.note && <p className={styles.note}>{card.note}</p>}
          </div>
          <Foot card={card} chinese={chinese} />
        </div>
      </div>
      <span className={styles.spine} aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="m10 4-4 4 4 4" /></svg>
        <span className={styles.spineLabel}>{card.label}</span>
      </span>
      {card.steps.length > 0 && <StepStrip card={card} open={open} active={open ? step : null} chinese={chinese} onPick={(percent) => onStep(percent)} onBack={() => onStep(null)} onCopied={onCopied} />}
    </div>
  );
}

export function StudioColorBoard({ tokens, scope, notes, chinese, selected, onSelect }: {
  tokens: StudioToken[]; scope: string; notes: StudioDocument['tokenNotes']; chinese: boolean;
  selected: string | null; onSelect: (name: string | null) => void;
}): JSX.Element {
  const palette = useMemo(() => studioPalette(tokens, scope, notes, chinese), [tokens, scope, notes, chinese]);
  // One card per colour: tokens that repeat a value join the first card that shows it.
  const cards = palette.distinct;
  const hasCards = cards.length > 0;
  const boardRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(WIDE);
  const [copiedHex, setCopiedHex] = useState('');
  // Each copy makes the mark hop for joy; the count only has to change.
  const [cheers, setCheers] = useState(0);
  // undefined means nobody has chosen yet, so the default card shows; null means the user closed it.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  // The open tint belongs to one card; opening another card leaves it behind.
  const [stepPick, setStepPick] = useState<{ card: string; percent: number } | null>(null);
  // A token chosen elsewhere may be an alias; its colour's card is the one that opens.
  const named = selected !== null ? ownerOf(cards, selected)?.name ?? null : null;
  if (named !== null && named !== picked) setPicked(named);
  const pickedCard = typeof picked === 'string' ? ownerOf(cards, picked) : null;
  const known = picked === null || pickedCard !== null;
  const open = named ?? (picked !== undefined && known ? pickedCard?.name ?? null : defaultCard(cards));
  const openCard = cards.find((card) => card.name === open) ?? null;
  const openStep = stepPick && stepPick.card === open && openCard?.steps.some((step) => step.percent === stepPick.percent) ? stepPick.percent : null;

  // A deep link scrolls its card into view; a click on a card is already where the user is looking.
  const clicked = useRef<string | null>(null);
  const appeared = useRef(false);
  useEffect(() => {
    const instant = !appeared.current;
    appeared.current = true;
    if (named !== null && named !== clicked.current) {
      const card = Array.from(boardRef.current?.querySelectorAll<HTMLElement>('[data-palette-card]') ?? []).find((element) => element.dataset.paletteCard === named);
      card?.scrollIntoView?.({ block: 'center', behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
    }
    // A card chosen here opens the token dock over the bottom of the page; the card moves up clear of it.
    if (named !== null && named === clicked.current) {
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
        const board = boardRef.current;
        const card = Array.from(board?.querySelectorAll<HTMLElement>('[data-palette-card]') ?? []).find((element) => element.dataset.paletteCard === named);
        const scroller = board?.closest<HTMLElement>('[data-studio-scroll]');
        const dock = scroller?.querySelector<HTMLElement>('[data-studio-dock][data-open] > section');
        if (!card || !scroller || !dock) return;
        const overlap = card.getBoundingClientRect().bottom - (dock.getBoundingClientRect().top - 16);
        if (overlap > 0) scroller.scrollBy?.({ top: overlap, behavior: reducedMotion() ? 'auto' : 'smooth' });
      }));
      clicked.current = null;
      return () => cancelAnimationFrame(frame);
    }
    clicked.current = null;
    return undefined;
  }, [named]);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || typeof ResizeObserver !== 'function') return;
    const measure = (width: number) => {
      if (width > 0) setColumns((current) => { const next = columnsFor(width); return sameColumns(current, next) ? current : next; });
    };
    measure(board.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? 0));
    observer.observe(board);
    return () => observer.disconnect();
  }, [hasCards]);

  // Written to the DOM, not state: the first open card must paint settled without a re-render.
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || typeof requestAnimationFrame !== 'function') return;
    board.dataset.motion = 'off';
    const frame = requestAnimationFrame(() => { delete board.dataset.motion; });
    return () => cancelAnimationFrame(frame);
  }, [hasCards]);

  const toggle = (name: string) => {
    // The card open by default has no dock yet, so its first click selects it rather than closing it.
    const next = named === name ? null : name;
    clicked.current = next;
    setPicked(next);
    setStepPick(null);
    onSelect(next);
  };
  // A tint is not a token, so opening one leaves the selection (and the token dock) as it was.
  const step = (percent: number | null) => {
    if (!open) return;
    if (picked === undefined) setPicked(open);
    setStepPick(percent === null ? null : { card: open, percent });
  };
  const copied = (hex: string) => { setCopiedHex(hex); setCheers((count) => count + 1); };
  const rows = useMemo(() => {
    const ofTier = (tier: PaletteTier) => paletteRows(cards.filter((card) => card.tier === tier), columns[tier]).map((row, index) => ({ key: `${tier}-${index}`, tier, cards: row }));
    return [...ofTier('foundation'), ...ofTier('role'), ...ofTier('detail')];
  }, [cards, columns]);
  // With a tint open the mark wears that tint, the colour whose values are printed under it.
  const target = useMemo<StudioColorMarkTarget | null>(() => {
    if (!openCard) return null;
    const tint = openStep === null ? null : openCard.steps.find((item) => item.percent === openStep);
    return { name: openCard.name, tier: openCard.tier, hex: tint ? tint.color.replace(/^#/, '') : openCard.hex, zone: tint ? 'step-' + openStep : 'card' };
  }, [openCard, openStep]);
  const [total, breakdown] = legend(palette, chinese);

  if (!hasCards) return <></>;
  return (
    <div ref={boardRef} className={styles.board}>
      <div className={styles.mast}>
        <p className={styles.legend}><span>{total}</span><span className={styles.legendParts}>{breakdown}</span></p>
      </div>
      <div className={styles.rows}>
        {rows.map((row) => (
          <section key={row.key} className={`${styles.row} ${row.tier === 'foundation' ? styles.foundation : ''}`}>
            {row.cards.map((card) => <Card key={card.name} card={card} open={card.name === open} step={card.name === open ? openStep : null} chinese={chinese} onToggle={toggle} onStep={step} onCopied={copied} />)}
          </section>
        ))}
      </div>
      <StudioColorMark target={target} cheer={cheers} layoutKey={`${columns.role}/${columns.detail}/${columns.foundation}`} />
      <VisuallyHidden role="status">{copiedHex && (chinese ? `已复制 ${copiedHex}` : `Copied ${copiedHex}`)}</VisuallyHidden>
    </div>
  );
}
