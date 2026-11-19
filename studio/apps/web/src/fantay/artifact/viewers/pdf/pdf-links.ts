// SPDX-License-Identifier: AGPL-3.0-only
// The links on a page, read from its annotations and turned into plain data the page draws as hit
// areas. A link inside the document becomes a page and a height on it. A link to the outside keeps
// only the address pdf.js has already sanitised (http, https, mailto, tel, ftp); the viewer never
// navigates to it. Anything else an annotation can carry (scripts, launch actions, attachments,
// form submission) is dropped here and so cannot be triggered.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/** A place in the document. */
export interface PdfLinkTarget {
  /** 0-based. */
  page: number;
  /** How far down the page, as a fraction of its height; null for the top of the page. */
  offset: number | null;
}

export interface PdfLink {
  /** The hit area, in percent of the page box. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** An address outside the document. */
  url?: string;
  /** A place inside it. */
  target?: PdfLinkTarget;
}

/** More hit areas than this on one page are not drawn (a generated index can have thousands). */
const MAX_LINKS_PER_PAGE = 400;

interface LinkAnnotation {
  subtype?: string;
  rect?: unknown;
  url?: unknown;
  dest?: unknown;
  action?: unknown;
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length >= length && value.slice(0, length).every((item) => typeof item === 'number' && Number.isFinite(item));
}

/** The vertical PDF coordinate a destination asks for, when it names one. */
export function pdfDestinationTop(destination: readonly unknown[]): number | null {
  const kind = destination[1];
  const name = typeof kind === 'object' && kind !== null && 'name' in kind ? String((kind as { name: unknown }).name) : '';
  const numberAt = (index: number): number | null => {
    const value = destination[index];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  if (name === 'XYZ') return numberAt(3);
  if (name === 'FitH' || name === 'FitBH') return numberAt(2);
  if (name === 'FitR') return numberAt(5);
  return null;
}

/** Resolves a named or explicit destination to a page and a height on it. */
export async function resolvePdfDestination(pdf: PDFDocumentProxy, dest: unknown): Promise<PdfLinkTarget | null> {
  const destination = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(destination) || destination.length === 0) return null;
  const reference: unknown = destination[0];
  let page: number;
  if (typeof reference === 'number' && Number.isInteger(reference)) page = reference;
  else if (typeof reference === 'object' && reference !== null) page = await pdf.getPageIndex(reference as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
  else return null;
  if (page < 0 || page >= pdf.numPages) return null;

  const top = pdfDestinationTop(destination);
  if (top === null) return { page, offset: null };
  const viewport = (await pdf.getPage(page + 1)).getViewport({ scale: 1 });
  const [, y] = viewport.convertToViewportPoint(0, top) as [number, number];
  return { page, offset: Math.min(1, Math.max(0, y / viewport.height)) };
}

/** The four page-turning actions a PDF can name. */
function namedActionTarget(action: unknown, pageIndex: number, pageCount: number): PdfLinkTarget | null {
  if (action === 'NextPage') return { page: Math.min(pageCount - 1, pageIndex + 1), offset: null };
  if (action === 'PrevPage') return { page: Math.max(0, pageIndex - 1), offset: null };
  if (action === 'FirstPage') return { page: 0, offset: null };
  if (action === 'LastPage') return { page: pageCount - 1, offset: null };
  return null;
}

export async function readPdfLinks(pdf: PDFDocumentProxy, page: PDFPageProxy, pageIndex: number): Promise<PdfLink[]> {
  const annotations = (await page.getAnnotations({ intent: 'display' })) as LinkAnnotation[];
  const viewport = page.getViewport({ scale: 1 });
  const links: PdfLink[] = [];
  for (const annotation of annotations) {
    if (links.length >= MAX_LINKS_PER_PAGE) break;
    if (annotation.subtype !== 'Link' || !isNumberArray(annotation.rect, 4)) continue;
    const [x1, y1, x2, y2] = annotation.rect as [number, number, number, number];
    const [ax, ay] = viewport.convertToViewportPoint(x1, y1) as [number, number];
    const [bx, by] = viewport.convertToViewportPoint(x2, y2) as [number, number];
    const box = {
      left: (Math.min(ax, bx) / viewport.width) * 100,
      top: (Math.min(ay, by) / viewport.height) * 100,
      width: (Math.abs(bx - ax) / viewport.width) * 100,
      height: (Math.abs(by - ay) / viewport.height) * 100,
    };
    if (!(box.width > 0 && box.height > 0)) continue;

    if (typeof annotation.url === 'string' && annotation.url) {
      links.push({ ...box, url: annotation.url });
      continue;
    }
    let target: PdfLinkTarget | null = null;
    if (annotation.dest !== undefined && annotation.dest !== null) {
      // A destination that does not resolve (a broken reference) is simply not a link.
      target = await resolvePdfDestination(pdf, annotation.dest).catch(() => null);
    } else {
      target = namedActionTarget(annotation.action, pageIndex, pdf.numPages);
    }
    if (target) links.push({ ...box, target });
  }
  return links;
}
