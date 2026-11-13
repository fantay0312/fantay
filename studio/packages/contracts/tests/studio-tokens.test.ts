import { describe, expect, it } from 'vitest';
import { editStudioToken, isStudioPackageAsset, parseStudioTokens, studioTokenCssProperty, studioTokenValueSupported } from '../src/design-systems/studio-tokens.js';

describe('design system source editing', () => {
  it('edits the selected theme without touching comments, selectors or other themes', () => {
    const css = '/* keep --color: red; */\n:root { --color: #ffffff; --space-md: 16px; }\n[data-theme="dark"] { --color: #000000; }';
    const tokens = parseStudioTokens(css);
    expect(tokens.map((token) => [token.name, token.group])).toEqual([['--color', 'colors'], ['--space-md', 'spacing'], ['--color', 'colors']]);
    expect(editStudioToken(css, tokens[2]!, '--color', '#111111')).toBe(css.replace('#000000', '#111111'));
    expect(() => editStudioToken(css.replace('#000000', '#222222'), tokens[2]!, '--color', '#111111')).toThrow('TOKEN_CONFLICT');
  });
  it('keeps quoted delimiters and nested functions intact', () => {
    const css = ':root { --font-body: "a;b"; --space-md: calc(8px + var(--unit)); --shadow: 0 2px 4px rgb(0 0 0 / .2); }';
    const tokens = parseStudioTokens(css);
    expect(tokens).toHaveLength(3);
    expect(tokens[0]?.value).toBe('"a;b"');
    expect(tokens[1]?.value).toBe('calc(8px + var(--unit))');
    expect(tokens[2]?.group).toBe('shadows');
  });
  it('adds a root declaration without rewriting existing CSS and rejects injected syntax', () => {
    const css = '@media (prefers-color-scheme: dark) { :root { --color: black; } }';
    expect(editStudioToken(css, null, '--radius-sm', '4px')).toContain(css);
    expect(() => editStudioToken(css, null, '--x', 'red; display:none')).toThrow('INVALID_TOKEN_VALUE');
    expect(() => editStudioToken(css, null, 'color', 'red')).toThrow('INVALID_TOKEN_NAME');
  });
  it('keeps private metadata, traversal and hidden files out of public package sync', () => {
    for (const file of ['tokens.css', 'components.html', 'fonts/brand.woff2', 'assets/studio/logo.png']) expect(isStudioPackageAsset(file)).toBe(true);
    for (const file of ['DESIGN.md', 'open-design.json', '.env', 'assets/../.env', 'assets/.env', '../tokens.css', 'assets\\secret']) expect(isStudioPackageAsset(file)).toBe(false);
  });
  it('files sizes, targets, icon sizes and aspect ratios under sizing, and line lengths under measure', () => {
    const css = ':root { --size-4: 16px; --base-size-8: 8px; --control-height-md: 40px; --target-min: 24px; --icon-size-sm: 16px; --aspect-video: 16 / 9; --ratio-square: 1; --measure-prose: 65ch; --font-size-sm: 14px; --space-sm: 8px; --icon-color: #333333; }';
    expect(parseStudioTokens(css).map((token) => [token.name, token.group])).toEqual([
      ['--size-4', 'sizing'], ['--base-size-8', 'sizing'], ['--control-height-md', 'sizing'], ['--target-min', 'sizing'], ['--icon-size-sm', 'sizing'],
      ['--aspect-video', 'sizing'], ['--ratio-square', 'sizing'], ['--measure-prose', 'measure'], ['--font-size-sm', 'typography'], ['--space-sm', 'spacing'], ['--icon-color', 'colors'],
    ]);
    expect(studioTokenCssProperty('sizing', '--aspect-video')).toBe('aspect-ratio');
    // Every target is a size; a control, icon or avatar token only when it names no other property.
    expect(parseStudioTokens(':root { --target-comfort: 44px; --touch-target: 44px; --control-small-paddingInline-normal: 8px; --control-xsmall-gap: 4px; --control-xlarge-size: 48px; --avatar-xs-font-size: 10px; --icon-sm: 16px; --icon-color: #333333; }').map((token) => [token.name, token.group])).toEqual([
      ['--target-comfort', 'sizing'], ['--touch-target', 'sizing'], ['--control-small-paddingInline-normal', 'spacing'], ['--control-xsmall-gap', 'spacing'], ['--control-xlarge-size', 'sizing'], ['--avatar-xs-font-size', 'typography'], ['--icon-sm', 'sizing'], ['--icon-color', 'colors'],
    ]);
    // A size may be negative, which width refuses.
    const supports = (property: string, value: string) => property === 'margin-top' || !value.startsWith('-');
    expect(studioTokenValueSupported('sizing', '--size-000', '-.5rem', supports)).toBe(true);
    expect(studioTokenValueSupported('spacing', '--space-x', '-.5rem', supports)).toBe(false);
    expect(studioTokenCssProperty('sizing', '--target-min')).toBe('width');
  });
  it('recognizes typography sizes separately from text colors', () => {
    expect(parseStudioTokens(':root { --text-xs: 12px; --text-4xl: 40px; --text-muted: #666666; }').map((token) => token.group)).toEqual(['typography', 'typography', 'colors']);
  });
});
