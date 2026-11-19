// SPDX-License-Identifier: AGPL-3.0-only
// What the deck worker and the viewer say to each other. Types only: this file is shared by the
// worker, the client and the tests, so it imports nothing.

/** `pptx` is drawn slide by slide; `odp` gives its text only. */
export type DeckKind = 'pptx' | 'odp';

/**
 * Why a deck did not open. The viewer words each one itself; no library message reaches the reader.
 * `invalid` covers damaged, encrypted and mislabelled files; `timeout` and `worker` are set by the client.
 */
export type DeckFailure = 'invalid' | 'too-large' | 'empty' | 'timeout' | 'worker';

/** Something the drawing engine left as a placeholder on a slide. */
export type UnsupportedKind = 'image' | 'chart' | 'object' | 'shape';

export interface UnsupportedCount {
  kind: UnsupportedKind;
  count: number;
}

export interface OutlineParagraph {
  text: string;
  /** Nesting depth of a list item, 0 for body text. */
  level: number;
}

/** One piece of a slide's content, in reading order. */
export type OutlineBlock =
  | { kind: 'text'; paragraphs: OutlineParagraph[] }
  | { kind: 'table'; rows: string[][] }
  /** A chart stands in the outline as its series and categories. */
  | { kind: 'chart'; series: string[]; categories: string[] };

export interface DeckSlide {
  /** '' when the slide has no text that reads as a title. */
  title: string;
  /** Marked "hide slide" by the author: shown here, skipped when presenting. */
  hidden: boolean;
  /** Speaker notes, '' when there are none. */
  notes: string;
  blocks: OutlineBlock[];
}

export interface DeckInfo {
  /** Slide size in CSS pixels at 100%. 0 × 0 when the file does not say (an outline-only deck). */
  width: number;
  height: number;
  /** False for a deck that only has an outline. */
  drawable: boolean;
  slides: DeckSlide[];
  /** The outline was cut because the deck holds more text than a preview should carry. */
  outlineCut: boolean;
}

export type DeckRequest =
  | { id: number; type: 'open'; kind: DeckKind; bytes: ArrayBuffer }
  | { id: number; type: 'render'; index: number };

export type DeckResponse =
  | { id: number; type: 'opened'; deck: DeckInfo }
  /** The slide as an SVG document, to be shown through an `<img>` and never inlined. */
  | { id: number; type: 'rendered'; index: number; image: Blob; unsupported: UnsupportedCount[] }
  | { id: number; type: 'failed'; failure: DeckFailure };
