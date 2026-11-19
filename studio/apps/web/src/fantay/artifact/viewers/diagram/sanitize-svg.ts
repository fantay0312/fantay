// SPDX-License-Identifier: AGPL-3.0-only
// The wall around a drawn diagram before it enters the page. pele already escapes text, drops
// `javascript:` and network-path links, allow-lists colours and ignores `themeCSS`; this is the
// second wall the pele security guide and the file-type rules (§9) ask for, because the SVG is put
// in the page inline (so it can take the theme's colours without being drawn again):
//  - DOMPurify with the SVG profile only, and the tags that can run, load or embed forbidden
//    (`script`, `style`, `foreignObject`, `image`, `use`, animation, frames);
//  - then one pass so that no address is left: `url(…)` other than `url(#id)`, `href` other than
//    `#id`, and style text that could spell an address or an import all go;
//  - links never navigate: an `<a>` keeps its address only as `data-diagram-link` (http, https,
//    mailto, tel), and the viewer copies it on click, as the PDF viewer does with external links;
//  - the root's own style keeps only the properties pele writes there, so front matter or an
//    `%%{init}%%` directive cannot place, layer or transform the drawing over the app.
import DOMPurify from 'dompurify';

const FORBIDDEN_TAGS = [
  'script', 'style', 'foreignObject', 'image', 'use', 'feImage', 'animate', 'animateMotion', 'animateTransform',
  'set', 'iframe', 'frame', 'object', 'embed', 'audio', 'video', 'canvas', 'link', 'meta', 'base', 'html', 'body',
];
const FORBIDDEN_ATTRIBUTES = ['target', 'ping', 'download', 'srcset', 'formaction', 'action'];

/** Addresses a diagram link may carry to the clipboard. */
const LINK_SCHEMES = /^(?:https?:|mailto:|tel:)/i;
/** An address or an import inside an attribute or a style: everything but a same-document `url(#id)`. */
const OUTSIDE_URL = /url\s*\(\s*(?!['"]?#)/i;
const UNSAFE_STYLE = /@import|expression\s*\(|\\|image-set|-moz-binding|behavior\s*:|javascript:/i;

/** What pele writes on the root `<svg>`'s style; anything else there is dropped. */
const ROOT_STYLE_PROPERTIES = /^(?:--_[a-z]+|--pele-series-\d+|max-width|height|color|font|font-family|font-size|letter-spacing|word-spacing|text-transform|direction)$/;

export interface SanitizedDiagram {
  svg: SVGSVGElement;
  /** The addresses of the links that were made inert, in document order. */
  links: string[];
}

function cleanRootStyle(element: Element): void {
  const raw = element.getAttribute('style');
  if (raw === null) return;
  const kept = raw
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const colon = declaration.indexOf(':');
      return colon > 0 && ROOT_STYLE_PROPERTIES.test(declaration.slice(0, colon).trim().toLowerCase());
    });
  if (kept.length > 0) element.setAttribute('style', kept.join(';'));
  else element.removeAttribute('style');
}

/**
 * Sanitises pele's SVG markup into a detached `<svg>` element that cannot run script, load anything
 * or navigate. Returns null when the markup is not one SVG drawing.
 */
export function sanitizeDiagramSvg(markup: string): SanitizedDiagram | null {
  const fragment = DOMPurify.sanitize(markup, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { svg: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    ADD_ATTR: ['role', 'aria-roledescription', 'aria-label', 'aria-labelledby', 'aria-describedby'],
    ALLOW_DATA_ATTR: true,
  }) as unknown as DocumentFragment;

  const svg = fragment.firstElementChild;
  if (!svg || svg.localName !== 'svg' || fragment.childElementCount !== 1) return null;

  const links: string[] = [];
  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      else if (OUTSIDE_URL.test(attribute.value) && name !== 'href' && name !== 'xlink:href') element.removeAttribute(attribute.name);
    }

    const style = element.getAttribute('style');
    if (style !== null && (OUTSIDE_URL.test(style) || UNSAFE_STYLE.test(style))) element.removeAttribute('style');

    const address = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (element.localName === 'a') {
      element.removeAttribute('href');
      element.removeAttribute('xlink:href');
      element.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
      element.removeAttribute('rel');
      const trimmed = address?.trim() ?? '';
      if (LINK_SCHEMES.test(trimmed)) {
        element.setAttribute('data-diagram-link', trimmed);
        links.push(trimmed);
      } else {
        element.removeAttribute('data-diagram-link');
      }
    } else if (address !== null && !address.startsWith('#')) {
      element.removeAttribute('href');
      element.removeAttribute('xlink:href');
      element.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    }
  }
  // Only links this pass made carry the attribute (a file cannot plant one on another element).
  for (const element of Array.from(svg.querySelectorAll('[data-diagram-link]'))) {
    if (element.localName !== 'a') element.removeAttribute('data-diagram-link');
  }
  cleanRootStyle(svg);
  return { svg: svg as SVGSVGElement, links };
}
