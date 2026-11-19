// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/DocumentPages.tsx (`sanitizeDocumentHtml`) and
// NotebookPreview.tsx (`inertNotebookMarkdown`) @ c5e6b24f (MIT): the allow-list idea (structure and
// text only, pictures only from `data:` addresses) and the rule that a saved notebook must not load
// anything or turn authored links into app actions. Changed here: the markup is drawn in the page
// itself, not in a frame, so the allow-list is stricter (no `style`, `class` or `id` at all, nothing
// that can run, load, submit, navigate the app or restyle it); Markdown goes through the product's
// own renderer; pasted attachments are resolved; TeX is typeset by KaTeX after sanitising (`math.ts`)
// and kept readable as its source until that engine is loaded.
//
// A notebook is untrusted input. Two kinds of markup come out of it: HTML outputs saved by a kernel
// (a pandas table, a styled report) and Markdown cells. Both end as an HTML string that is safe to
// put in the document as it is. Needs a DOM (DOMPurify); returns '' where there is none.
import DOMPurify from 'dompurify';

import { renderMarkdownToSafeHtml } from '../../../../artifacts/markdown';
import { markMath, protectMath, typesetMarkedMath } from '../../math/marked-math';
import { mathEngineReady } from './math';

export { markMath, protectMath } from '../../math/marked-math';

const STRUCTURE_TAGS = [
  'p', 'div', 'span', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'small', 'mark',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'figure', 'figcaption', 'img',
];

/** Pictures may only come from inside the notebook. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]*={0,2}$/i;

function toFragment(html: string, tags: readonly string[], attributes: readonly string[]): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [...tags],
    ALLOWED_ATTR: [...attributes],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

function toHtml(fragment: DocumentFragment): string {
  const container = document.createElement('div');
  container.append(fragment);
  // Markup that leaves nothing to read or look at (a chart that was only a script) counts as empty.
  if ((container.textContent ?? '').trim() === '' && container.querySelector('img') === null) return '';
  return container.innerHTML;
}

/**
 * An HTML output, reduced to structure and text. Nothing that survives can run, load, submit,
 * navigate or restyle the app: no scripts, frames, forms, links, styles, classes or ids, and
 * pictures only when they are embedded.
 */
export function sanitizeOutputHtml(html: string): string {
  if (typeof document === 'undefined') return '';
  const fragment = toFragment(html, STRUCTURE_TAGS, ['colspan', 'rowspan', 'src', 'alt']);
  for (const image of Array.from(fragment.querySelectorAll('img'))) {
    if (!DATA_IMAGE.test(image.getAttribute('src') ?? '')) image.remove();
  }
  return toHtml(fragment);
}

const ATTACHMENT_PREFIX = './notebook-attachment/';

/**
 * A Markdown cell as safe HTML. Links that leave the app stay links (they open outside); links that
 * would navigate the app become text. A picture shows only when it is an attachment saved in the
 * cell; one that points at the network or the disk is replaced by its description.
 */
export function renderNotebookMarkdown(source: string, attachments: Readonly<Record<string, string>> = {}): string {
  if (typeof document === 'undefined') return '';
  // `attachment:` is not an address the Markdown renderer lets through; a relative path is.
  // With the engine loaded, formulas are typeset; without it they stay readable as their source.
  const math = mathEngineReady() && source.includes('$') ? markMath(source) : null;
  const prepared = (math ? math.markdown : protectMath(source)).replace(/\]\(attachment:([^)\s]+)/g, (_match, name: string) => `](${ATTACHMENT_PREFIX}${name}`);
  const rendered = renderMarkdownToSafeHtml(prepared)
    // The renderer writes column alignment as a style; it is carried as the plain attribute instead.
    .replace(/ style="text-align:(left|center|right)"/g, ' align="$1"');

  const fragment = toFragment(
    rendered,
    [...STRUCTURE_TAGS, 'a', 'input'],
    ['href', 'src', 'alt', 'colspan', 'rowspan', 'align', 'start', 'type', 'checked', 'disabled'],
  );

  for (const image of Array.from(fragment.querySelectorAll('img'))) {
    const src = image.getAttribute('src') ?? '';
    let embedded: string | undefined;
    if (src.startsWith(ATTACHMENT_PREFIX)) {
      const name = src.slice(ATTACHMENT_PREFIX.length);
      try {
        embedded = attachments[decodeURIComponent(name)] ?? attachments[name];
      } catch {
        embedded = attachments[name];
      }
    }
    if (embedded) image.setAttribute('src', embedded);
    else image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
  }
  for (const link of Array.from(fragment.querySelectorAll('a'))) {
    if (/^(?:https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer noopener');
    } else {
      link.replaceWith(...Array.from(link.childNodes));
    }
  }
  // Only the task-list checkbox is an input here, and it cannot be changed.
  for (const input of Array.from(fragment.querySelectorAll('input'))) {
    if (input.getAttribute('type') === 'checkbox') input.setAttribute('disabled', '');
    else input.remove();
  }
  // A wide table scrolls inside its own box instead of pushing the page sideways.
  for (const table of Array.from(fragment.querySelectorAll('table'))) {
    table.parentElement?.setAttribute('data-table-scroll', '');
  }
  // After the allow-list on purpose: a typeset formula is markup KaTeX built, not the notebook's.
  if (math) typesetMarkedMath(fragment, math.formulas);
  return toHtml(fragment);
}
