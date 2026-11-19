// SPDX-License-Identifier: AGPL-3.0-only
// One chapter, from the book's markup to nodes that are safe to show. The chapter is parsed in an
// inert document, sanitised (`document/sanitize.ts`: no script, frame, form, media or style sheet;
// no address left in it), and only then given addresses again: pictures become `blob:` addresses
// made from the archive's bytes, and links between chapters become targets the viewer follows.
// Nothing here fetches from the network, and remote addresses in the book are dropped.
// The book's stylesheets are kept for what they say about type (indents, alignment, heading
// styles), minus everything that could load something or fight the reader's page and theme.
import { imageFits } from '../document/images';
import { SAFE_DATA_IMAGE, sanitizeToFragment } from '../document/sanitize';
import { archivePath } from '../document/xml';
import type { BookClient } from './book-client';

const MAX_STYLESHEET_CHARS = 1_000_000;
const MAX_CHAPTER_STYLES_CHARS = 600_000;
const MAX_CHAPTER_PICTURE_BYTES = 64 * 1024 * 1024;
/** One picture: a full-page scan fits, a canvas of hundreds of megapixels does not. */
const MAX_PICTURE_BYTES = 16 * 1024 * 1024;
const MAX_PICTURE_PIXELS = 40_000_000;

const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']);
/** Bitmaps whose header we can check before the browser allocates their canvas. */
const CHECKED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface ParsedChapter {
  fragment: DocumentFragment;
  /** The chapter body's own class names, for the book's stylesheet. */
  bodyClass: string;
  /** Pictures waiting for an address: the element, the attribute to set and the archive path. */
  pictures: Array<{ element: Element; attribute: 'src' | 'href'; path: string }>;
  /** Archive paths of the stylesheets the chapter links, in order. */
  styleSheets: string[];
  /** Text of the chapter's own `<style>` elements. */
  inlineStyles: string[];
}

/** Parses and sanitises a chapter. `path` is the chapter's place in the archive, for relative addresses. */
export function parseChapter(markup: string, path: string): ParsedChapter {
  const parser = new DOMParser();
  // Chapters are XHTML; when one is not well formed, read it as HTML instead of giving up.
  let parsed = parser.parseFromString(markup, 'application/xhtml+xml');
  if (parsed.getElementsByTagName('parsererror').length > 0 || !parsed.querySelector('body')) {
    parsed = parser.parseFromString(markup, 'text/html');
  }
  const body = parsed.querySelector('body') ?? parsed.documentElement;

  const styleSheets: string[] = [];
  const inlineStyles: string[] = [];
  for (const link of Array.from(parsed.querySelectorAll('link[href]'))) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet') || rel.includes('alternate')) continue;
    const target = archivePath(path, link.getAttribute('href') ?? '');
    if (target) styleSheets.push(target);
  }
  for (const style of Array.from(parsed.querySelectorAll('style'))) {
    if (style.textContent) inlineStyles.push(style.textContent);
  }

  const pictures: ParsedChapter['pictures'] = [];
  const fragment = sanitizeToFragment(body, {
    mode: 'book',
    onImage: (element, address) => {
      const attribute = element.localName.toLowerCase() === 'image' ? 'href' : 'src';
      if (SAFE_DATA_IMAGE.test(address)) {
        element.setAttribute(attribute, address);
        return true;
      }
      const target = archivePath(path, address);
      if (!target) return false;
      pictures.push({ element, attribute, path: target });
      return true;
    },
    onLink: (element, address) => {
      if (address.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(address)) return false;
      const target = archivePath(path, address);
      if (!target) return false;
      const hash = address.indexOf('#');
      // A link to another part of the book: the viewer follows it, the frame never does.
      element.setAttribute('href', '#');
      element.setAttribute('data-fx-path', target);
      element.setAttribute('data-fx-fragment', hash >= 0 ? address.slice(hash + 1) : '');
      return true;
    },
  });

  const bodyClass = (body.getAttribute('class') ?? '').replace(/[^\w\- ]/g, ' ').trim();
  return { fragment, bodyClass, pictures, styleSheets, inlineStyles };
}

/** Properties a book may not set: colour and ground follow the theme, nothing leaves the flow. */
const REMOVED_PROPERTIES = ['color', 'background', 'background-color', 'background-image', '-webkit-text-fill-color', 'text-shadow', 'z-index'];

function pageSelector(selector: string): boolean {
  // The selector's subject is the page itself: `body`, `html body`, `body.calibre`, `:root`.
  return /(^|[\s>+~])(html|body|:root)([.#:[][^\s>+~]*)?$/i.test(selector.trim());
}

function splitSelectors(selectorText: string): string[] {
  const selectors: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of selectorText) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      selectors.push(current);
      current = '';
    } else current += char;
  }
  selectors.push(current);
  return selectors.map((selector) => selector.trim()).filter((selector) => selector !== '');
}

/**
 * A book's stylesheet reduced to what the reading page accepts: style rules (also inside `@media`),
 * without imports, fonts, addresses, colours, fixed placement or rules for the page itself.
 * Returns '' where the browser cannot parse a stylesheet off-document.
 */
export function cleanBookCss(text: string): string {
  if (typeof CSSStyleSheet === 'undefined' || text.length > MAX_STYLESHEET_CHARS) return '';
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
  } catch {
    return '';
  }
  const render = (rules: CSSRuleList, depth: number): string => {
    let out = '';
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selectors = splitSelectors(rule.selectorText).filter((selector) => !pageSelector(selector));
        if (selectors.length === 0) continue;
        const style = rule.style;
        for (const property of REMOVED_PROPERTIES) style.removeProperty(property);
        const placement = style.getPropertyValue('position');
        if (placement === 'fixed' || placement === 'absolute' || placement === 'sticky') style.removeProperty('position');
        for (const property of Array.from(style)) {
          if (/url\s*\(|image-set|expression/i.test(style.getPropertyValue(property))) style.removeProperty(property);
        }
        if (style.length === 0) continue;
        out += `${selectors.join(', ')} { ${style.cssText} }\n`;
      } else if (rule instanceof CSSMediaRule && depth < 3) {
        const inner = render(rule.cssRules, depth + 1);
        if (inner) out += `@media ${rule.conditionText} {\n${inner}}\n`;
      }
      // Everything else (@import, @font-face, @page, @namespace, @keyframes) is left out.
    }
    return out;
  };
  return render(sheet.cssRules, 0);
}

export interface LoadedChapter {
  fragment: DocumentFragment;
  bodyClass: string;
  /** The book's cleaned stylesheets for this chapter. */
  css: string;
  /** Object addresses made for this chapter's pictures; revoke them when the chapter leaves. */
  addresses: string[];
}

/**
 * Loads one chapter: its markup, then the pictures and stylesheets it names, from the book worker.
 * `styleCache` keeps cleaned stylesheets across chapters (a book usually has one). Rejects with a
 * `BookError`.
 */
export async function loadChapter(client: BookClient, index: number, styleCache: Map<string, string>): Promise<LoadedChapter> {
  const content = await client.chapter(index);
  const parsed = parseChapter(content.markup, content.path);

  const wanted = new Set<string>();
  for (const picture of parsed.pictures) wanted.add(picture.path);
  for (const sheet of parsed.styleSheets) if (!styleCache.has(sheet)) wanted.add(sheet);
  const resources = new Map((await client.resources([...wanted])).map((resource) => [resource.path, resource]));

  let css = '';
  for (const sheet of parsed.styleSheets) {
    let cleaned = styleCache.get(sheet);
    if (cleaned === undefined) {
      const resource = resources.get(sheet);
      cleaned = resource ? cleanBookCss(new TextDecoder('utf-8').decode(resource.bytes)) : '';
      styleCache.set(sheet, cleaned);
    }
    css += cleaned;
  }
  for (const inline of parsed.inlineStyles) css += cleanBookCss(inline);
  if (css.length > MAX_CHAPTER_STYLES_CHARS) css = '';

  const addresses: string[] = [];
  const addressByPath = new Map<string, string | null>();
  let pictureBytes = 0;
  for (const picture of parsed.pictures) {
    let address = addressByPath.get(picture.path);
    if (address === undefined) {
      const resource = resources.get(picture.path);
      const usable =
        resource !== undefined &&
        PICTURE_TYPES.has(resource.mediaType) &&
        pictureBytes + resource.bytes.byteLength <= MAX_CHAPTER_PICTURE_BYTES &&
        (!CHECKED_TYPES.has(resource.mediaType) || imageFits(resource.bytes, MAX_PICTURE_BYTES, MAX_PICTURE_PIXELS));
      if (usable) {
        pictureBytes += resource.bytes.byteLength;
        address = URL.createObjectURL(new Blob([resource.bytes as Uint8Array<ArrayBuffer>], { type: resource.mediaType }));
        addresses.push(address);
      } else {
        address = null;
      }
      addressByPath.set(picture.path, address);
    }
    if (address) picture.element.setAttribute(picture.attribute, address);
    else picture.element.remove();
  }

  return { fragment: parsed.fragment, bodyClass: parsed.bodyClass, css, addresses };
}
