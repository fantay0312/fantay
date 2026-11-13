// SPDX-License-Identifier: Apache-2.0
/** The editor's bottom toolbar (06 §3.6): OpenPencil's tools without comments or icon insertion, plus "place image". */
import type { ToolbarLayout } from '@/app/editor/toolbar/layout';

export const FANTAY_TOOLBAR_LAYOUT: ToolbarLayout = {
  groups: [['SELECT'], ['FRAME', 'SECTION'], ['RECTANGLE', 'LINE', 'ELLIPSE', 'POLYGON', 'STAR'], ['PEN', 'PENCIL'], ['TEXT'], ['HAND'], ['place-image']],
  hidden: ['COMMENT', 'insert-icon'],
};

/** Files the "place image" button accepts. */
export const PLACE_IMAGE_ACCEPT = 'image/*,.svg';
