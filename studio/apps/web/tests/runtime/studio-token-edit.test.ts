import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStudioTokens } from '@open-design/contracts';
import { applyStudioTokenEdit, removeStudioTokenEverywhere, studioTokenEditMessage, studioTokenScopeLabel, studioTokenScopes } from '../../src/runtime/studio-token-edit';

const css = ':root { --bg: #ffffff; --fg: #111111; --accent: var(--fg); }\n[data-theme="dark"] { --bg: #000000; }';
const dark = '[data-theme="dark"]';
const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } return null; };

afterEach(() => vi.unstubAllGlobals());

describe('applyStudioTokenEdit', () => {
  it('rewrites the value in its own scope and leaves other themes alone', () => {
    const next = applyStudioTokenEdit(css, '--bg', '#fafafa', ':root', 'colors');
    expect(parseStudioTokens(next!).filter((token) => token.name === '--bg').map((token) => token.value)).toEqual(['#fafafa', '#000000']);
  });
  it('returns null when nothing changed, ignoring surrounding space', () => {
    expect(applyStudioTokenEdit(css, '--bg', '  #ffffff ', ':root', 'colors')).toBeNull();
    expect(applyStudioTokenEdit(css, '--fg', '', dark, 'colors')).toBeNull();
  });
  it('adds an override for a theme that has none', () => {
    const next = applyStudioTokenEdit(css, '--fg', '#eeeeee', dark, 'colors');
    expect(parseStudioTokens(next!)).toContainEqual(expect.objectContaining({ name: '--fg', value: '#eeeeee', scope: dark }));
  });
  it('clears an override back to inheritance', () => {
    const next = applyStudioTokenEdit(css, '--bg', '', dark, 'colors');
    expect(parseStudioTokens(next!).filter((token) => token.name === '--bg')).toEqual([expect.objectContaining({ value: '#ffffff', scope: ':root' })]);
  });
  it('refuses to empty the base value', () => {
    expect(code(() => applyStudioTokenEdit(css, '--bg', '', ':root', 'colors'))).toBe('BASE_REQUIRED');
  });
  it('refuses an alias that resolves to nothing or to itself', () => {
    expect(code(() => applyStudioTokenEdit(css, '--accent', 'var(--missing)', ':root', 'colors'))).toBe('ALIAS');
    expect(code(() => applyStudioTokenEdit(css, '--fg', 'var(--accent)', ':root', 'colors'))).toBe('ALIAS');
  });
  it('accepts an alias that resolves', () => {
    expect(applyStudioTokenEdit(css, '--accent', 'var(--bg)', ':root', 'colors')).toContain('--accent: var(--bg)');
  });
  it('asks the browser with the property the group maps to', () => {
    const supports = vi.fn(() => false);
    vi.stubGlobal('CSS', { supports });
    expect(code(() => applyStudioTokenEdit(':root { --radius-sm: 4px; }', '--radius-sm', 'nope', ':root', 'radius'))).toBe('INVALID');
    expect(supports).toHaveBeenCalledWith('border-radius', 'nope');
  });
  it('reports values the contract refuses as invalid', () => {
    expect(code(() => applyStudioTokenEdit(css, '--bg', 'red; color: blue', ':root', 'colors'))).toBe('INVALID');
  });
});

describe('removeStudioTokenEverywhere', () => {
  it('removes the token from every theme', () => {
    expect(parseStudioTokens(removeStudioTokenEverywhere(css, '--bg')).map((token) => token.name)).toEqual(['--fg', '--accent']);
  });
  it('refuses while another token references it', () => {
    expect(code(() => removeStudioTokenEverywhere(css, '--fg'))).toBe('REFERENCED');
  });
});

describe('scopes and messages', () => {
  const tokens = parseStudioTokens(css + '\n@media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0.01ms; } }');
  const themes = [{ name: 'Dusk', selector: '[data-theme="dusk"]' }] as Parameters<typeof studioTokenScopes>[2];
  it('offers named themes to colours but not to spacing', () => {
    expect(studioTokenScopes(tokens, 'colors', themes)).toEqual([':root', '[data-theme="dusk"]', dark]);
    expect(studioTokenScopes(tokens, 'spacing', themes)).toEqual([':root']);
  });
  it('adds no empty base field when the base theme is written under another selector', () => {
    const light = parseStudioTokens(':root, .light { --bg: #fff; --space-4: 16px; } .dark { --bg: #000; }');
    const named = [{ name: 'Dark', selector: '.dark' }] as Parameters<typeof studioTokenScopes>[2];
    expect(studioTokenScopes(light, 'colors', [])).toEqual([':root, .light', '.dark']);
    expect(studioTokenScopes(light, 'colors', named)).not.toContain(':root');
    expect(studioTokenScopes(light, 'spacing', named)).toEqual([':root, .light']);
    // Nothing declared anywhere still leaves the base field to add the first value in.
    expect(studioTokenScopes([], 'colors', [])).toEqual([':root']);
  });
  it('names the reduced motion scope instead of printing the media query', () => {
    const scope = tokens.find((token) => token.name === '--motion-fast')!.scope;
    expect(studioTokenScopeLabel(scope, [], true)).toBe('减弱动态');
    expect(studioTokenScopeLabel(scope, [], false)).toBe('Reduced motion');
    expect(studioTokenScopeLabel(dark, [], true)).toBe('深色');
  });
  it('words each refusal, and falls back for a failed save', () => {
    for (const reason of ['INVALID', 'ALIAS', 'BASE_REQUIRED', 'REFERENCED']) expect(studioTokenEditMessage(new Error(reason), false)).not.toContain('Reload');
    expect(studioTokenEditMessage(new Error('network'), true)).toContain('未能保存');
  });
});
