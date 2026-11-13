// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/overlay.ts
// Modified by Fantay: P2 - floating and tooltip surfaces use the --shadow-pop token
/**
 * The surface of everything that floats above the editor: popovers, menus, lists, pickers,
 * and cards. The ring, unlike a border, outlines it in both themes without changing its size.
 */
export const floatingSurface =
  'rounded-xl bg-panel text-surface shadow-[var(--shadow-pop)]'

/** A one-line tooltip: the same edge and shadow on a compact shape. */
export const tooltipSurface =
  'rounded-md bg-panel text-surface shadow-[var(--shadow-pop)]'
