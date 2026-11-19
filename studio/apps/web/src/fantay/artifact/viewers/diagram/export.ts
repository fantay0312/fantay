// SPDX-License-Identifier: AGPL-3.0-only
// A drawing that leaves the app: a self-contained SVG file, or a PNG for the clipboard or a file.
// On screen every colour and font is a CSS variable (pele's `--_*` aliases of `--pele-*`, which
// this viewer maps to the product tokens), so the theme can change without drawing again. Outside
// the app those variables do not exist, so every `var(…)` in an attribute or a style is replaced
// by the value it has right now, read from a hidden copy of the drawing that wears the same theme
// class as the stage. The custom properties themselves are then dropped, a background is painted
// under the drawing (it is meant to be read on its own), and the links' addresses are removed.
// A drawing with typeset formulas carries HTML inside the SVG, which needs KaTeX's rules and fonts:
// `exportDiagram` writes the rules in use and the font faces in use, the fonts inlined, into the
// file. Such a file reads in a browser; a design tool that ignores HTML in SVG shows the diagram
// without its formulas.
import type { DiagramDrawing } from './render';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * What the theme's style sheet sets on pele's elements beyond the variables (the per-kind rules in
 * `theme.module.css`): selector and properties. Outside the app that sheet is gone, so the values
 * the elements have on screen are written onto them. Keep in step with that file.
 */
const THEMED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['.pele-quadrantChart .pele-quadrants', ['stroke']],
  ['.pele-quadrantChart .pele-quadrant rect', ['fill']],
  ['.pele-quadrantChart .pele-quadrant .pele-label', ['fill', 'font-weight']],
  ['.pele-quadrantChart .pele-point', ['stroke', 'stroke-width', 'paint-order']],
  ['.pele-quadrantChart .pele-point-labels text', ['font-weight']],
  ['.pele-sankey .pele-sankey-links', ['fill-opacity']],
  ['.pele-sankey .pele-label text', ['font-weight']],
  ['.pele-sankey .pele-sankey-value', ['font-weight']],
  ['.pele-c4 .pele-c4-boundary > rect', ['fill']],
  ['.pele-c4 .pele-c4-type', ['letter-spacing']],
];

/** Writes the themed properties of `live` (the copy that wears the theme) onto the same elements of `out`. */
function carryThemedStyles(live: SVGSVGElement, out: SVGSVGElement): void {
  const liveAll = [live, ...Array.from(live.querySelectorAll('*'))];
  const outAll = [out, ...Array.from(out.querySelectorAll('*'))];
  if (liveAll.length !== outAll.length) return;
  const index = new Map<Element, number>(liveAll.map((element, position) => [element, position]));
  const scope = live.parentElement ?? live;
  for (const [selector, properties] of THEMED) {
    for (const element of Array.from(scope.querySelectorAll(selector))) {
      const target = outAll[index.get(element) ?? -1] as SVGElement | undefined;
      if (!target?.style) continue;
      const computed = getComputedStyle(element);
      for (const property of properties) {
        const value = computed.getPropertyValue(property).trim();
        if (value) target.style.setProperty(property, value);
      }
    }
  }
}

/** Index of the first comma not inside parentheses, or -1. */
function topLevelComma(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) return index;
  }
  return -1;
}

/**
 * Replaces every `var(--name, fallback)` in `value` with `lookup(--name)`, or the (resolved)
 * fallback when the variable has no value. Nested variables are followed a few levels deep.
 */
export function resolveCssVariables(value: string, lookup: (name: string) => string | null, depth = 0): string {
  if (depth > 8 || !value.includes('var(')) return value;
  let out = '';
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf('var(', index);
    if (start === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, start);
    let level = 0;
    let end = -1;
    for (let cursor = start + 3; cursor < value.length; cursor += 1) {
      if (value[cursor] === '(') level += 1;
      else if (value[cursor] === ')') {
        level -= 1;
        if (level === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end === -1) {
      out += value.slice(start);
      break;
    }
    const inner = value.slice(start + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
    const found = lookup(name);
    out += resolveCssVariables(found !== null && found !== '' ? found : fallback, lookup, depth + 1);
    index = end + 1;
  }
  return out;
}

/** The root style with its custom properties removed: they mean nothing once the values are in. */
export function withoutCustomProperties(style: string): string {
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '' && !declaration.startsWith('--'))
    .join(';');
}

/**
 * pele rounds corners with the CSS property (`style="rx:6px"`); design tools read only the
 * attribute, so a corner radius in a style moves to `rx`/`ry` attributes.
 */
export function liftCornerRadius(element: Element): void {
  const style = element.getAttribute('style');
  if (style === null || !/(?:^|;)\s*r[xy]\s*:/.test(style)) return;
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const match = /^\s*(r[xy])\s*:\s*([\d.]+)(?:px)?\s*$/.exec(declaration);
    if (match?.[1] && match[2]) element.setAttribute(match[1], match[2]);
    else if (declaration.trim()) kept.push(declaration.trim());
  }
  if (kept.length > 0) element.setAttribute('style', kept.join(';'));
  else element.removeAttribute('style');
}

/**
 * The drawing as a standalone SVG document, in the colours the reader sees now. `themeClassName`
 * is the class that maps `--pele-*` to the product tokens (the stage wears it).
 */
export function exportDiagramSvg(drawing: DiagramDrawing, themeClassName: string, css = ''): string {
  const probe = document.createElement('div');
  probe.className = themeClassName;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden;pointer-events:none';
  const live = drawing.svg.cloneNode(true) as SVGSVGElement;
  probe.append(live);
  document.body.append(probe);
  try {
    const computed = getComputedStyle(live);
    const seen = new Map<string, string | null>();
    const lookup = (name: string): string | null => {
      if (!seen.has(name)) seen.set(name, computed.getPropertyValue(name).trim() || null);
      return seen.get(name) ?? null;
    };

    const out = drawing.svg.cloneNode(true) as SVGSVGElement;
    carryThemedStyles(live, out);
    for (const element of [out, ...Array.from(out.querySelectorAll('*'))]) {
      element.removeAttribute('data-diagram-link');
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.value.includes('var(')) element.setAttribute(attribute.name, resolveCssVariables(attribute.value, lookup));
      }
      if (element !== out) liftCornerRadius(element);
    }
    const style = withoutCustomProperties(out.getAttribute('style') ?? '');
    if (style) out.setAttribute('style', style);
    else out.removeAttribute('style');
    out.setAttribute('width', String(drawing.width));
    out.setAttribute('height', String(drawing.height));

    const background = resolveCssVariables('var(--pele-bg)', lookup);
    if (background) {
      const ground = document.createElementNS(SVG_NS, 'rect');
      ground.setAttribute('width', String(drawing.width));
      ground.setAttribute('height', String(drawing.height));
      ground.setAttribute('fill', background);
      out.insertBefore(ground, out.firstChild);
    }
    if (css) {
      const sheet = document.createElementNS(SVG_NS, 'style');
      sheet.textContent = css;
      out.insertBefore(sheet, out.firstChild);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(out)}\n`;
  } finally {
    probe.remove();
  }
}

// ── formulas: KaTeX's rules and fonts, carried in the file ───────────────────────────────────────

function weightNumber(weight: string): string {
  const value = weight.trim().toLowerCase();
  return value === 'normal' || value === '' ? '400' : value === 'bold' ? '700' : value;
}

function faceKey(family: string, weight: string, style: string): string {
  return `${family.replace(/["']/g, '').trim()}|${weightNumber(weight)}|${style.trim().toLowerCase() || 'normal'}`;
}

function eachRule(list: CSSRuleList, visit: (rule: CSSRule, base: string) => void, base: string): void {
  for (const rule of Array.from(list)) {
    visit(rule, base);
    const inner = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined;
    if (inner && !('selectorText' in rule)) eachRule(inner, visit, base);
  }
}

async function dataUrl(address: string): Promise<string | null> {
  try {
    const response = await fetch(address);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return `data:font/woff2;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/**
 * The style sheet a drawing with formulas needs outside the app: KaTeX's rules as the page has
 * them, and the KaTeX font faces the page has loaded (the ones formulas on screen use), inlined.
 */
export async function collectMathStyles(): Promise<string> {
  const loaded = new Set<string>();
  for (const face of Array.from(document.fonts ?? [])) {
    if (face.status === 'loaded' && face.family.includes('KaTeX')) loaded.add(faceKey(face.family, face.weight, face.style));
  }
  const rules: string[] = [];
  const faces: Array<{ family: string; weight: string; style: string; address: string }> = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    eachRule(
      list,
      (rule, base) => {
        const style = (rule as CSSFontFaceRule).style as CSSStyleDeclaration | undefined;
        if (rule.constructor.name === 'CSSFontFaceRule' && style) {
          const family = style.getPropertyValue('font-family');
          if (!family.includes('KaTeX')) return;
          const weight = style.getPropertyValue('font-weight');
          const slant = style.getPropertyValue('font-style');
          if (!loaded.has(faceKey(family, weight, slant))) return;
          const source = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/i.exec(style.getPropertyValue('src'));
          if (!source?.[1]) return;
          try {
            faces.push({ family: family.replace(/["']/g, '').trim(), weight: weightNumber(weight), style: slant.trim() || 'normal', address: new URL(source[1], base).href });
          } catch {
            /* An address that does not resolve is left out; the formula falls back to a system face. */
          }
        } else if ('selectorText' in rule && String((rule as CSSStyleRule).selectorText).includes('.katex')) {
          rules.push(rule.cssText);
        }
      },
      sheet.href ?? document.baseURI,
    );
  }
  const inlined = await Promise.all(
    faces.map(async (face) => {
      const data = await dataUrl(face.address);
      return data ? `@font-face{font-family:"${face.family}";font-style:${face.style};font-weight:${face.weight};src:url(${data}) format("woff2")}` : '';
    }),
  );
  return [...inlined.filter(Boolean), ...rules].join('\n');
}

/** The drawing as a standalone SVG document; a drawing with formulas carries what they need. */
export async function exportDiagram(drawing: DiagramDrawing, themeClassName: string): Promise<string> {
  return exportDiagramSvg(drawing, themeClassName, drawing.math ? await collectMathStyles() : '');
}

/** Pixels per diagram unit for a PNG: 2× for sharpness, less when that would exceed what a canvas holds. */
export function pngScale(width: number, height: number): number {
  const MAX_SIDE = 16_384;
  const MAX_AREA = 64_000_000;
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.max(0.05, Math.min(2, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height))));
}

/** Draws a standalone SVG document onto a canvas and encodes it as PNG. */
export async function rasterizeSvg(svgText: string, width: number, height: number): Promise<Blob> {
  const scale = pngScale(width, height);
  // A canvas that drew HTML-in-SVG from a `blob:` address may not be read back (the browser treats
  // it as another origin's picture); from a `data:` address it may.
  const embedded = svgText.includes('<foreignObject');
  const url = embedded ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}` : URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/png');
    });
  } finally {
    if (!embedded) URL.revokeObjectURL(url);
  }
}
