// SPDX-License-Identifier: AGPL-3.0-only
// Two things the shared code pane does not do by itself, added from outside through CodeMirror's
// public API: putting the reader back where they were (CodeMirror's own scroll snapshot, which
// anchors on a document position, so it survives wrapping and estimated line heights), and tinting
// the runs a terminal log had coloured. The pane's view is found through the DOM it was mounted in
// (`EditorView.findFromDOM`), so `CodePane` itself stays unchanged.
//
// This module imports CodeMirror. Load it only through `import()` (see `use-code-view.ts`): it must
// stay out of the server render and shares the chunk the code pane already loads.
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

import type { AnsiSpan } from './ansi';

/** Opaque to callers: CodeMirror's scroll snapshot effect. */
export type CodeScrollSnapshot = StateEffect<unknown>;

export interface CodeViewBinding {
  /** Tints these runs; an empty list clears them. */
  setSpans(spans: readonly AnsiSpan[]): void;
  release(): void;
}

const setSpansEffect = StateEffect.define<readonly AnsiSpan[]>();

const spansField = StateField.define<readonly AnsiSpan[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSpansEffect)) return effect.value;
    return value;
  },
});

const marks = new Map<string, Decoration>();

/** One mark per look. The classes are styled by the text viewer's stylesheet. */
function markFor(span: AnsiSpan): Decoration {
  const name = `${span.tone ?? 'plain'}${span.bold ? '-bold' : ''}`;
  let mark = marks.get(name);
  if (!mark) {
    const classes = [span.tone ? `fx-ansi-${span.tone}` : '', span.bold ? 'fx-ansi-bold' : ''].filter(Boolean).join(' ');
    mark = Decoration.mark({ class: classes });
    marks.set(name, mark);
  }
  return mark;
}

/** Index of the first span that ends after `position` (spans are sorted and never overlap). */
function firstSpanAfter(spans: readonly AnsiSpan[], position: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((spans[middle]?.to ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Marks for the lines on screen only: a large log has far more coloured runs than anyone sees. */
function visibleMarks(view: EditorView): DecorationSet {
  const spans = view.state.field(spansField, false) ?? [];
  if (spans.length === 0) return Decoration.none;
  const length = view.state.doc.length;
  const ranges = [];
  let next = 0;
  for (const visible of view.visibleRanges) {
    for (let index = Math.max(next, firstSpanAfter(spans, visible.from)); index < spans.length; index += 1) {
      const span = spans[index];
      if (!span || span.from >= visible.to) break;
      // Spans describe the text they were parsed from; a newer text may be shorter for one update.
      const to = Math.min(span.to, length);
      if (span.from < to) ranges.push(markFor(span).range(span.from, to));
      next = index + 1;
    }
  }
  return Decoration.set(ranges);
}

const ansiPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = visibleMarks(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(spansField, false) !== update.state.field(spansField, false)
      ) {
        this.decorations = visibleMarks(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const ansiExtension: Extension = [spansField, ansiPlugin];

export interface CodeViewOptions {
  /** Where the reader was, from an earlier `onScroll`; null starts at the top. */
  restore: CodeScrollSnapshot | null;
  /** Called while the reader scrolls, with a snapshot to hand back as `restore` later. */
  onScroll(snapshot: CodeScrollSnapshot): void;
}

/** Binds to the code pane mounted inside `host`; null while the pane has not created its view yet. */
export function bindCodeView(host: HTMLElement, options: CodeViewOptions): CodeViewBinding | null {
  const view = EditorView.findFromDOM(host);
  if (!view) return null;

  if (options.restore) {
    try {
      view.dispatch({ effects: options.restore });
    } catch {
      // A snapshot that no longer fits the document only loses the position, never the text.
    }
  }

  const scroller = view.scrollDOM;
  const onScroll = (): void => {
    // A hidden scroller reports nothing useful; the last real position stays stored.
    if (scroller.clientHeight === 0) return;
    options.onScroll(view.scrollSnapshot());
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  return {
    setSpans(spans) {
      const installed = view.state.field(spansField, false) !== undefined;
      if (!installed && spans.length === 0) return;
      // The pane rebuilds its state for a new document, which drops what was appended: add it again.
      // Two steps: a field created by a transaction does not see that transaction's effects.
      if (!installed) view.dispatch({ effects: StateEffect.appendConfig.of(ansiExtension) });
      view.dispatch({ effects: setSpansEffect.of(spans) });
    },
    release() {
      scroller.removeEventListener('scroll', onScroll);
    },
  };
}
