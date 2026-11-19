// SPDX-License-Identifier: AGPL-3.0-only
// The stylesheets of the frame a mail's HTML body is drawn in. Mail is written for a white page with
// its own colours and table layouts, so the frame is that page in both themes, and the message's own
// style sheets (cleaned, `sanitize-mail.ts`) sit between these two:
//  - MAIL_FRAME_CSS, before them: a readable default for a message that brings no styles of its own
//    (face, size, line height, quiet links, quotes), written with `:where()` so it weighs nothing and
//    any rule of the message wins;
//  - MAIL_GUARD_CSS, after them: what the reader keeps. The page is as tall as its content (the
//    viewer sizes the frame to it, so the column scrolls as one), never wider than the column unless
//    the layout cannot be narrowed (then it scrolls sideways inside the frame), always light, and its
//    inset is the column's (`--fx-pad`), so the message's words line up with the header's.

const UI_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export const MAIL_FRAME_CSS = `
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
:where(body) {
  margin: 0;
  background: white;
  color: rgb(29 29 31);
  font: 15px/1.6 ${UI_FONT};
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
:where(a[href]) {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgb(29 29 31 / 0.35);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.18em;
}
:where(a[href]:hover) { text-decoration-color: currentColor; }
:where(a[href]) { cursor: pointer; }
:where(img) { max-width: 100%; height: auto; }
:where(blockquote) {
  margin: 0.8em 0;
  padding: 0 0 0 12px;
  border-left: 2px solid rgb(0 0 0 / 0.14);
  color: rgb(29 29 31 / 0.66);
}
:where(pre) { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ${MONO_FONT}; font-size: 13px; }
:where(code, kbd, samp) { font-family: ${MONO_FONT}; font-size: 0.9em; }
:where(hr) { border: 0; border-top: 1px solid rgb(0 0 0 / 0.12); }
.fx-blocked {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  max-width: 100%;
  min-width: 24px;
  min-height: 22px;
  padding: 4px 8px;
  overflow: hidden;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.045);
  color: rgb(0 0 0 / 0.42);
  font: 12px/1.4 ${UI_FONT};
  text-align: center;
  text-decoration: none;
  vertical-align: middle;
  white-space: normal;
}
`;

export const MAIL_GUARD_CSS = `
html {
  box-sizing: border-box !important;
  margin: 0 !important;
  padding: var(--fx-pad, 20px) !important;
  width: auto !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
  overscroll-behavior: auto !important;
  background: transparent !important;
  color-scheme: light !important;
  zoom: 1 !important;
  transform: none !important;
  filter: none !important;
  scrollbar-width: thin;
  scrollbar-color: rgb(0 0 0 / 0.22) transparent;
}
body {
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  zoom: var(--fx-zoom, 1) !important;
}
a:focus-visible { outline: 2px solid var(--focus-ring-color) !important; outline-offset: 2px !important; border-radius: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
