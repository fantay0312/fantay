// Live Markdown uses decorations over the source. The selection always addresses the original text.
import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

import { mathMark, mayHoldMath, replaceMath, splitMathMarks } from '../fantay/artifact/math/find-math';

export type RenderFragment = (source: string, width: number) => string | Promise<string>;

class Fragment extends WidgetType {
  constructor(readonly source: string, readonly block: boolean, readonly render: RenderFragment) { super(); }
  eq(other: Fragment) { return other.source === this.source && other.block === this.block && other.render === this.render; }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = 'markdown-rendered md-live-fragment';
    el.textContent = this.source;
    const show = (html: string) => {
      // render uses the same safe Markdown renderer and project image resolver as the reading view.
      const template = document.createElement('template');
      template.innerHTML = html;
      const content = !this.block && template.content.firstElementChild?.tagName === 'P'
        ? template.content.firstElementChild.childNodes : template.content.childNodes;
      el.replaceChildren(...Array.from(content));
      if (el.isConnected) view.requestMeasure();
    };
    const html = this.render(this.source, view.contentDOM.clientWidth);
    if (typeof html === 'string') show(html);
    else void html.then(show).catch(() => {}); // The source stays visible if an optional renderer fails.
    el.onmousedown = event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const from = view.posAtDOM(el);
      const sourceLines = this.source.split('\n');
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest('tr');
      let line = 0;
      if (row && el.contains(row)) line = row.rowIndex === 0 ? 0 : row.rowIndex + 1;
      else if (target?.closest('pre') && sourceLines.length > 2) {
        const pre = target.closest('pre')!;
        const y = event.clientY - pre.getBoundingClientRect().top - parseFloat(getComputedStyle(pre).paddingTop);
        const lineHeight = parseFloat(getComputedStyle(pre).lineHeight) || 20;
        line = Math.max(1, Math.min(sourceLines.length - 2, Math.floor(y / lineHeight) + 1));
      }
      const lineStart = sourceLines.slice(0, line).reduce((n, text) => n + text.length + 1, 0);
      const cell = target?.closest('td, th')?.textContent;
      const column = cell ? Math.max(0, sourceLines[line]?.indexOf(cell) ?? 0) : 0;
      view.dispatch({ selection: { anchor: from + Math.min(this.source.length, lineStart + column) } });
      view.focus();
    };
    return el;
  }
}

// Never synchronously expand a giant code fence, table or math paragraph into a second DOM
// inside the writing surface. Its source stays editable and Reading view still renders it.
const MAX_FRAGMENT_LENGTH = 32 * 1024;
export const sourceMode = StateEffect.define<boolean>();
const plainSource = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.find(e => e.is(sourceMode))?.value ?? value,
});
const focus = StateEffect.define<boolean>();
const viewport = StateEffect.define<{ from: number; to: number }>();
const inlineStyles: Record<string, string> = {
  StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'strike', InlineCode: 'code',
};
const delimiters = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'QuoteMark']);
const focusState = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.find(e => e.is(focus))?.value ?? value,
});

export function liveMarkdownDecorations(render: RenderFragment, initiallySource = false) {
  const windowField = StateField.define<{ from: number; to: number }>({
    create: s => ({ from: 0, to: Math.min(s.doc.length, 4000) }),
    update: (w, tr) => tr.effects.find(e => e.is(viewport))?.value ??
      { from: tr.changes.mapPos(w.from), to: tr.changes.mapPos(w.to, 1) },
  });
  function build(state: EditorState): DecorationSet {
    if (state.field(plainSource)) return Decoration.none;
    const doc = state.doc;
    const window = state.field(windowField);
    const selections = state.field(focusState) ? state.selection.ranges.map(r => ({
      from: doc.lineAt(r.from).from, to: doc.lineAt(r.to).to,
    })) : [];
    const ranges: Range<Decoration>[] = [];
    const styled = (from: number, to: number, name: string) => {
      ranges.push(Decoration.mark({ class: 'md-live-' + name }).range(from, to));
    };
    const formulaRanges: Array<{ from: number; to: number }> = [];
    let formulaIndex = 0;
    syntaxTree(state).iterate({ ...window, enter(node) {
      const { name, from, to } = node;
      if (from === to) return;
      while (formulaIndex < formulaRanges.length && formulaRanges[formulaIndex]!.to <= from) formulaIndex++;
      const formula = formulaRanges[formulaIndex];
      if (formula && formula.from <= from && to <= formula.to) return false;
      const active = selections.some(r => r.from <= to && from <= r.to);
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) ranges.push(Decoration.line({ class: 'md-live-h' + heading[1] }).range(doc.lineAt(from).from));
      if (inlineStyles[name]) styled(from, to, inlineStyles[name]!);
      if (name === 'QuoteMark') ranges.push(Decoration.line({ class: 'md-live-quote' }).range(doc.lineAt(from).from));
      const complex = name === 'Table' || name === 'FencedCode' || name === 'CodeBlock' || name === 'HorizontalRule';
      const inline = name === 'Image' || name === 'Link' && node.node.getChild('URL') !== null;
      const oversized = to - from > MAX_FRAGMENT_LENGTH;
      if (oversized && complex) {
        if (name === 'FencedCode' || name === 'CodeBlock') styled(from, to, 'code');
        return false;
      }
      if (!active && !oversized && (complex || inline)) {
        const block = complex && from === doc.lineAt(from).from && to === doc.lineAt(to).to;
        ranges.push(Decoration.replace({ widget: new Fragment(doc.sliceString(from, to), block, render), block }).range(from, to));
        return false;
      }
      if (name === 'Paragraph' && !active && !oversized) {
        const paragraph = doc.sliceString(from, to);
        if (mayHoldMath(paragraph, { backslash: true })) {
          const formulas: string[] = [];
          const mark = (_tex: string, written: string) => mathMark(formulas.push(written) - 1);
          const marked = replaceMath(paragraph, mark, mark, { backslash: true });
          let at = from;
          for (const part of splitMathMarks(marked)) {
            if (typeof part === 'string') { at += part.length; continue; }
            const source = formulas[part];
            if (!source || doc.sliceString(at, at + source.length) !== source) break;
            const end = at + source.length;
            const block = at === doc.lineAt(at).from && end === doc.lineAt(end).to;
            ranges.push(Decoration.replace({ widget: new Fragment(source, block, render), block }).range(at, end));
            formulaRanges.push({ from: at, to: end });
            at = end;
          }
        }
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        styled(from, to, 'code');
        return false;
      }
      if (name === 'ListMark' && !active && /^[-+*]$/.test(doc.sliceString(from, to))) {
        ranges.push(Decoration.replace({ widget: bullet }).range(from, to));
      } else if (name === 'TaskMarker' && !active) {
        ranges.push(Decoration.replace({ widget: new TaskMarker(doc.sliceString(from, to).toLowerCase() === '[x]', doc.sliceString(to, Math.min(to + 160, doc.lineAt(to).to)).trim()) }).range(from, to));
      } else if (delimiters.has(name)) {
        if (active) styled(from, to, 'syntax');
        else {
          const space = (name === 'HeaderMark' || name === 'QuoteMark') && doc.sliceString(to, to + 1) === ' ';
          ranges.push(Decoration.replace({}).range(from, to + (space ? 1 : 0)));
        }
      }
    } });
    return Decoration.set(ranges, true);
  }
  const decorations = StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      if (tr.state.field(plainSource)) return Decoration.none;
      if (tr.effects.some(e => e.is(sourceMode))) return build(tr.state);
      if (tr.docChanged || tr.effects.some(e => e.is(viewport) || e.is(focus))
        || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return build(tr.state);
      if (tr.selection && tr.state.field(focusState)) {
        const previous = tr.startState.selection.ranges;
        const next = tr.selection.ranges;
        // Revealed syntax depends on the selected lines, not the caret column within them.
        const lineAt = (pos: number) => tr.state.doc.lineAt(pos).number;
        if (previous.length !== next.length || next.some((r, i) =>
          lineAt(previous[i]!.from) !== lineAt(r.from) || lineAt(previous[i]!.to) !== lineAt(r.to))) return build(tr.state);
      }
      return value;
    },
    provide: field => EditorView.decorations.from(field),
  });
  // Only decorate the vicinity of the viewport, including on long documents.
  const followViewport = ViewPlugin.fromClass(class {
    frame = 0;
    constructor(readonly view: EditorView) { this.schedule(); }
    update(update: ViewUpdate) { if (update.viewportChanged) this.schedule(); }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const { from, to } = this.view.viewport;
        const held = this.view.state.field(windowField);
        if (held.from !== from || held.to !== to) this.view.dispatch({ effects: viewport.of({ from, to }) });
      });
    }
    destroy() { cancelAnimationFrame(this.frame); }
  });
  return [plainSource.init(() => initiallySource), windowField, focusState, decorations, followViewport, EditorView.focusChangeEffect.of((_, on) => focus.of(on))];
}

const bullet = new class extends WidgetType {
  toDOM() { const el = document.createElement('span'); el.textContent = '•'; return el; }
  ignoreEvent() { return false; }
}();

class TaskMarker extends WidgetType {
  constructor(readonly checked: boolean, readonly label: string) { super(); }
  eq(other: TaskMarker) { return this.checked === other.checked && this.label === other.label; }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.label || '☑');
    box.onmousedown = event => event.preventDefault();
    box.onclick = () => {
      const from = view.posAtDOM(box);
      view.dispatch({ changes: { from, to: from + 3, insert: this.checked ? '[ ]' : '[x]' }, userEvent: 'input' });
    };
    return box;
  }
}
