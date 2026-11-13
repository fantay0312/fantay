// SPDX-License-Identifier: AGPL-3.0-only
// Plan R6: DOM the board engine must leave alone (no pan/zoom/drag/shortcuts) carries
// `data-board-interactive`; node bodies also stop `pointerdown` from reaching the node shell.
import type * as React from 'react';

import { BOARD_INTERACTIVE_ATTR } from '../../board/extensions';

/** Spread on every interactive element inside a node body, panel or board popover. */
export const BOARD_INTERACTIVE_PROPS = { 'data-board-interactive': '' } as const;

// Compile-time guard: the literal above is the seam's attribute name.
const ATTRIBUTE_NAME: typeof BOARD_INTERACTIVE_ATTR = 'data-board-interactive';
void ATTRIBUTE_NAME;

/** Keeps a press on a control from starting a node drag or a marquee. */
export function stopBoardPointer(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/** Attribute isolation for an interactive descendant of a node body (B21a: no pointerdown stopPropagation). */
export const BOARD_CONTROL_PROPS = {
  ...BOARD_INTERACTIVE_PROPS,
} as const;

/** Attribute + wheel isolation for a scrollable or editable region inside a node or panel. */
export const BOARD_REGION_PROPS = {
  ...BOARD_INTERACTIVE_PROPS,
  onWheel: stopBoardPointer,
} as const;
