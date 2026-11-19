// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pdf.js web/text_layer_builder.js @ v6.5.438 (Apache-2.0, Mozilla Foundation): the
// selection handling of the text layer (`#bindMouse`, `#enableGlobalSelectionListener`). Changed
// here: a module with a register/unregister pair instead of static class members, class names
// passed in (CSS Modules), the layer is found by a data attribute, and the copy handler is left out
// because this viewer asks pdf.js for normalised text.
//
// Why it exists: a text layer is hundreds of absolutely positioned spans. Without help, dragging a
// selection over the empty space between two lines makes the browser select everything up to the end
// of the page, so the highlight flickers. pdf.js's cure is one empty element ("end of content") that
// covers the layer while a selection is being dragged and is moved next to the selection's moving
// end, so the browser always has somewhere near to anchor. Chromium 148 and later no longer need
// the move; the desktop app ships an older Chromium, so it stays.

const layers = new Map<HTMLElement, HTMLElement>();
let listeners: AbortController | null = null;

export interface PdfTextLayerClasses {
  /** On the layer while a selection is being dragged through it. */
  selecting: string;
  /** The empty element appended after the text. */
  endOfContent: string;
}

let classes: PdfTextLayerClasses | null = null;

function reset(end: HTMLElement, layer: HTMLElement): void {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  if (classes) layer.classList.remove(classes.selecting);
}

function chromiumMajor(): number | null {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string; version: string }> } }).userAgentData?.brands;
  const version = brands?.find(({ brand }) => brand === 'Chromium')?.version ?? /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
  const major = version ? Number.parseInt(version, 10) : Number.NaN;
  return Number.isFinite(major) ? major : null;
}

function enableGlobalListeners(): void {
  if (listeners) return;
  listeners = new AbortController();
  const { signal } = listeners;
  let pointerDown = false;
  let anchorsItself: boolean | undefined;
  let previousRange: Range | null = null;

  document.addEventListener('pointerdown', () => (pointerDown = true), { signal });
  document.addEventListener(
    'pointerup',
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    'blur',
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    'keyup',
    () => {
      if (!pointerDown) layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    'selectionchange',
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(reset);
        return;
      }
      const active = new Set<HTMLElement>();
      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        if (range.collapsed && !pointerDown) continue;
        for (const layer of layers.keys()) {
          if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
        }
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) {
          if (classes) layer.classList.add(classes.selecting);
        } else {
          reset(end, layer);
        }
      }

      anchorsItself ??= (chromiumMajor() ?? 0) >= 148;
      if (anchorsItself) return;

      const range = selection.getRangeAt(0);
      const movesStart =
        previousRange !== null &&
        (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);
      let anchor: Node | null = movesStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!movesStart && range.endOffset === 0) {
        // The selection ends at the very start of a node: the node before it is the real end.
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && !anchor.childNodes.length);
      }
      const parent = anchor?.parentElement ?? null;
      const layer = parent?.closest<HTMLElement>('[data-pdf-text-layer]') ?? null;
      const end = layer ? layers.get(layer) : undefined;
      if (anchor && parent && layer && end) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        end.style.userSelect = 'text';
        parent.insertBefore(end, movesStart ? anchor : anchor.nextSibling);
      }
      previousRange = range.cloneRange();
    },
    { signal },
  );
}

/**
 * Makes selecting text in a rendered layer steady. Call once the layer's text is in place; the
 * returned function undoes it (call it before the layer is emptied or removed).
 */
export function steadyPdfTextSelection(layer: HTMLElement, names: PdfTextLayerClasses): () => void {
  classes = names;
  const end = document.createElement('div');
  end.className = names.endOfContent;
  layer.append(end);
  const onMouseDown = (): void => layer.classList.add(names.selecting);
  layer.addEventListener('mousedown', onMouseDown);
  layers.set(layer, end);
  enableGlobalListeners();

  return () => {
    layer.removeEventListener('mousedown', onMouseDown);
    layers.delete(layer);
    end.remove();
    layer.classList.remove(names.selecting);
    if (layers.size === 0) {
      listeners?.abort();
      listeners = null;
    }
  };
}
