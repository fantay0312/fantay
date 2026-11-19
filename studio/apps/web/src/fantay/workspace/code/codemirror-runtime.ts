// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/components/markdown/PlaintextEditor.tsx and
// features/cc-agent/workdir-browse/FileBodyView.tsx @ 88941ba7 (Apache-2.0): one read-only
// CodeMirror 6 view whose wrapping, language, theme and merge layer sit in Compartments, so they
// change without rebuilding the view or losing the scroll position.
//
// This module pulls in all of CodeMirror. Import it only through `import()` (see CodeEditor.tsx):
// it must stay out of the server render and out of the workspace's first bundle.
import { standardKeymap } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { unifiedMergeView } from '@codemirror/merge';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';

import { editorTheme, syntaxStyle } from './codemirror-theme';
import { minimalTextChange } from './original-text';

export interface CodeEditorConfig {
  /** Identity of the document. A new key starts over: top of the file, no selection. */
  docKey: string;
  /** The text to show, with "\n" line breaks only. */
  text: string;
  /** File name, used to pick the language. */
  fileName: string;
  wrap: boolean;
  dark: boolean;
  /** The text before the turn; non-null shows the changes against it. */
  original: string | null;
  /** No syntax highlighting (a very large file). */
  plain: boolean;
  /** Translations of CodeMirror's own phrases ("Find", "$ unchanged lines", …). */
  phrases: Readonly<Record<string, string>>;
}

export interface CodeEditorHandle {
  update(next: CodeEditorConfig): void;
  destroy(): void;
}

function themeExtension(dark: boolean): Extension {
  return [editorTheme(dark), syntaxHighlighting(syntaxStyle(dark))];
}

function mergeExtension(original: string | null): Extension {
  if (original === null) return [];
  return unifiedMergeView({
    original,
    // Reading, not reviewing: no accept / reject buttons, and tint alone marks a change.
    mergeControls: false,
    gutter: false,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
}

function describeLanguage(config: CodeEditorConfig): LanguageDescription | null {
  if (config.plain) return null;
  const base = config.fileName.slice(config.fileName.lastIndexOf('/') + 1);
  return LanguageDescription.matchFilename(languages, base);
}

export function mountCodeEditor(parent: HTMLElement, initial: CodeEditorConfig): CodeEditorHandle {
  const wrap = new Compartment();
  const theme = new Compartment();
  const language = new Compartment();
  const merge = new Compartment();
  const phrases = new Compartment();

  let config = initial;
  let destroyed = false;
  // Grows with every language request, so a slow grammar for a file left behind is dropped.
  let languageRequest = 0;
  // Set when a document is swapped in while the view has no layout (the workspace keeps the surface
  // mounted behind other tabs). A hidden scroller ignores scroll writes and comes back at the offset
  // the previous file was read at, so the move to the top waits until the view is laid out again.
  let topPending = false;

  const createState = (next: CodeEditorConfig): EditorState =>
    EditorState.create({
      doc: next.text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // Not editable but focusable: find and select-all are keyboard commands of the focused text.
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': next.fileName }),
        lineNumbers(),
        highlightSpecialChars(),
        search({ top: true }),
        keymap.of([...searchKeymap, ...standardKeymap]),
        wrap.of(next.wrap ? EditorView.lineWrapping : []),
        theme.of(themeExtension(next.dark)),
        // A grammar that is already loaded goes in at once, so the text never flashes unstyled.
        language.of(describeLanguage(next)?.support ?? []),
        merge.of(mergeExtension(next.original)),
        phrases.of(EditorState.phrases.of(next.phrases)),
        EditorView.updateListener.of((update) => {
          if (!topPending || update.view.scrollDOM.clientHeight === 0) return;
          topPending = false;
          // After this update, not inside it: a view cannot be dispatched to while it is updating.
          queueMicrotask(() => {
            if (destroyed) return;
            // The margin is larger than the content's top padding, so the scroller lands on 0.
            update.view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start', yMargin: 64 }) });
          });
        }),
      ],
    });

  const view = new EditorView({ parent, state: createState(initial) });

  /** Loads the document's grammar unless `createState` could already put it in. */
  const loadLanguage = (): void => {
    languageRequest += 1;
    const request = languageRequest;
    const description = describeLanguage(config);
    if (!description || description.support) return;
    description.load().then(
      (support) => {
        if (destroyed || request !== languageRequest) return;
        view.dispatch({ effects: language.reconfigure(support) });
      },
      () => {
        // A grammar that fails to load leaves plain text, which is still the file.
      },
    );
  };

  /** The first document position on screen, so a layout change can put the same line back. */
  const topPosition = (): number => view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;

  loadLanguage();

  return {
    update(next) {
      if (destroyed) return;
      const previous = config;
      config = next;

      if (next.docKey !== previous.docKey) {
        view.setState(createState(next));
        topPending = view.scrollDOM.clientHeight === 0;
        if (!topPending) {
          view.scrollDOM.scrollTop = 0;
          view.scrollDOM.scrollLeft = 0;
        }
        loadLanguage();
        return;
      }

      const effects: StateEffect<unknown>[] = [];
      if (next.wrap !== previous.wrap) effects.push(wrap.reconfigure(next.wrap ? EditorView.lineWrapping : []));
      if (next.dark !== previous.dark) effects.push(theme.reconfigure(themeExtension(next.dark)));
      if (next.phrases !== previous.phrases) effects.push(phrases.reconfigure(EditorState.phrases.of(next.phrases)));
      // A newer version of the same file: change only what differs, so the lines on screen stay put.
      const change = next.text === previous.text ? null : minimalTextChange(view.state.doc.toString(), next.text);
      if (effects.length > 0 || change) {
        view.dispatch({ effects, ...(change ? { changes: change } : {}) });
      }

      if (next.original !== previous.original) {
        // At the very top there is nothing to hold in place, and pinning the first line to the top
        // edge would push a removed block that sits above it out of view.
        const anchor = view.scrollDOM.scrollTop > 0 ? topPosition() : null;
        // The merge fields outlive a reconfigure that keeps them, so they are dropped first and
        // rebuilt against the new original.
        view.dispatch({ effects: merge.reconfigure([]) });
        const rebuilt: StateEffect<unknown>[] = [merge.reconfigure(mergeExtension(next.original))];
        if (anchor !== null) {
          rebuilt.push(EditorView.scrollIntoView(Math.min(anchor, view.state.doc.length), { y: 'start' }));
        }
        view.dispatch({ effects: rebuilt });
      }

      if (next.plain !== previous.plain || next.fileName !== previous.fileName) {
        // Same document, different grammar (the size crossed the plain-text line): swap it in place.
        view.dispatch({ effects: language.reconfigure(describeLanguage(next)?.support ?? []) });
        loadLanguage();
      }
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}
