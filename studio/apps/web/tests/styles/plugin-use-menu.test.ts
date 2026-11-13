import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readExpandedIndexCss } from '../helpers/read-expanded-css';

const indexCss = readExpandedIndexCss();
const pluginsHomeCss = readFileSync(
  new URL('../../src/styles/home/plugins-home.css', import.meta.url),
  'utf8',
);

const tokensCss = readFileSync(
  new URL('../../../../packages/fantay-tokens/tokens.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

type Theme = 'light' | 'dark';

/** The colour tokens of one theme, straight from the generated token sheet (the source of the menu's `var()`s). */
function themeTokens(theme: Theme): Record<string, string> {
  const block = (
    theme === 'light'
      ? /:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/
      : /\[data-theme="dark"\]\s*\{([^}]*)\}/
  ).exec(tokensCss)?.[1];
  if (!block) throw new Error(`Missing ${theme} token block in packages/fantay-tokens/tokens.css`);
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]!] = m[2]!.trim();
  return tokens;
}

/** Follow `var(--token)` references until a literal colour is left. */
function resolveColor(value: string, tokens: Record<string, string>): string {
  let out = value.trim();
  for (let depth = 0; depth < 6; depth += 1) {
    const ref = /^var\((--[\w-]+)\)$/.exec(out);
    if (!ref) return out;
    const next = tokens[ref[1]!];
    if (!next) throw new Error(`${ref[1]} is not defined in the ${Object.keys(tokens).length}-token theme table`);
    out = next;
  }
  throw new Error(`Token chain too deep for ${value}`);
}

function cssDeclarations(rawCss: string, selector: string): string {
  /*
   * 先剥注释再切规则。`[^{}]+` 会把紧挨在选择器前面的注释一并吞进「选择器」那一段,
   * 而注释里只要有逗号(比如写特异性的 `(0,2,1)`),按 `,` 切出来就没有一片等于
   * 选择器本身了 —— 于是明明规则在,却报 Missing CSS block。
   * `next-step-cascade.test.ts` 里同样先 strip 过。
   */
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(css)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)) {
    throw new Error(`Expected #rgb or #rrggbb, got ${hex}`);
  }
  const expanded = normalized.length === 3
    ? [...normalized].map((char) => `${char}${char}`).join('')
    : normalized;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const first = luminance(hexToRgb(foreground));
  const second = luminance(hexToRgb(background));
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('plugin use menu contrast', () => {
  it('keeps option text readable on hover and keyboard focus in both themes', () => {
    /*
     * 全局那条按钮 hover 现在包在 `:where()` 里、特异性为 0(见
     * `tests/styles/button-hover-default.test.ts` 的原委),所以「必须压过它」
     * 这个判据没有对象了 —— 任何组件规则都自动赢。这里改成钉住它**确实**被归零,
     * 剩下的仍然逐条验这个菜单自己的可读性。
     */
    const globalHoverSelector = ':where(button:hover:not(:disabled))';
    const hoverSelector = 'button.plugins-home__use-menu-item:hover:not(:disabled)';
    const focusSelector = 'button.plugins-home__use-menu-item:focus-visible';
    const globalHover = cssDeclarations(indexCss, globalHoverSelector);
    const hover = cssDeclarations(pluginsHomeCss, hoverSelector);
    const focus = cssDeclarations(pluginsHomeCss, focusSelector);

    expect(ruleValue(globalHover, 'background')).toBe('var(--bg-subtle)');

    // The menu paints with tokens (the `--sub` row, `--ink` text), so the contrast has to hold
    // for what those tokens resolve to in BOTH themes, not for one literal.
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeTokens(theme);
      for (const block of [hover, focus]) {
        const background = ruleValue(block, 'background');
        const color = ruleValue(block, 'color');
        expect(
          contrastRatio(resolveColor(color, tokens), resolveColor(background, tokens)),
          `${theme}: option text on the hover / focus row`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
