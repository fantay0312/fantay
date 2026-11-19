// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/components/markdown/codemirrorGithubTheme.ts
// @ 88941ba7 (Apache-2.0): the Lezer-tag → colour table (GitHub light / dark) and the code editor
// theme. Restyled for Fantay: ground, gutter, text and selection come from the app's tokens, so they
// follow the theme by themselves; only the syntax palette and CodeMirror's own light/dark flag are
// swapped when `data-theme` flips. The merge view and the search panel are styled in
// CodeSurface.module.css, where a rule can outrank CodeMirror's `&light` / `&dark` base themes.
import { HighlightStyle } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

interface SyntaxPalette {
  comment: string;
  keyword: string;
  literal: string;
  string: string;
  variable: string;
  function: string;
  tag: string;
}

/** GitHub light (highlight.js github.css). */
const LIGHT: SyntaxPalette = {
  comment: '#6a737d',
  keyword: '#d73a49',
  literal: '#005cc5',
  string: '#032f62',
  variable: '#e36209',
  function: '#6f42c1',
  tag: '#22863a',
};

/** GitHub dark (highlight.js github-dark.css). */
const DARK: SyntaxPalette = {
  comment: '#8b949e',
  keyword: '#ff7b72',
  literal: '#79c0ff',
  string: '#a5d6ff',
  variable: '#ffa657',
  function: '#d2a8ff',
  tag: '#7ee787',
};

const INK = 'var(--ink)';
const MONO = 'var(--font-mono)';

function makeHighlightStyle(c: SyntaxPalette): HighlightStyle {
  return HighlightStyle.define([
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.modifier,
        t.typeName,
        t.standard(t.tagName),
      ],
      color: c.keyword,
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.namespace],
      color: c.function,
    },
    { tag: [t.string, t.special(t.string), t.regexp], color: c.string },
    { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: c.literal },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: 'italic' },
    { tag: [t.standard(t.variableName), t.special(t.variableName)], color: c.variable },
    { tag: [t.tagName, t.angleBracket], color: c.tag },
    { tag: [t.propertyName, t.attributeName], color: c.literal },
    // Markdown reads as a document: structure in ink, only code tokens in colour.
    {
      tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: INK,
      fontWeight: '600',
    },
    { tag: t.quote, color: c.comment },
    { tag: t.monospace, color: INK },
    { tag: [t.link, t.url], color: INK, textDecoration: 'underline' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: '600' },
    { tag: [t.punctuation, t.bracket, t.derefOperator], color: INK },
  ]);
}

const lightHighlight = makeHighlightStyle(LIGHT);
const darkHighlight = makeHighlightStyle(DARK);

const SELECTION = 'color-mix(in srgb, var(--ink) 14%, transparent)';

function makeEditorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '12.5px',
        // Code reads at regular weight; the surface's 500 is for interface text.
        fontWeight: '400',
        color: INK,
        backgroundColor: 'var(--paper)',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        // The font goes on .cm-content and .cm-line as well: CodeMirror's base theme names
        // `monospace` there, which would otherwise win over this inherited stack.
        fontFamily: MONO,
        lineHeight: '1.7',
        overflow: 'auto',
        overscrollBehavior: 'contain',
      },
      '.cm-content': {
        fontFamily: MONO,
        // The vertical start is set here and nowhere else: the gutter aligns to the content's line
        // blocks, so padding on .cm-gutters would push the numbers off their lines.
        padding: '10px 0 72px',
      },
      '.cm-line': {
        fontFamily: MONO,
        padding: '0 24px 0 12px',
      },
      // Native selection (no drawSelection layer): the reader's selection is the browser's own.
      '.cm-content ::selection, .cm-line::selection': { backgroundColor: SELECTION },
      '.cm-selectionBackground': { backgroundColor: SELECTION },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
      // Opaque paper, no rule: with wrapping off the gutter stays put while lines scroll under it.
      '.cm-gutters': {
        backgroundColor: 'var(--paper)',
        border: 'none',
        color: 'var(--ink-ghost)',
        fontFamily: MONO,
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 8px 0 16px',
        minWidth: '3ch',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      },
    },
    { dark },
  );
}

const lightTheme = makeEditorTheme(false);
const darkTheme = makeEditorTheme(true);

/** The editor theme for one colour scheme. Built once per scheme, so swapping is a reconfigure. */
export function editorTheme(dark: boolean): Extension {
  return dark ? darkTheme : lightTheme;
}

/** The syntax colours for one colour scheme. */
export function syntaxStyle(dark: boolean): HighlightStyle {
  return dark ? darkHighlight : lightHighlight;
}
