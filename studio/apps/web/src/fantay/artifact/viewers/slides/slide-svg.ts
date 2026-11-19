// SPDX-License-Identifier: AGPL-3.0-only
// Reading what the drawing engine says about its own output. When it cannot draw a shape it leaves
// a labelled placeholder whose group carries `data-pptx-fallback`; the viewer counts those per slide
// and says so under the slide instead of letting a dashed box pass for the author's content.
// Pure: runs in the worker and in tests.
import type { UnsupportedCount, UnsupportedKind } from './protocol';

/** The engine's marker values, in the words the viewer uses. */
const KIND_OF_MARKER: Record<string, UnsupportedKind> = {
  image: 'image',
  chart: 'chart',
  graphicFrame: 'object',
  custGeom: 'shape',
};

const ORDER: readonly UnsupportedKind[] = ['image', 'chart', 'object', 'shape'];

/**
 * The placeholders in one slide's SVG, grouped by kind. The engine escapes quotes in text, so a
 * slide whose words merely mention the marker is not counted.
 */
export function countUnsupported(svg: string): UnsupportedCount[] {
  const counts = new Map<UnsupportedKind, number>();
  for (const match of svg.matchAll(/\sdata-pptx-fallback="([A-Za-z]+)"/g)) {
    // A marker this version does not know is still something that was not drawn.
    const kind = KIND_OF_MARKER[match[1] ?? ''] ?? 'object';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [{ kind, count }] : [];
  });
}

export function totalUnsupported(counts: readonly UnsupportedCount[]): number {
  return counts.reduce((sum, entry) => sum + entry.count, 0);
}
