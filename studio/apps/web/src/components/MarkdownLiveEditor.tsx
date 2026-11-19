// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { liveMarkdownLanguage } from './markdown-language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { liveMarkdownDecorations, sourceMode, type RenderFragment } from './markdown-live-decorations';
import { isMarkdownImageFile } from './markdown-source';
import { MarkdownDraft, draftField, markdownDraftState } from './markdown-draft';

export interface MarkdownScrollLayout {
  scroller: HTMLElement;
  blockOffsets(lines: readonly number[]): number[];
}

interface Props {
  source?: boolean;
  layoutRef?: MutableRefObject<MarkdownScrollLayout | null>;
  onScroll?: () => void;
  onScrollIntent?: () => void;
  active?: boolean;
  value: string | MarkdownDraft;
  label: string;
  hint: string;
  render: RenderFragment;
  onChange(value: MarkdownDraft): void;
  onSave(): void;
  onImages(files: File[]): Promise<string | null>;
}

export default function MarkdownLiveEditor(props: Props) {
  const viewRef = useRef<EditorView | null>(null);
  const showingSource = useRef(!!props.source);
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const draft = useRef<MarkdownDraft | null>(null);
  const resetDocument = useRef<((value: string | MarkdownDraft) => void) | null>(null);

  useLayoutEffect(() => {
    if (!host.current) return;
    let disposed = false;
    // Track an upload's original selection through intervening typing.
    const uploads = new Set<{ from: number; to: number }>();
    const insertImages = (view: EditorView, files: File[], from: number, to = from) => {
      const selection = { from, to };
      uploads.add(selection);
      void current.current.onImages(files).then(snippet => {
        if (snippet && !disposed && uploads.has(selection)) {
          const caret = view.state.selection.main;
          const stillHere = caret.from === selection.from && caret.to === selection.to;
          view.dispatch({
            changes: { ...selection, insert: snippet },
            ...(stillHere ? { selection: { anchor: selection.from + snippet.length } } : {}),
            userEvent: 'input.paste',
          });
        }
      }).finally(() => uploads.delete(selection));
    };
    const render: RenderFragment = (source, width) => current.current.render(source, width);
    const extensions = (initial: MarkdownDraft) => [
      history(), markdownDraftState(initial), liveMarkdownLanguage(initial.doc.length), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': props.label, spellcheck: 'true', 'aria-multiline': 'true' }),
      placeholder(props.hint), liveMarkdownDecorations(render, !!current.current.source),
      keymap.of([{ key: 'Mod-s', run: () => { current.current.onSave(); return true; } }, ...defaultKeymap, ...historyKeymap]),
      EditorView.domEventHandlers({
        paste(event, view) {
          const images = Array.from(event.clipboardData?.files ?? []).filter(isMarkdownImageFile);
          if (!images.length) return false;
          const { from, to } = view.state.selection.main;
          insertImages(view, images, from, to);
          return true;
        },
        drop(event, view) {
          const images = Array.from(event.dataTransfer?.files ?? []).filter(isMarkdownImageFile);
          if (!images.length) return false;
          insertImages(view, images, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head);
          return true;
        },
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        for (const selection of uploads) {
          selection.from = update.changes.mapPos(selection.from, 1);
          selection.to = Math.max(selection.from, update.changes.mapPos(selection.to, -1));
        }
        const next = update.state.field(draftField);
        draft.current = next;
        current.current.onChange(next);
      }),
    ];
    const open = (value: string | MarkdownDraft) => typeof value === 'string' ? MarkdownDraft.open(value) : value;
    draft.current = open(current.current.value);
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: draft.current.doc, extensions: extensions(draft.current) }) });
    viewRef.current = view;
    showingSource.current = !!current.current.source;
    const layoutRef = current.current.layoutRef;
    if (layoutRef) layoutRef.current = {
      scroller: view.scrollDOM,
      blockOffsets(lines) {
        const doc = view.state.doc;
        const padding = view.documentPadding.top;
        return lines.map(n => view.lineBlockAt(doc.line(Math.min(n, doc.lines)).from).top + padding);
      },
    };
    const onScroll = () => current.current.onScroll?.();
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    resetDocument.current = value => {
      uploads.clear();
      draft.current = open(value);
      const doc = draft.current.doc;
      const head = Math.min(view.state.selection.main.head, doc.length);
      view.setState(EditorState.create({ doc, selection: { anchor: head }, extensions: extensions(draft.current) }));
    };
    return () => {
      disposed = true;
      resetDocument.current = null;
      viewRef.current = null;
      if (layoutRef) layoutRef.current = null;
      view.scrollDOM.removeEventListener('scroll', onScroll);
      view.destroy();
    };
  }, [props.label, props.hint]);

  useLayoutEffect(() => {
    if (props.active === false || draft.current?.matches(props.value)) return;
    // This value came from disk. Do not enqueue an edit or let Undo resurrect stale file contents.
    resetDocument.current?.(props.value);
  }, [props.value, props.active]);
  useLayoutEffect(() => {
    if (props.active === false || showingSource.current === !!props.source) return;
    showingSource.current = !!props.source;
    viewRef.current?.dispatch({ effects: sourceMode.of(!!props.source) });
  }, [props.active, props.source]);
  return <div className="md-live-editor" data-md-layer="editor" data-md-source={props.source ? 'true' : undefined}
    data-pane-visible={props.active !== false} aria-hidden={props.active === false || undefined} data-testid="markdown-live-editor"
    ref={host} onPointerDown={props.onScrollIntent} onWheel={props.onScrollIntent} onFocus={props.onScrollIntent} />;

}
