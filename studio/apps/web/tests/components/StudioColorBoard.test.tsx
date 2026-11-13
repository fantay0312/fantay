// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStudioTokens, type StudioToken } from '@open-design/contracts';
import { StudioColorBoard } from '../../src/components/StudioColorBoard';
import { studioMarkReach } from '../../src/components/StudioColorMark';
import { copyToClipboard } from '../../src/lib/copy-to-clipboard';

vi.mock('../../src/lib/copy-to-clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }));

const css = ':root { --bg: #F3F1EC; --fg: #121211; --accent: #FF5200; --surface: #ffffff; --muted: #5c5c5c; --border: rgba(0, 0, 0, 0.5); --success: #00aa54; }\n[data-theme="dark"] { --bg: #121211; --fg: #F3F1EC; }';
const tokens = parseStudioTokens(css);

function board(overrides: Partial<Parameters<typeof StudioColorBoard>[0]> = {}) {
  const onSelect = vi.fn();
  const props = { tokens, scope: ':root', notes: {}, chinese: true, selected: null, onSelect, ...overrides };
  return { onSelect, ...render(<StudioColorBoard {...props} />), props };
}
const card = (name: string | RegExp) => screen.getByRole('button', { name });
const shell = (button: HTMLElement) => button.closest<HTMLElement>('[data-palette-card]')!;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('colour board', () => {
  it('names every card by its label and hex', () => {
    board();
    expect(card('底色 F3F1EC')).toBeTruthy();
    expect(card('强调 FF5200')).toBeTruthy();
    expect(screen.getAllByRole('button', { pressed: false }).map((button) => button.getAttribute('aria-label'))).toContain('描边 7A7976');
  });
  it('opens the accent on mount without reporting a selection', () => {
    const { onSelect } = board();
    expect(card('强调 FF5200').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('shows four tint buttons only on the open card', () => {
    board();
    expect(screen.getAllByRole('button', { name: /^查看 / }).map((button) => button.textContent!.slice(0, 2))).toEqual(['60', '40', '22', '13']);
    const closed = shell(card('底色 F3F1EC')).querySelector<HTMLElement>('[data-palette-steps]')!;
    expect(closed.hasAttribute('inert')).toBe(true);
    expect(within(closed).getAllByRole('button', { hidden: true }).every((button) => button.tabIndex === -1)).toBe(true);
  });
  it('toggles a selected card and reports it, with one card open at a time', () => {
    const onSelect = vi.fn();
    const Controlled = () => {
      const [selected, setSelected] = useState<string | null>(null);
      return <StudioColorBoard tokens={tokens} scope=":root" notes={{}} chinese selected={selected} onSelect={(name) => { onSelect(name); setSelected(name); }} />;
    };
    render(<Controlled />);
    fireEvent.click(card('底色 F3F1EC'));
    expect(onSelect).toHaveBeenLastCalledWith('--bg');
    expect(card('底色 F3F1EC').getAttribute('aria-pressed')).toBe('true');
    expect(card('强调 FF5200').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(card('底色 F3F1EC'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
  });
  it('selects the card that is open by default on the first click, instead of closing it', () => {
    const { onSelect } = board();
    fireEvent.click(card('强调 FF5200'));
    expect(onSelect).toHaveBeenLastCalledWith('--accent');
    expect(card('强调 FF5200').getAttribute('aria-pressed')).toBe('true');
  });
  it('opens a tint like a card, folds the card into a spine, then copies the tint', async () => {
    const { onSelect } = board();
    const step = screen.getByRole('button', { name: /^查看 强调 60% / });
    fireEvent.click(step);
    // A tint is not a token: opening one neither selects its card (no dock) nor copies anything yet.
    expect(onSelect).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(step.getAttribute('aria-pressed')).toBe('true');
    expect(step.textContent).toContain('255 151 102');
    const back = card('返回 强调');
    expect(shell(back).className).toMatch(/stepping/);
    fireEvent.click(screen.getByRole('button', { name: /^复制 强调 60% / }));
    await waitFor(() => expect(step.hasAttribute('data-copied')).toBe(true));
    expect(copyToClipboard).toHaveBeenCalledWith('#FF9766');
    expect(screen.getByRole('status').textContent).toBe('已复制 #FF9766');
    // Another tint takes over; the spine brings the card back.
    fireEvent.click(screen.getByRole('button', { name: /^查看 强调 22% / }));
    expect(step.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(card('返回 强调'));
    expect(screen.queryByRole('button', { pressed: true, name: /色阶/ })).toBeNull();
    expect(card('强调 FF5200').getAttribute('aria-pressed')).toBe('true');
  });
  it('lets the selected prop win and scrolls a deep link into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender, props } = board();
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<StudioColorBoard {...props} selected="--success" />);
    expect(card('成功 00AA54').getAttribute('aria-pressed')).toBe('true');
    expect(card('强调 FF5200').getAttribute('aria-pressed')).toBe('false');
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  it('recolours the same cards when the theme changes', () => {
    const { rerender, props } = board();
    const ground = shell(card('底色 F3F1EC'));
    rerender(<StudioColorBoard {...props} scope={'[data-theme="dark"]'} />);
    expect(shell(card('底色 121211'))).toBe(ground);
  });
  it('keeps the tiers in separate rows and sizes them from the board width', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe() {} disconnect() {} });
    const many = parseStudioTokens(`:root { ${Array.from({ length: 14 }, (_, index) => `--tone-${index}: #${index.toString(16).padStart(2, '0')}2233;`).join(' ')} }`);
    const { container } = board({ tokens: many });
    const rowSizes = () => Array.from(container.querySelectorAll('section')).map((row) => row.querySelectorAll('[data-palette-card]').length);
    const resize = (width: number) => act(() => observers.forEach((notify) => notify([{ contentRect: { width } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver)));
    // Seven roles to a row, as on the reference board, from the first frame.
    expect(rowSizes()).toEqual([7, 7]);
    resize(960);
    expect(rowSizes()).toEqual([7, 7]);
    resize(700);
    expect(rowSizes()).toEqual([4, 4, 3, 3]);
    resize(500);
    expect(rowSizes()).toEqual([3, 3, 3, 3, 2]);
  });
  it('folds tokens that repeat a colour into one card, and keeps every name on it', () => {
    const repeated = parseStudioTokens(':root { --bg: #f3f1ec; --color-paper: #F3F1EC; --fg: #191918; --ink: #191918; --accent: #47633f; --color-accent: #353535; --surface: #ffffff; }\n.dark { --bg: #181916; --color-paper: #272724; }');
    const { rerender, props } = board({ tokens: repeated });
    expect(screen.getByText(/^5 色/).textContent).toBe('5 色 · 7 变量');
    const ground = shell(card('底色 F3F1EC'));
    expect(ground.textContent).toContain('bg · color-paper');
    expect(ground.textContent).toContain('变量');
    expect(screen.queryByRole('button', { name: /^纸面 / })).toBeNull();
    // Two accents with different values both stay; the later one is numbered in the UI language, keeps
    // its token name in the token row, and neither claims to be the only one.
    expect(card('强调 47633F')).toBeTruthy();
    expect(card('强调 2 353535')).toBeTruthy();
    expect(within(shell(card('强调 2 353535'))).getByRole('heading').textContent).toBe('强调 2');
    expect(shell(card('强调 2 353535')).textContent).toContain('color-accent');
    expect(within(shell(card('强调 47633F'))).queryByText('主要操作与需要被注意的地方')).toBeNull();
    expect(screen.queryByText(/^color-accent$/, { selector: 'h3' })).toBeNull();
    // An alias chosen elsewhere opens the card that shows its colour.
    rerender(<StudioColorBoard {...props} tokens={repeated} selected="--color-paper" />);
    expect(card('底色 F3F1EC').getAttribute('aria-pressed')).toBe('true');
    // Merging is per theme: the two part ways in the dark one.
    rerender(<StudioColorBoard {...props} tokens={repeated} scope=".dark" selected={null} />);
    expect(card('底色 181916')).toBeTruthy();
    expect(card('纸面 272724')).toBeTruthy();
  });
  it('rests the mark on the rule above the open card values, clear of the tints and the text', () => {
    // At rest an 84px cube turned 32° reaches 62px right of its anchor, faces in perspective included.
    expect(studioMarkReach({ size: 84, rx: -24, ry: 32, rz: 0 }).right).toBeCloseTo(62.3, 1);
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    // The accent card's details: 484px wide beside its 116px strip, the name and note ending at 116,
    // the rule above the values at 210.
    const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const node = this as HTMLElement;
      const card = node.closest<HTMLElement>('[data-palette-card]')?.dataset.paletteCard;
      if (card !== '--accent') return rect(0, 0, 0, 0);
      if (node.dataset.paletteCard) return rect(500, 40, 600, 250);
      if (node.dataset.markZone === 'card') return rect(500, 40, 484, 250);
      if (node.hasAttribute('data-mark-ceiling') && node.closest('[data-mark-zone="card"]')) return rect(516, 56, 452, 60);
      if (node.hasAttribute('data-mark-floor') && node.closest('[data-mark-zone="card"]')) return rect(516, 210, 452, 70);
      return rect(0, 0, 0, 0);
    });
    try {
      const { container } = board();
      const mark = container.querySelector<HTMLElement>('[data-part="shadow"]')!.parentElement!;
      const [x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(mark.style.transform)!.slice(1).map(Number) as [number, number];
      const size = Number.parseFloat(mark.style.getPropertyValue('--mark-size'));
      const reach = studioMarkReach({ size, rx: -24, ry: 28, rz: 6 });
      // Shrunk to the 80px of free height between the text and the rule, never past it.
      expect(size).toBeLessThanOrEqual(80);
      expect(size).toBeGreaterThan(30);
      expect(y + reach.bottom).toBeCloseTo(210 - 4, 1);
      expect(y + reach.top).toBeGreaterThanOrEqual(116 + 10 - 0.5);
      // Right-aligned in the details, so the tints to its right stay uncovered.
      expect(x + reach.right).toBeCloseTo(984 - 14, 1);
      expect(x + reach.left).toBeGreaterThan(500);
    } finally { measure.mockRestore(); }
  });
  it('shows the raw value when a colour cannot be measured', () => {
    const raw: StudioToken = { name: '--wash', value: 'color-mix(in srgb, red 50%, blue)', scope: ':root', group: 'colors', start: 0, end: 0, valueStart: 0, valueEnd: 0 };
    board({ tokens: [raw] });
    const wash = shell(card(/^Wash /));
    expect(wash.textContent).toContain('color-mix(in srgb, red 50%, blue)');
    expect(wash.textContent).not.toContain('RGB');
    expect(wash.querySelector('[data-palette-steps]')).toBeNull();
  });
  it('prints the alpha of a translucent token beside its hex', () => {
    board();
    expect(shell(card('描边 7A7976')).textContent).toContain('7A797650%');
  });
  it('sums up the board, skipping empty tiers', () => {
    const { rerender, props } = board();
    expect(screen.getByText('7 色').parentElement!.textContent).toBe('7 色3 基底 · 2 角色 · 2 细节');
    rerender(<StudioColorBoard {...props} chinese={false} tokens={parseStudioTokens(':root { --accent: #FF5200; --surface: #fff; }')} />);
    expect(screen.getByText('2 colours').parentElement!.textContent).toBe('2 colours1 foundation, 1 role');
  });
  it('renders nothing without colour tokens, and survives jsdom without ResizeObserver', () => {
    expect(typeof ResizeObserver).toBe('undefined');
    const { container } = board({ tokens: [] });
    expect(container.textContent).toBe('');
    cleanup();
    expect(() => board()).not.toThrow();
  });
});
