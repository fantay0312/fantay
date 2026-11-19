// SPDX-License-Identifier: AGPL-3.0-only
// The first wall around HTML made from a file's content (RTF and OpenDocument conversions, book
// chapters): DOMPurify with scripts, frames, forms, media and style sheets forbidden, then one pass
// over what is left so that no address survives unless the caller put it there. The result is a
// fragment that still lives in an inert document: nothing in it has loaded or run. The second wall
// is the frame it is shown in (`parts/SandboxFrame.tsx`).
import DOMPurify from 'dompurify';

const FORBIDDEN_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea',
  'select', 'option', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'canvas', 'dialog', 'template', 'slot',
  'noscript', 'title', 'head', 'foreignObject', 'animate', 'set', 'animateTransform', 'animateMotion',
];

const FORBIDDEN_ATTRIBUTES = ['srcset', 'sizes', 'ping', 'action', 'formaction', 'background', 'poster', 'usemap', 'ismap', 'loading'];

/** Colour and placement a document may not set on a themed reading page. */
const THEMED_PROPERTIES = [
  'color', 'background', 'background-color', 'background-image', '-webkit-text-fill-color', 'position', 'z-index', 'float',
  'inset', 'top', 'right', 'bottom', 'left',
];

/** What a converter of ours writes into `style`; anything else is dropped. */
const CONVERTED_PROPERTIES = new Set(['font-size', 'text-align', 'text-indent', 'margin-left', 'vertical-align', 'width']);

/** A picture carried inside the markup: only bitmap types, only base64. */
export const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z\d+/]*={0,2}$/i;

export interface SanitizeOptions {
  /**
   * `converted`: markup written by our own readers; `style` keeps only the few properties they emit.
   * `book`: an author's chapter; classes, ids and inline styles stay, minus colour, placement and
   * anything with an address in it, so the text follows the theme.
   */
  mode: 'converted' | 'book';
  /**
   * Called for every picture after its address has been removed. Return true to keep the element
   * (and set a `data:` or `blob:` address on it, now or later); false removes it.
   */
  onImage(element: Element, address: string): boolean;
  /**
   * Called for every link after its `href` has been removed. Return true when the link was given a
   * new target; otherwise a `#fragment`, http(s) or mailto address is put back and anything else
   * leaves the text without a link.
   */
  onLink?(element: Element, address: string): boolean;
}

function cleanStyle(element: Element, mode: SanitizeOptions['mode']): void {
  const raw = element.getAttribute('style');
  if (raw === null) return;
  // An address, an import or an escape that could spell one: the whole declaration goes.
  if (/url\s*\(|@import|expression|\\|image-set|src\s*:/i.test(raw)) {
    element.removeAttribute('style');
    return;
  }
  const style = (element as HTMLElement).style;
  if (!style) {
    element.removeAttribute('style');
    return;
  }
  if (mode === 'book') {
    for (const property of THEMED_PROPERTIES) style.removeProperty(property);
  } else {
    for (const property of Array.from(style)) if (!CONVERTED_PROPERTIES.has(property)) style.removeProperty(property);
  }
  if (style.length === 0) element.removeAttribute('style');
}

function addressOf(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) element.removeAttribute(name);
  return value;
}

/**
 * Sanitises markup (a string parsed as HTML, or an already parsed node such as an XHTML body) into a
 * fragment that is safe to move into a script-less frame.
 */
export function sanitizeToFragment(source: string | Node, options: SanitizeOptions): DocumentFragment {
  const fragment = DOMPurify.sanitize(source, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: options.mode === 'book' ? { html: true, svg: true, mathMl: true } : { html: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: options.mode === 'book' ? FORBIDDEN_ATTRIBUTES : [...FORBIDDEN_ATTRIBUTES, 'class', 'id', 'name'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }) as unknown as DocumentFragment;

  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    const tag = element.localName.toLowerCase();
    cleanStyle(element, options.mode);
    if (options.mode === 'book') {
      // Presentation attributes that would fight the theme.
      for (const name of ['color', 'bgcolor', 'text', 'link', 'vlink', 'alink']) element.removeAttribute(name);
    }

    if (tag === 'img') {
      const address = addressOf(element, 'src') ?? '';
      if (!options.onImage(element, address)) element.remove();
      continue;
    }
    if (tag === 'image') {
      const address = addressOf(element, 'href') ?? addressOf(element, 'xlink:href') ?? '';
      element.removeAttribute('xlink:href');
      if (!options.onImage(element, address)) element.remove();
      continue;
    }
    if (tag === 'a' || tag === 'area') {
      const address = addressOf(element, 'href') ?? addressOf(element, 'xlink:href');
      element.removeAttribute('xlink:href');
      element.removeAttribute('target');
      element.removeAttribute('download');
      if (address === null) continue;
      if (options.onLink?.(element, address) === true) continue;
      if (address.startsWith('#') || /^(?:https?:|mailto:)/i.test(address)) element.setAttribute('href', address);
      continue;
    }
    // Any other element that points somewhere (`use`, `input`, a stray `src`) may only point inside
    // the same document.
    for (const name of ['src', 'href', 'xlink:href', 'data', 'cite', 'longdesc']) {
      const value = element.getAttribute(name);
      if (value !== null && !value.startsWith('#')) element.removeAttribute(name);
    }
  }
  return fragment;
}

/** The sanitiser for markup our own readers produced: pictures only as embedded bitmaps. */
export function sanitizeConverted(html: string): DocumentFragment {
  return sanitizeToFragment(html, {
    mode: 'converted',
    onImage: (element, address) => {
      if (!SAFE_DATA_IMAGE.test(address)) return false;
      element.setAttribute('src', address);
      return true;
    },
  });
}
