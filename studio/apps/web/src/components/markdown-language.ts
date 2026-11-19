// SPDX-License-Identifier: AGPL-3.0-only
import { DocInput, Language, ParseContext, syntaxTree } from '@codemirror/language';
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction, type ChangeDesc } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { Parser, Tree, type Input, type NodeSet, type PartialParse } from '@lezer/common';
import type { MarkdownParseRequest, MarkdownParseResult } from './markdown-parser.worker';

const BACKGROUND_THRESHOLD = 64 * 1024;
const standard = markdown({ base: markdownLanguage });
const backgroundSupport = markdown({ base: markdownLanguage, addKeymap: false }).support;
const markdownTypes = (markdownLanguage.parser as Parser & { nodeSet: NodeSet }).nodeSet;
const documentType = markdownLanguage.parser.parse('').type;
const setOutline = StateEffect.define<readonly number[]>();

function mapOutline(buffer: readonly number[], changes: ChangeDesc) {
  const mapped = buffer.slice();
  for (let i = 0; i < mapped.length; i += 4) {
    const from = changes.mapPos(buffer[i + 1]!, 1);
    mapped[i + 1] = from;
    mapped[i + 2] = Math.max(from, changes.mapPos(buffer[i + 2]!, -1));
  }
  return mapped;
}

const outline = StateField.define<readonly number[]>({
  create: () => [],
  update(buffer, tr) {
    for (const effect of tr.effects) if (effect.is(setOutline)) return effect.value;
    if (!tr.docChanged || !buffer.length) return buffer;
    // Until the worker returns, keep the visible tree aligned with the newest text.
    return mapOutline(buffer, tr.changes);
  },
});

// CodeMirror's normal selection, decorations and Markdown key bindings all consume this same
// tree. Answer its synchronous parse requests from the viewport outline, without parsing the file.
class OutlineParser extends Parser {
  constructor(private readonly exact?: Tree) { super(); }
  createParse(input: Input): PartialParse {
    const state = ParseContext.get()?.state;
    const tree = this.exact ?? Tree.build({
      buffer: state?.field(outline, false) ?? [], nodeSet: markdownTypes,
      topID: documentType.id, length: input.length,
    });
    return { parsedPos: input.length, stoppedAt: null, stopAt() {}, advance: () => tree };
  }
}
const outlineParser = new OutlineParser();
const outlineLanguage = () => new Language(markdownLanguage.data, outlineParser, [], 'markdown');

// The viewport tree is sufficient for painting, but Enter may renumber every remaining
// sibling of an ordered list. Run structural commands against the complete enclosing block.
// Plain Enter/Backspace still go straight to the normal editor commands.
function structureCommand(view: EditorView, enter: boolean): boolean {
  const { state } = view;
  const doc = state.doc;
  let from = doc.length, to = 0;
  let relevant = false;
  let needExactBlock = false;
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    const line = doc.lineAt(range.head);
    const local = line.text.slice(0, 256);
    if (!enter && /[^ >\t0-9.*+()xX[\]-]/.test(local.slice(0, range.head - line.from))) continue;
    const tree = syntaxTree(state);
    let node = tree.resolveInner(range.head, -1);
    if (!node.parent) node = tree.resolveInner(line.from, 1);
    let list = false, ordered = false, code = false;
    for (let cur = node; cur.parent; cur = cur.parent) {
      list ||= /^(OrderedList|BulletList|Blockquote)$/.test(cur.name);
      ordered ||= cur.name === 'OrderedList';
      code ||= /^(FencedCode|CodeBlock)$/.test(cur.name);
      node = cur;
    }
    if (code || (!list && !/^\s*(?:>|[-+*]\s|\d+[.)]\s)/.test(local))) continue;
    relevant = true;
    needExactBlock ||= !list || (enter && ordered);
    if (!node.parent) {
      // A newly typed marker can precede the worker reply. An isolated new item needs only
      // its own line; never synchronously scan millions of characters to handle a cold Enter.
      if (line.length > 8192 || (line.number < doc.lines && doc.line(line.number + 1).length)) return false;
      from = Math.min(from, line.from);
      to = Math.max(to, line.to);
      continue;
    }
    from = Math.min(from, doc.lineAt(node.from).from);
    to = Math.max(to, doc.lineAt(Math.max(node.to, range.head)).to);
  }
  if (!relevant) return false;
  const command = enter ? insertNewlineContinueMarkup : deleteMarkupBackward;
  if (!needExactBlock) return command(view);
  const block = markdownLanguage.parser.parse(new DocInput(doc), [], [{ from, to }]);
  const tree = new Tree(documentType, [block], [from], doc.length);
  const exact = EditorState.create({ doc, selection: state.selection, extensions: [
    new Language(markdownLanguage.data, new OutlineParser(tree)), EditorState.tabSize.of(state.tabSize),
    EditorState.allowMultipleSelections.of(true),
  ] });
  return command({
    state: exact, dispatch: tr => view.dispatch({
      changes: tr.changes, selection: tr.selection, scrollIntoView: true,
      userEvent: tr.annotation(Transaction.userEvent),
    }),
  });
}

function backgroundMarkdown() {
  const language = new Compartment();
  const workerPlugin = ViewPlugin.fromClass(class {
    worker: Worker | null = null;
    revision = 0;
    ticket = 0;
    accepted = -1;
    recent: ChangeDesc[] = [];
    ranges: MarkdownParseRequest['ranges'] = [];
    pending: MarkdownParseResult | null = null;
    onCompositionEnd = () => queueMicrotask(() => {
      if (this.pending && this.worker) this.accept(this.pending);
    });
    accept(data: MarkdownParseResult) {
      this.pending = null;
      if (data.ticket <= this.accepted) return;
      const intervening = this.revision - data.revision;
      if (intervening > this.recent.length) return;
      // On a long file the next keystroke may beat every worker reply. Rebase recent results
      // through those edits so new markup still appears while the user is typing.
      const map = intervening ? this.recent.slice(-intervening).reduce((a, b) => a.composeDesc(b)) : null;
      if (!data.ranges.some(r => this.ranges.some(current =>
        current.from <= (map ? map.mapPos(r.to, 1) : r.to) && (map ? map.mapPos(r.from) : r.from) <= current.to))) return;
      this.accepted = data.ticket;
      const buffer = map ? mapOutline(data.buffer, map) : data.buffer;
      this.view.dispatch({
        effects: [setOutline.of(buffer), language.reconfigure(outlineLanguage())],
        annotations: Transaction.addToHistory.of(false),
      });
    }
    constructor(readonly view: EditorView) {
      try {
        this.worker = new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }: MessageEvent<MarkdownParseResult>) => {
          if (view.composing) this.pending = data;
          else this.accept(data);
        };
        view.contentDOM.addEventListener('compositionend', this.onCompositionEnd);
        this.worker.onerror = () => this.fallback();
        this.send({ source: view.state.doc.toString() });
      } catch { this.fallback(); }
    }
    fallback() {
      this.worker?.terminate();
      this.worker = null;
      // Keep Markdown working on hosts where workers are unavailable.
      queueMicrotask(() => {
        if (this.view.plugin(workerPlugin) === this) this.view.dispatch({ effects: language.reconfigure(markdownLanguage) });
      });
    }
    send(extra: Pick<MarkdownParseRequest, 'changes' | 'source'> = {}) {
      if (!this.worker) return;
      const vp = this.view.viewport;
      const doc = this.view.state.doc;
      // Long wrapped lines can span the whole viewport even when only a small slice is drawn.
      const ranges = this.view.visibleRanges;
      const visible = ranges.length && vp.to - vp.from > 32000 ? ranges : [vp];
      if (!extra.changes && extra.source === undefined &&
        visible.every(r => this.ranges.some(p => p.from <= r.from && r.to <= p.to))) return;
      this.ranges = visible.map(r => ({ from: Math.max(0, r.from - 1000), to: Math.min(doc.length, r.to + 1000) }));
      this.worker.postMessage({ revision: this.revision, ticket: ++this.ticket, ranges: this.ranges, ...extra } satisfies MarkdownParseRequest);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.revision++;
        this.recent.push(update.changes.desc);
        if (this.recent.length > 128) this.recent.shift();
        this.send({ changes: update.changes.toJSON() });
      } else if (update.viewportChanged) this.send();
    }
    destroy() {
      this.view.contentDOM.removeEventListener('compositionend', this.onCompositionEnd);
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
    }
  });
  return [outline, language.of(outlineLanguage()), backgroundSupport, workerPlugin, Prec.high(keymap.of([
    { key: 'Enter', run: v => structureCommand(v, true) },
    { key: 'Backspace', run: v => structureCommand(v, false) },
  ]))];
}

export function liveMarkdownLanguage(length: number) {
  const slot = new Compartment();
  const choose = (size: number) => size >= BACKGROUND_THRESHOLD ? backgroundMarkdown() : standard;
  return [
    slot.of(choose(length)),
    EditorState.transactionExtender.of(tr => {
      if (!tr.docChanged || (tr.startState.doc.length >= BACKGROUND_THRESHOLD) === (tr.newDoc.length >= BACKGROUND_THRESHOLD)) return null;
      return { effects: slot.reconfigure(choose(tr.newDoc.length)) };
    }),
  ];
}
