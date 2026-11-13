import { describe, expect, it } from 'vitest';
import { emptyStudioDocument, parseStudioTokens } from '@open-design/contracts';
import { cmykOf, paletteRows, parseStudioColor, studioPalette, studioScopeLabel, studioThemeScopes } from '../../src/runtime/studio-palette';

const css = ':root { --bg: #F3F1EC; --fg: #121211; --accent: #FF5200; --surface: #fff; --muted: #5c5c5c; --border: rgba(0, 0, 0, 0.5); --success: #00aa54; }\n[data-theme="dark"] { --bg: #121211; --fg: #F3F1EC; }';

describe('studio palette', () => {
  it('measures the same CMYK a swatch card prints', () => {
    expect(cmykOf([241, 89, 42])).toEqual([0, 63, 83, 5]);
    expect(cmykOf([47, 107, 235])).toEqual([80, 54, 0, 8]);
    expect(cmykOf([94, 159, 53])).toEqual([41, 0, 67, 38]);
  });
  it('parses the colour syntaxes tokens use, without a browser', () => {
    expect(parseStudioColor('#abc')).toEqual({ rgb: [170, 187, 204], alpha: 1 });
    expect(parseStudioColor('rgb(10 20 30 / 50%)')).toEqual({ rgb: [10, 20, 30], alpha: 0.5 });
    expect(parseStudioColor('hsl(0, 100%, 50%)')?.rgb).toEqual([255, 0, 0]);
    expect(parseStudioColor('not-a-colour')).toBeNull();
  });
  it('orders ground, ink and accent first, then roles, then details, and numbers them', () => {
    const palette = studioPalette(parseStudioTokens(css), ':root', emptyStudioDocument().tokenNotes, true);
    expect(palette.cards.map((card) => [card.number, card.name, card.tier])).toEqual([
      ['01', '--bg', 'foundation'], ['02', '--fg', 'foundation'], ['03', '--accent', 'foundation'],
      ['04', '--surface', 'role'], ['05', '--muted', 'role'],
      ['06', '--border', 'detail'], ['07', '--success', 'detail'],
    ]);
    expect(palette.counts).toEqual({ foundation: 3, role: 2, detail: 2 });
    expect(palette.cards[2]).toMatchObject({ label: '强调', hex: 'FF5200', rgbText: '255 82 0', cmykText: '0 68 100 0' });
  });
  it('sets each card in whichever of ink, paper or white reads best', () => {
    const [ground, ink] = studioPalette(parseStudioTokens(css), ':root', {}, false).cards;
    expect(ground!.ink).toBe('#121211');
    expect(ink!.ink).toBe('#ffffff');
    expect(ground!.steps.map((step) => step.percent)).toEqual([60, 40, 22, 13]);
  });
  it('flattens translucent colours on the ground and follows the chosen theme', () => {
    const light = studioPalette(parseStudioTokens(css), ':root', {}, false);
    expect(light.cards.find((card) => card.name === '--border')!.alpha).toBe(0.5);
    const dark = studioPalette(parseStudioTokens(css), '[data-theme="dark"]', {}, false);
    expect(dark.cards[0]).toMatchObject({ hex: '121211', own: '#121211' });
    expect(dark.cards[2]).toMatchObject({ hex: 'FF5200', own: null });
  });
  it('balances rows so a lone card never fills the last row', () => {
    expect(paletteRows([1, 2, 3, 4, 5, 6, 7], 6).map((row) => row.length)).toEqual([4, 3]);
    expect(paletteRows([1, 2, 3], 6).map((row) => row.length)).toEqual([3]);
    expect(paletteRows([], 6)).toEqual([]);
  });
  it('keeps one card per colour in the chosen theme, with the repeats as aliases', () => {
    const repeated = parseStudioTokens(':root { --bg: #f3f1ec; --color-paper: var(--bg); --fg: #191918; --border: #191918; --line: rgba(25, 25, 24, 0.5); --wash: oklch(70% 0.1 200); --tint: oklch(70% 0.1 200); }\n.dark { --bg: #181916; --color-paper: #272724; }');
    const light = studioPalette(repeated, ':root', {}, true);
    expect(light.cards).toHaveLength(7);
    expect(light.distinct.map((card) => [card.number, card.name, card.aliases])).toEqual([
      ['01', '--bg', ['--color-paper']], ['02', '--fg', ['--border']], ['03', '--wash', []], ['04', '--tint', []], ['05', '--line', []],
    ]);
    expect(light.distinctCounts).toEqual({ foundation: 2, role: 2, detail: 1 });
    expect(light.counts).toEqual({ foundation: 2, role: 3, detail: 2 });
    const dark = studioPalette(repeated, '.dark', {}, true);
    expect(dark.distinct.map((card) => card.name)).toEqual(['--bg', '--fg', '--color-paper', '--wash', '--tint', '--line']);
  });
  it('numbers cards that share a name in the UI language, and keeps stock notes off them', () => {
    const shared = parseStudioTokens(':root { --bg: #fdfdfc; --fg: #191918; --color-ink: var(--fg); --color-accent: #47633f; --accent: #353535; --surface: #ffffff; }\n.dark { --fg: #f6f5ed; --color-ink: #f6f5f0; }');
    const notes: Parameters<typeof studioPalette>[2] = { '--accent': { group: '', layer: 'semantic', description: '主要操作' } };
    const light = studioPalette(shared, ':root', notes, true);
    expect(light.distinct.map((card) => [card.name, card.label, card.note])).toEqual([
      ['--bg', '底色', '页面的底，所有内容落在这里'], ['--fg', '墨色', '标题，以及需要精确的内容'],
      ['--color-accent', '强调', ''], ['--accent', '强调 2', '主要操作'], ['--surface', '表面', '面板与卡片'],
    ]);
    expect(studioPalette(shared, ':root', notes, false).distinct.map((card) => card.label)).toContain('Accent 2');
    // Repeats in one theme can part ways in another, where they need the number.
    expect(studioPalette(shared, '.dark', notes, true).distinct.filter((card) => card.label.startsWith('墨色')).map((card) => [card.name, card.label, card.note]))
      .toEqual([['--fg', '墨色', ''], ['--color-ink', '墨色 2', '']]);
    // A number never lands on a label another card already has.
    const crowded = parseStudioTokens(':root { --accent: #111111; --color-accent: #222222; --accent-2: #333333; }');
    expect(studioPalette(crowded, ':root', {}, false).distinct.map((card) => card.label)).toEqual(['Accent', 'Accent 3', 'Accent 2']);
  });
  it('lists previewable themes and names them', () => {
    const tokens = parseStudioTokens(css);
    expect(studioThemeScopes(tokens, [])).toEqual([':root', '[data-theme="dark"]']);
    // A base theme written under another selector is not shadowed by an empty :root.
    expect(studioThemeScopes(parseStudioTokens(':root, .light { --bg: #fff; } .dark { --bg: #000; }'), [])).toEqual([':root, .light', '.dark']);
    expect(studioThemeScopes(parseStudioTokens('html { --bg: #fff; }'), [])).toEqual(['html']);
    expect(studioThemeScopes([], [])).toEqual([':root']);
    expect(studioThemeScopes(parseStudioTokens('.dark { --bg: #000; } :root { --bg: #fff; }'), [])).toEqual([':root', '.dark']);
    expect(studioScopeLabel('[data-theme="dark"]', [], true)).toBe('深色');
    expect(studioScopeLabel('[data-theme="contrast"]', [{ name: '高对比', selector: '[data-theme="contrast"]', description: '' }], true)).toBe('高对比');
  });
});
