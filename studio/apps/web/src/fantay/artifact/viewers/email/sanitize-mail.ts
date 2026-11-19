// SPDX-License-Identifier: AGPL-3.0-only
// The first wall around a mail's HTML body. Mail is the most hostile input the product opens, and it
// is also a designed page: table layouts, inline colours and the message's own style sheets are what
// make it look like what the sender sent. So, unlike the converted-document sanitiser
// (`document/sanitize.ts`, which keeps only a few properties), this one keeps the look and takes out
// everything that runs, loads, submits or navigates:
//  - DOMPurify with scripts, frames, objects, forms, media, SVG, MathML, `<link>`, `<meta>` and
//    `<base>` forbidden, and event handlers, `srcset`, `background`, `ping`, `action` and `target`
//    stripped;
//  - style sheets and `style` attributes keep their declarations minus every one that holds an
//    address or an old script hook (`url()`, `image-set()`, `expression()`, `behavior`,
//    `-moz-binding`), with comments and escapes decoded first so none can hide; `@import` and
//    `@font-face` go entirely; viewport units become pixels, because the frame grows to fit its
//    content and a `100vh` block would grow with it;
//  - pictures: `cid:` addresses are kept as a reference the viewer resolves from the message's own
//    parts, embedded bitmaps stay, and remote pictures are never loaded: each becomes a quiet box with
//    its alternative text and its size, so the layout holds; tracking pixels simply go;
//  - links keep only http(s), mailto and in-page addresses; the viewer decides what a click does.
// What was taken out is counted, so the viewer can say so in one line. The result is a fragment in an
// inert document: nothing in it has loaded or run. The second wall is the frame
// (`parts/SandboxFrame.tsx`): no script, a `default-src 'none'` policy, no navigation.
//
// Remote pictures, when the reader asks for them (`remotePictures`, one message at a time): a remote
// `<img>` keeps its http(s) address (`//host` becomes `https://host`), with no referrer and no
// `crossorigin`; a `background` or `background-image` declaration keeps its `url()`s when every one
// of them is a plain http(s) address (`remotePictureAddress`) and nothing else in the value could
// fetch or run; a `background` attribute becomes that declaration. Everything else stays as above:
// tracking pixels still go (showing pictures must not send the read receipt the sender is counting
// on), `srcset`, `@import`, `@font-face`, `<link>`, frames, forms, scripts and media still go, and an
// address over `MAX_PICTURE_ADDRESS` stays a box. The frame's own policy is opened for `http:` and
// `https:` pictures only in that case (`SandboxFrame` `remotePictures`). With the switch off, the
// output is exactly the one described above; only `pictures` says how many could be shown.
import DOMPurify from 'dompurify';

import { SAFE_DATA_IMAGE } from '../document/sanitize';
import { normalizeContentId } from './mail-types';

export interface BlockedContent {
  /** Remote pictures: `<img>`, background attributes and `url()` in styles. */
  images: number;
  /** One-pixel or hidden remote pictures: read receipts. */
  trackers: number;
  /** `<link rel=stylesheet>` and `@import`. */
  styles: number;
  /** `@font-face` rules that fetch a font. */
  fonts: number;
  /** Frames, objects, embeds, applets, audio and video. */
  embeds: number;
  forms: number;
  scripts: number;
}

export interface PreparedMailHtml {
  /** The sanitised body content. Clone it before moving it into a document. */
  fragment: DocumentFragment;
  /** The message's own style sheets, cleaned. */
  css: string;
  /** Inline style for the frame's `<body>`: the message body's own background, colour and spacing. */
  bodyStyle: string;
  blocked: BlockedContent;
  /** Content-IDs (normalised) the body shows; those parts are not listed again as attachments. */
  cids: Set<string>;
  /** False when nothing is left to see (no text, no picture). */
  visible: boolean;
  /**
   * Remote pictures the reader can choose to load (`<img>`, `background` attributes and `url()`s in
   * background declarations). With `remotePictures` off they are among `blocked.images`; with it on
   * they are in the output, set to load, and `blocked.images` counts only the ones that still could not.
   */
  pictures: number;
}

export interface PrepareMailOptions {
  /** Let remote pictures load (the reader asked, for this message). Off by default. */
  remotePictures?: boolean;
}

/** `<img data-fx-cid>` carries the Content-ID the viewer turns into a `blob:` address. */
export const CID_ATTRIBUTE = 'data-fx-cid';
/** The box a blocked remote picture becomes. */
export const BLOCKED_CLASS = 'fx-blocked';

const FORBIDDEN_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea',
  'select', 'option', 'optgroup', 'datalist', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'canvas',
  'dialog', 'template', 'slot', 'noscript', 'title', 'head', 'portal', 'svg', 'math', 'picture', 'map', 'area',
];
const FORBIDDEN_ATTRIBUTES = [
  'srcset', 'sizes', 'ping', 'action', 'formaction', 'background', 'poster', 'usemap', 'ismap', 'loading', 'http-equiv',
  'target', 'download', 'autofocus', 'accesskey', 'tabindex', 'contenteditable', 'popover', 'xmlns',
];
const EMBED_SELECTOR = 'iframe, frame, object, embed, applet, video, audio, portal';
const REMOTE = /^\s*(?:https?:)?\/\//i;
/** A declaration value that holds an address or a script hook. */
const UNSAFE_VALUE = /(?:url|image-set|-webkit-image-set|image|cross-fade|element|expression|src|paint)\s*\(|javascript:|vbscript:/i;
const UNSAFE_PROPERTY = /^(?:behavior|-ms-behavior|-moz-binding|-webkit-binding)$/i;
/** One CSS viewport unit, in pixels, for a frame that is as tall as its content. */
const VIEWPORT_UNIT_PX = 8;

/** A longer picture address stays a box. */
export const MAX_PICTURE_ADDRESS = 2000;
/** The declarations a remote picture may stay in. */
const PICTURE_PROPERTY = /^background(?:-image)?$/i;
/** One `url()` token: quoted or bare; a bare address stops at what would end or escape it. */
const URL_TOKEN = /(?<![\w-])url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s\\]*))\s*\)/gi;
/** Never in a picture address. */
const UNSAFE_ADDRESS_CHAR = /[\s\\\u0000-\u001f\u007f]/;
/** Never in a picture address written into CSS: what could end the token, the declaration or the rule. */
const UNSAFE_CSS_ADDRESS_CHAR = /["'()<>;{}]|\/\*/;

/**
 * Remote pictures the sanitiser came across: counted with the switch on or off, so the viewer
 * knows whether there is anything to show; kept in the output only when `load`.
 */
export interface PictureTally {
  load: boolean;
  count: number;
}

/**
 * The address a remote picture may load from, or null: http or https (an address that starts with
 * `//` becomes https), a host and no `user:password@`, no whitespace, backslash or control
 * character, at most `MAX_PICTURE_ADDRESS` long. `inCss`: it will stand bare inside `url()`, so no
 * quote, parenthesis, `;`, brace or comment either. Returned as the URL parser spells it.
 */
export function remotePictureAddress(raw: string, inCss = false): string | null {
  const text = raw.trim();
  const unsafe = (value: string): boolean => UNSAFE_ADDRESS_CHAR.test(value) || (inCss && UNSAFE_CSS_ADDRESS_CHAR.test(value));
  if (!text || text.length > MAX_PICTURE_ADDRESS || unsafe(text)) return null;
  const parts = /^(https?:)?\/\/([^/?#]*)/i.exec(text);
  if (!parts || !parts[2] || parts[2].includes('@')) return null;
  let url: URL;
  try {
    url = new URL(parts[1] ? text : `https:${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return null;
  const address = url.href;
  return address.length > MAX_PICTURE_ADDRESS || unsafe(address) ? null : address;
}

/**
 * A background declaration's value with its pictures in a form that may load, or null when the
 * value holds anything else that would fetch or run (another `url()`, `image-set()`, `cross-fade()`,
 * `element()`, `paint()`, `expression()`, a script address…): then it goes, as with the switch off.
 */
function pictureValue(name: string, value: string): { value: string; count: number } | null {
  if (!PICTURE_PROPERTY.test(name.trim())) return null;
  let count = 0;
  let refused = false;
  const kept = value.replace(URL_TOKEN, (whole, double: string | undefined, single: string | undefined, bare: string | undefined) => {
    const address = remotePictureAddress(double ?? single ?? bare ?? '', true);
    if (address === null) {
      refused = true;
      return whole;
    }
    count += 1;
    return `url(${address})`;
  });
  if (refused || count === 0) return null;
  // With the accepted pictures taken out, nothing in the value may still fetch or run.
  if (UNSAFE_VALUE.test(kept.replace(URL_TOKEN, ' '))) return null;
  // Viewport units become pixels as anywhere else, but never inside an address.
  let fixed = '';
  let from = 0;
  for (const token of kept.matchAll(URL_TOKEN)) {
    fixed += fixViewportUnits(kept.slice(from, token.index)) + token[0];
    from = (token.index ?? 0) + token[0].length;
  }
  return { value: fixed + fixViewportUnits(kept.slice(from)), count };
}

export function emptyBlocked(): BlockedContent {
  return { images: 0, trackers: 0, styles: 0, fonts: 0, embeds: 0, forms: 0, scripts: 0 };
}

export function blockedTotal(blocked: BlockedContent): number {
  return Object.values(blocked).reduce((sum, count) => sum + count, 0);
}

/** Comments out, escapes decoded: what the rules below look for cannot be split or spelled another way. */
export function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
    .replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
    })
    .replace(/\\\r?\n/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\\/g, '');
}

function countUrls(value: string, blocked: BlockedContent): void {
  for (const match of value.matchAll(/url\s*\(\s*['"]?\s*([^'")\s]*)/gi)) {
    if (REMOTE.test(match[1] ?? '')) blocked.images += 1;
  }
}

/** Height-bound viewport units become pixels: a frame as tall as its content has no viewport height to speak of. */
function fixViewportUnits(value: string): string {
  return value.replace(/(-?\d*\.?\d+)(?:[dsl]?v(?:h|min|max|b))\b/gi, (_, amount: string) => `${Math.round(Number(amount) * VIEWPORT_UNIT_PX)}px`);
}

/** One declaration (`name: value`), or '' when it must go. */
function cleanDeclaration(declaration: string, blocked: BlockedContent, tally?: PictureTally): string {
  const colon = declaration.indexOf(':');
  if (colon === -1) return declaration.trim() ? '' : declaration;
  const name = declaration.slice(0, colon).trim();
  const value = declaration.slice(colon + 1);
  if (UNSAFE_PROPERTY.test(name)) return '';
  // Pinned to the window, a block can cover the rest of the message (or pose as something else).
  if (/^position$/i.test(name) && /fixed|sticky/i.test(value)) return '';
  if (UNSAFE_VALUE.test(value)) {
    const picture = tally ? pictureValue(name, value) : null;
    if (picture && tally) {
      tally.count += picture.count;
      if (tally.load) return `${name}:${picture.value}`;
    }
    countUrls(value, blocked);
    return '';
  }
  return `${name}:${fixViewportUnits(value)}`;
}

/**
 * A `style` attribute's text, cleaned. Returns '' when nothing is left. `tally` (from
 * `prepareMailHtml`) counts the remote pictures in it and, when they may load, keeps them.
 */
export function cleanStyleAttribute(style: string, blocked: BlockedContent = emptyBlocked(), tally?: PictureTally): string {
  return normalizeCss(style)
    .split(';')
    .map((declaration) => cleanDeclaration(declaration, blocked, tally))
    .filter((declaration) => declaration.trim() !== '')
    .join(';');
}

/**
 * A style sheet's text, cleaned. Rules, selectors and media queries stay as written; at-rules that
 * fetch go, and every declaration is cleaned as in a `style` attribute.
 */
export function cleanStyleSheet(css: string, blocked: BlockedContent = emptyBlocked(), tally?: PictureTally): string {
  let text = normalizeCss(css);
  text = text.replace(/@import\b[^;{}]*;?/gi, () => {
    blocked.styles += 1;
    return '';
  });
  text = text.replace(/@font-face\s*\{[^}]*\}?/gi, (rule) => {
    if (/url\s*\(/i.test(rule)) blocked.fonts += 1;
    return '';
  });
  text = text.replace(/@(?:charset|namespace)\b[^;{}]*;?/gi, '');
  // CSS has no use for `<`; markup that ended up inside a style element is not CSS.
  text = text.replace(/</g, ' ');
  // Each run between `{`, `;` and `}` is either a selector (followed by `{`) or a declaration.
  return text
    .replace(/([{;}]|^)([^{};]*)(?=([{};]|$))/g, (whole, open: string, run: string, next: string) => {
      if (next === '{' || !run.includes(':')) return whole;
      return open + cleanDeclaration(run, blocked, tally);
    })
    .replace(/([{;])(?:\s*;)+/g, '$1');
}

function numberAttribute(element: Element, name: string): number | null {
  const value = Number.parseFloat(element.getAttribute(name) ?? '');
  return Number.isFinite(value) ? value : null;
}

/** A remote picture that exists only to report that the message was opened. */
function isTracker(image: Element): boolean {
  const width = numberAttribute(image, 'width');
  const height = numberAttribute(image, 'height');
  if ((width !== null && width <= 2) || (height !== null && height <= 2)) return true;
  const style = (image.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  return /display:none|visibility:hidden|(?:^|;)(?:max-)?(?:width|height):[0-2](?:px)?(?:;|$)|opacity:0(?:;|$)/.test(style);
}

/**
 * The quiet box a blocked remote picture becomes: its words and, when it says, its size. Also what a
 * shown picture becomes when it does not load (`MailFrame`), so both look the same.
 */
export function blockedBox(image: Element): Element {
  const box = image.ownerDocument.createElement('span');
  box.className = BLOCKED_CLASS;
  const alt = (image.getAttribute('alt') ?? '').trim();
  if (alt) box.textContent = alt;
  const width = numberAttribute(image, 'width');
  const height = numberAttribute(image, 'height');
  const style = image.getAttribute('style');
  // Never wider than its column: a fixed width inside a table cell would hold the whole layout open.
  const sizes: string[] = [];
  const wide = width !== null && width > 2 ? Math.min(width, 2000) : null;
  const tall = height !== null && height > 2 ? Math.min(height, 600) : null;
  if (wide !== null) sizes.push(`width:min(${wide}px,100%)`);
  if (wide !== null && tall !== null) sizes.push(`aspect-ratio:${wide}/${tall}`);
  else if (tall !== null) sizes.push(`height:${tall}px`);
  // The picture's own display, as a box that can centre its words.
  const own = (style ?? '').replace(/display\s*:\s*(inline-)?block/gi, (_, inline: string | undefined) => `display:${inline ? 'inline-flex' : 'flex'}`);
  box.setAttribute('style', [own, ...sizes].filter(Boolean).join(';'));
  for (const name of ['align', 'title']) {
    const value = image.getAttribute(name);
    if (value !== null) box.setAttribute(name, value);
  }
  return box;
}

/** Colour attributes of `<body>`, as a declaration the frame's body can wear. */
function bodyStyleOf(body: HTMLElement | null, blocked: BlockedContent, tally: PictureTally): string {
  if (!body) return '';
  const parts: string[] = [];
  const bgcolor = body.getAttribute('bgcolor');
  if (bgcolor && /^#?[\w]{3,20}$/.test(bgcolor.trim())) parts.push(`background-color:${bgcolor.trim()}`);
  const text = body.getAttribute('text');
  if (text && /^#?[\w]{3,20}$/.test(text.trim())) parts.push(`color:${text.trim()}`);
  const style = body.getAttribute('style');
  if (style) parts.push(cleanStyleAttribute(style, blocked, tally));
  return parts.filter(Boolean).join(';');
}

/** Elements whose content DOMPurify drops along with them: a picture set on them is never seen. */
const DROPPED_WITH_CONTENT = 'svg, math, template, noscript, iframe, object, embed, audio, video, script, style, title, head';

/**
 * Sanitises a mail's HTML body. `hasPart(cid)` tells whether the message carries a part with that
 * (normalised) Content-ID. `options.remotePictures` lets remote pictures load (see the top of the file).
 */
export function prepareMailHtml(html: string, hasPart: (cid: string) => boolean, options: PrepareMailOptions = {}): PreparedMailHtml {
  const blocked = emptyBlocked();
  const tally: PictureTally = { load: options.remotePictures === true, count: 0 };
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  // ── what DOMPurify will remove, counted first ──────────────────────────────────────────────────
  blocked.scripts += parsed.querySelectorAll('script').length;
  blocked.forms += parsed.querySelectorAll('form').length;
  for (const element of Array.from(parsed.querySelectorAll(EMBED_SELECTOR))) {
    if (element.hasAttribute('src') || element.hasAttribute('data') || element.querySelector('source[src]')) blocked.embeds += 1;
  }
  for (const link of Array.from(parsed.querySelectorAll('link[href]'))) {
    if (/\bstylesheet\b/i.test(link.getAttribute('rel') ?? '')) blocked.styles += 1;
  }
  for (const element of Array.from(parsed.querySelectorAll('[background]'))) {
    const value = element.getAttribute('background') ?? '';
    if (!REMOTE.test(value)) continue;
    const address = remotePictureAddress(value, true);
    const kept = element.namespaceURI === 'http://www.w3.org/1999/xhtml' && !FORBIDDEN_TAGS.includes(element.localName) && !element.closest(DROPPED_WITH_CONTENT);
    if (address !== null && tally.load && kept) {
      // The attribute is a hint beneath the element's own style: first, so the element's declarations
      // win. It is counted, and checked once more, when that style is cleaned.
      const own = element.getAttribute('style');
      element.setAttribute('style', own ? `background-image:url(${address});${own}` : `background-image:url(${address})`);
      continue;
    }
    if (address !== null && kept) tally.count += 1;
    blocked.images += 1;
  }
  const css = Array.from(parsed.querySelectorAll('style'))
    // A style element inside MathML or SVG is the classic mutation-XSS carrier, not the message's styles.
    .filter((style) => style.namespaceURI === 'http://www.w3.org/1999/xhtml' && !style.closest('math, svg'))
    .map((style) => cleanStyleSheet(style.textContent ?? '', blocked, tally))
    .filter((sheet) => sheet.trim() !== '')
    .join('\n');
  const bodyStyle = bodyStyleOf(parsed.body, blocked, tally);

  const fragment = DOMPurify.sanitize(parsed.body ?? parsed.documentElement, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  }) as unknown as DocumentFragment;

  // ── what is left: styles cleaned, pictures resolved or boxed, addresses kept only where safe ──
  const cids = new Set<string>();
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    const tag = element.localName.toLowerCase();
    // The frame's own class for blocked pictures is not the message's to use.
    if (element.classList.contains(BLOCKED_CLASS)) element.classList.remove(BLOCKED_CLASS);
    const before = tally.count;
    const style = element.getAttribute('style');
    if (style !== null) {
      const clean = cleanStyleAttribute(style, blocked, tally);
      if (clean) element.setAttribute('style', clean);
      else element.removeAttribute('style');
    }

    if (tag === 'img') {
      const address = (element.getAttribute('src') ?? '').trim();
      element.removeAttribute('src');
      // A picture that goes takes the backgrounds of its own style with it: those are not shown either.
      const drop = (): void => {
        if (tally.load) blocked.images += tally.count - before;
        tally.count = before;
        element.remove();
      };
      if (/^cid:/i.test(address)) {
        const cid = normalizeContentId(address.slice(4));
        if (cid && hasPart(cid)) {
          element.setAttribute(CID_ATTRIBUTE, cid);
          cids.add(cid);
        } else if ((element.getAttribute('alt') ?? '').trim()) {
          element.replaceWith(blockedBox(element));
        } else {
          drop();
        }
      } else if (SAFE_DATA_IMAGE.test(address)) {
        element.setAttribute('src', address);
      } else if (REMOTE.test(address)) {
        if (isTracker(element)) {
          // Even when pictures are shown: loading it would tell the sender exactly what it was put there to tell.
          blocked.trackers += 1;
          drop();
          continue;
        }
        const remote = remotePictureAddress(address);
        if (remote !== null) tally.count += 1;
        if (remote !== null && tally.load) {
          element.setAttribute('src', remote);
          element.setAttribute('referrerpolicy', 'no-referrer');
          element.setAttribute('decoding', 'async');
          element.removeAttribute('crossorigin');
        } else {
          blocked.images += 1;
          element.replaceWith(blockedBox(element));
        }
      } else {
        drop();
      }
      continue;
    }

    if (tag === 'a') {
      const address = (element.getAttribute('href') ?? '').trim();
      element.removeAttribute('href');
      if (address.startsWith('#') || /^(?:https?:|mailto:)/i.test(address)) element.setAttribute('href', address);
      continue;
    }

    // Anything else that points somewhere may only point inside the same document.
    for (const name of ['src', 'href', 'xlink:href', 'data', 'cite', 'longdesc', 'formaction', 'action']) {
      const value = element.getAttribute(name);
      if (value !== null && !value.startsWith('#')) element.removeAttribute(name);
    }
  }

  const visible = (fragment.textContent ?? '').trim() !== '' || fragment.querySelector(`img, .${BLOCKED_CLASS}, hr`) !== null;
  return { fragment, css, bodyStyle, blocked, cids, visible, pictures: tally.count };
}
