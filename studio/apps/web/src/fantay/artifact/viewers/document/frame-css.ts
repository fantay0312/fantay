// SPDX-License-Identifier: AGPL-3.0-only
// The stylesheets of the frame documents. They are text because they are written into a frame, not
// into the app; the product tokens they use (`var(--sub)`, `var(--ink)` …) are copied onto the
// frame's root by `SandboxFrame`, so they follow the theme like any product stylesheet.
//
// Two grounds:
//  - sheets: pages of a paged document. Same values as `parts/Sheets.module.css` (canvas-tone
//    ground, 24px margin, 16px between sheets, 2px corners, the ring shadow, white paper in both
//    themes; 12px and 10px in a narrow panel), reproduced here because the pages live in a frame.
//  - reading: one column of text on the interface paper, for formats with no pages of their own.

const UI_FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
/** A book face: a Latin text serif first, then the system's Chinese Song. */
const BOOK_FONT = "'Iowan Old Style', Charter, Georgia, 'Songti SC', 'STSong', 'Source Han Serif SC', 'Noto Serif CJK SC', 'SimSun', serif";

const SCROLLING = `
html {
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
  overscroll-behavior: contain;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
html, body { margin: 0; padding: 0; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;

/** Pages of a Word document. The `html body` prefix outranks docx-preview's own wrapper rules. */
export const SHEETS_FRAME_CSS = `${SCROLLING}
:root { --zoom: 1; }
html { background: var(--sub); }
html body .docx-wrapper {
  display: flex;
  flex-flow: column nowrap;
  align-items: center;
  gap: 16px;
  box-sizing: border-box;
  width: max-content;
  min-width: 100%;
  padding: 24px;
  background: none;
}
html body .docx-wrapper[data-enter] { animation: sheets-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both; }
.sheet {
  position: relative;
  flex: none;
  overflow: hidden;
  border-radius: 2px;
  background: white;
  box-shadow: var(--shadow-ring);
}
/* The page box is Word's default (A4, its usual margins) for a document that states none; a
   document's own page size and margins arrive as inline styles and win. */
html body .docx-wrapper section.docx {
  box-sizing: border-box;
  width: 21cm;
  min-height: 29.7cm;
  margin: 0;
  padding: 2.54cm 3.18cm;
  background: white;
  box-shadow: none;
  zoom: var(--zoom);
}
/* A picture wider than its page would push the sheet open. */
section.docx img, section.docx svg { max-width: 100%; }
section.docx a { cursor: pointer; }
@keyframes sheets-in { from { opacity: 0; } }
@media (max-width: 460px) {
  html body .docx-wrapper { gap: 10px; padding: 12px; }
}
`;

// Element rules are written with `:where(.reading)`: they weigh no more than a bare element
// selector, so a book's own stylesheet, which comes later, can restyle its paragraphs and headings.
const READING_BASE = `${SCROLLING}
/* The measure is about 68 Latin characters, or 38 Chinese ones. It is set in rem, not ch, so it does
   not depend on the face an element happens to use and grows with the text size. */
:root { --zoom: 1; --measure: 38rem; --gutter: 40px; --foot: 96px; }
html {
  background: var(--paper);
  color: var(--ink);
  font-size: calc(16px * var(--zoom));
}
body {
  font-family: ${UI_FONT};
  font-size: 1rem;
  font-weight: 400;
  line-height: 1.75;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.reading {
  box-sizing: content-box;
  max-width: var(--measure);
  margin: 0 auto;
  padding: 36px var(--gutter) var(--foot);
}
.reading[data-enter] { animation: reading-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both; }
@keyframes reading-in { from { opacity: 0; transform: translateY(4px); } }
:where(.reading) > :first-child { margin-top: 0; }
:where(.reading) h1, :where(.reading) h2, :where(.reading) h3, :where(.reading) h4, :where(.reading) h5, :where(.reading) h6 {
  margin: 1.7em 0 0.6em;
  font-family: ${UI_FONT};
  font-weight: 600;
  line-height: 1.3;
  text-wrap: balance;
}
:where(.reading) h1 { font-size: 1.75em; letter-spacing: -0.01em; }
:where(.reading) h2 { font-size: 1.375em; }
:where(.reading) h3 { font-size: 1.125em; }
:where(.reading) h4, :where(.reading) h5, :where(.reading) h6 { font-size: 1em; }
:where(.reading) p { margin: 0 0 1em; }
:where(.reading) a {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--ink-ghost);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
  cursor: pointer;
}
:where(.reading) a:hover { text-decoration-color: currentColor; }
:where(.reading) a:focus-visible { outline: 2px solid var(--focus-ring-color); outline-offset: 2px; border-radius: 2px; }
:where(.reading) img, :where(.reading) svg { max-width: 100%; height: auto; }
:where(.reading) figure { margin: 1.5em 0; text-align: center; }
:where(.reading) figcaption { margin-top: 0.5em; color: var(--ink-faint); font-size: 0.8125em; line-height: 1.5; }
:where(.reading) blockquote { margin: 1.25em 0; padding: 0 0 0 1.1em; border-left: 2px solid var(--line); color: var(--ink-soft); }
:where(.reading) hr { width: 100%; margin: 2.25em 0; border: 0; border-top: 1px solid var(--line); }
:where(.reading) ul, :where(.reading) ol { margin: 0 0 1em; padding-left: 1.6em; }
:where(.reading) li { margin: 0.2em 0; }
:where(.reading) table { width: 100%; margin: 1.25em 0; border-collapse: collapse; font-size: 0.9375em; line-height: 1.55; }
:where(.reading) th, :where(.reading) td { padding: 7px 10px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; }
/* The first and last cells are flush with the column, so a table lines up with the text around it. */
:where(.reading) th:first-child, :where(.reading) td:first-child { padding-left: 0; }
:where(.reading) th:last-child, :where(.reading) td:last-child { padding-right: 0; }
:where(.reading) th { font-weight: 600; }
:where(.reading) thead th, :where(.reading) tr:first-child > th { border-bottom-color: var(--line); }
:where(.reading) pre, :where(.reading) code, :where(.reading) kbd, :where(.reading) samp { font-family: var(--font-mono); font-size: 0.875em; }
:where(.reading) pre { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: var(--sub); line-height: 1.6; }
:where(.reading) sup, :where(.reading) sub { line-height: 0; }
@media (max-width: 460px) {
  :root { --gutter: 20px; --foot: 72px; }
  .reading { padding-top: 24px; }
}
`;

/** A converted document (RTF, OpenDocument): the reading page, with a firmer line under a table's first row. */
export const READING_FRAME_CSS = `${READING_BASE}
:where(.reading) table tr:first-child > td { border-bottom-color: var(--line); }
`;

/**
 * A book chapter. The book's own stylesheet sits between this and `BOOK_GUARD_CSS`, so the author
 * decides indents, alignment and heading styles, and the reader keeps the page, the theme and the
 * measure.
 */
export const BOOK_FRAME_CSS = `${READING_BASE}
:root { --foot: 32px; }
body { font-family: ${BOOK_FONT}; }
/* Previous and next chapter, under the text. The 12px inset of each block is taken back from the
   gutter, so the words line up with the column. */
.fx-chapter-nav {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  box-sizing: content-box;
  max-width: calc(var(--measure) + 24px);
  margin: 0 auto;
  padding: 0 calc(var(--gutter) - 12px) 64px;
  font-family: ${UI_FONT};
  line-height: 1.4;
}
@media (max-width: 460px) {
  :root { --foot: 24px; }
  .fx-chapter-nav { padding-bottom: 40px; }
}
.fx-chapter-nav a {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 12px;
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
  transition: background-color 150ms cubic-bezier(0.23, 1, 0.32, 1);
}
.fx-chapter-nav a:hover { background: var(--sub); }
.fx-chapter-nav a:active { background: var(--paper-deep); }
.fx-chapter-nav a:focus-visible { outline: 2px solid var(--focus-ring-color); outline-offset: -2px; }
.fx-chapter-nav a[data-fx-nav='next'] { grid-column: 2; align-items: flex-end; text-align: right; }
.fx-chapter-nav .fx-dir { color: var(--ink-faint); font-size: 12px; font-weight: 500; }
.fx-chapter-nav .fx-name {
  max-width: 100%;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

/** After the book's stylesheet: what the reader does not hand over to it. */
export const BOOK_GUARD_CSS = `
html { background: var(--paper) !important; color: var(--ink) !important; font-size: calc(16px * var(--zoom)) !important; }
body {
  width: auto !important;
  max-width: none !important;
  min-width: 0 !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  background: none !important;
  color: inherit !important;
  columns: auto !important;
}
.reading {
  width: auto !important;
  max-width: var(--measure) !important;
  height: auto !important;
  margin: 0 auto !important;
  padding: 36px var(--gutter) var(--foot) !important;
  background: none !important;
  color: var(--ink) !important;
  columns: auto !important;
  float: none !important;
}
.reading * { max-width: 100%; }
/* A picture never needs scrolling to be seen whole: a cover or a full-page plate fits the window. */
.reading img, .reading svg { max-width: 100% !important; max-height: calc(100vh - 48px); object-fit: contain; }
@media (max-width: 460px) {
  .reading { padding-top: 24px !important; }
}
`;
