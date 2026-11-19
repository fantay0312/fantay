// SPDX-License-Identifier: AGPL-3.0-only
// Word documents (.docx, .docm, .dotx) through docx-preview. Three steps around the library:
//  - before: look at the container without inflating it (is it a Word file at all, is it encrypted,
//    is any part too large to lay out), and read the page count Word saved with the file;
//  - render: only `renderAsync` (the one stable entry), with embedded HTML parts turned off and
//    pictures and fonts carried as data addresses, so the result holds no address that could be
//    fetched and leaves no object URL behind;
//  - after: remove anything that could load or run, give every page its own sheet, and append
//    stand-in fonts to the ones the document names.
// docx-preview builds DOM nodes from the document's XML; it does not parse HTML from the file (the
// one feature that does, `renderAltChunks`, is off). The result is shown in the script-less frame.
// Macros (.docm) are never read.
import { strFromU8 } from 'fflate';

import { looksLikeZip, openArchive } from './archive';
import { withFontFallbacks } from './fonts';
import { ReadError } from './xml';

export const MAX_DOCX_BYTES = 80 * 1024 * 1024;
/** The XML of one part (the body, a header). Above this the layout would stall the tab. */
const MAX_PART_BYTES = 24 * 1024 * 1024;
export const DOCX_RENDER_TIMEOUT_MS = 25_000;

export type DocxProblem = 'not-word' | 'legacy' | 'encrypted' | 'too-complex';

export type DocxInspection = { ok: true; pages: number | null } | { ok: false; problem: DocxProblem };

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** "EncryptedPackage" as an OLE directory writes it (UTF-16LE). */
function hasEncryptedPackage(bytes: Uint8Array): boolean {
  const needle = Array.from('EncryptedPackage').flatMap((char) => [char.charCodeAt(0), 0]);
  const end = bytes.length - needle.length;
  outer: for (let offset = 0; offset <= end; offset += 1) {
    if (bytes[offset] !== needle[0]) continue;
    for (let index = 1; index < needle.length; index += 1) if (bytes[offset + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}

/** Looks at the container without laying anything out. Never throws. */
export function inspectDocx(bytes: Uint8Array): DocxInspection {
  if (OLE_MAGIC.every((value, index) => bytes[index] === value)) {
    // A password-protected Word file is an OLE container around the encrypted package; without that
    // stream it is an old binary .doc that was given a new extension.
    return { ok: false, problem: hasEncryptedPackage(bytes) ? 'encrypted' : 'legacy' };
  }
  if (!looksLikeZip(bytes)) return { ok: false, problem: 'not-word' };
  try {
    const archive = openArchive(bytes, { maxEntries: 8000, maxTotalBytes: 600 * 1024 * 1024 });
    if (!archive.resolve('[Content_Types].xml')) return { ok: false, problem: 'not-word' };
    let hasBody = false;
    for (const entry of archive.entries.values()) {
      const name = entry.name.toLowerCase();
      if (name.startsWith('word/') && name.endsWith('.xml')) {
        hasBody = true;
        if (entry.size > MAX_PART_BYTES) return { ok: false, problem: 'too-complex' };
      }
    }
    if (!hasBody) return { ok: false, problem: 'not-word' };
    let pages: number | null = null;
    const properties = archive.read('docProps/app.xml', 512 * 1024);
    if (properties) {
      const match = /<Pages>\s*(\d{1,6})\s*<\/Pages>/.exec(strFromU8(properties));
      const count = match ? Number(match[1]) : 0;
      if (count > 0) pages = count;
    }
    return { ok: true, pages };
  } catch (cause) {
    return { ok: false, problem: cause instanceof ReadError && cause.code === 'too-large' ? 'too-complex' : 'not-word' };
  }
}

/** The options every Word render uses. See the header for why each safety option is set. */
export const DOCX_RENDER_OPTIONS = {
  className: 'docx',
  inWrapper: true,
  breakPages: true,
  // Word marks where its own pages ended; using the marks gives sheets close to Word's pages.
  ignoreLastRenderedPageBreak: false,
  ignoreWidth: false,
  ignoreHeight: false,
  ignoreFonts: false,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderChanges: false,
  renderComments: false,
  // Embedded HTML parts would be parsed as markup from the file: never.
  renderAltChunks: false,
  // Pictures and fonts as data addresses: nothing to revoke, and nothing the frame's policy refuses.
  useBase64URL: true,
  experimental: false,
  debug: false,
} as const;

const REMOVED_ELEMENTS = 'script, iframe, frame, object, embed, applet, link, meta, base, form, audio, video, source, track';

/** Removes what could load or run from a rendered document. Works on a detached tree. */
export function hardenRendered(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll(REMOVED_ELEMENTS))) element.remove();
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'srcdoc' || name === 'ping') {
        element.removeAttribute(attribute.name);
      } else if ((name === 'src' || name === 'xlink:href' || (name === 'href' && element.localName !== 'a')) && !/^(?:data:|blob:|#)/i.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

/** Puts each page in its own sheet (the unscaled box that carries the paper's edge). Returns the sheets. */
export function wrapSheets(root: ParentNode, ownerDocument: Document): HTMLElement[] {
  const sheets: HTMLElement[] = [];
  for (const page of Array.from(root.querySelectorAll('section.docx'))) {
    const sheet = ownerDocument.createElement('div');
    sheet.className = 'sheet';
    page.replaceWith(sheet);
    sheet.append(page);
    sheets.push(sheet);
  }
  return sheets;
}

/** Stand-in fonts for inline `font-family` declarations. Works on a detached tree. */
export function applyInlineFontFallbacks(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[style*="font-family"]'))) {
    const family = element.style.fontFamily;
    if (family) element.style.fontFamily = withFontFallbacks(family);
  }
}

/** Stand-in fonts for the rules of the document's own style sheets. They must be in a document. */
export function applySheetFontFallbacks(styleHost: ParentNode): void {
  for (const element of Array.from(styleHost.querySelectorAll('style'))) {
    const sheet = (element as HTMLStyleElement).sheet;
    if (!sheet) continue;
    for (const rule of Array.from(sheet.cssRules)) {
      // Style rules only: in an `@font-face` rule, `font-family` is the face's own name.
      if (!('selectorText' in rule)) continue;
      const style = (rule as CSSStyleRule).style;
      if (!style) continue;
      if (style.fontFamily) style.fontFamily = withFontFallbacks(style.fontFamily);
      // Theme fonts are variables used at the front of longer lists: stand-ins, but no generic.
      for (const property of Array.from(style)) {
        if (property.startsWith('--') && property.endsWith('-font')) {
          const value = style.getPropertyValue(property).trim();
          if (value) style.setProperty(property, withFontFallbacks(value, false));
        }
      }
    }
  }
}
