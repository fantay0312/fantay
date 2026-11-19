// SPDX-License-Identifier: AGPL-3.0-only
// Keep full document context (including open fences and nested lists) off the input thread.
// Only the syntax around the viewport is transferred back to the editor.
import { DocInput } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { ChangeSet, Text } from '@codemirror/state';
import { TreeFragment, type Tree, type ChangedRange } from '@lezer/common';

export interface MarkdownParseRequest {
  revision: number;
  ticket: number;
  ranges: readonly { from: number; to: number }[];
  source?: string;
  changes?: ReturnType<ChangeSet['toJSON']>;
}

export interface MarkdownParseResult {
  revision: number;
  ticket: number;
  ranges: MarkdownParseRequest['ranges'];
  buffer: number[];
}

let doc = Text.empty;
let revision = 0;
let fragments: readonly TreeFragment[] = [];
let parsed: Tree | null = null;
let ticket = 0;
let ranges: MarkdownParseRequest['ranges'] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function sendOutline() {
  timer = undefined;
  if (!parsed) {
    parsed = markdownLanguage.parser.parse(new DocInput(doc), fragments);
    fragments = TreeFragment.addTree(parsed);
  }
  // Tree.build expects postfix records [type, from, to, subtree size in integers].
  // Keep every ancestor that intersects the viewport so language commands can resolve context.
  const buffer: number[] = [], starts: number[] = [];
  parsed.iterate({
    from: ranges[0]?.from ?? 0, to: ranges.at(-1)?.to ?? 0,
    enter(node) {
      if (!ranges.some(r => node.from <= r.to && r.from <= node.to)) return false;
      starts.push(buffer.length);
    },
    leave(node) {
      const start = starts.pop()!;
      if (starts.length) buffer.push(node.type.id, node.from, node.to, buffer.length + 4 - start);
    },
  });
  self.postMessage({ revision, ticket, ranges, buffer } satisfies MarkdownParseResult);
}

self.onmessage = ({ data }: MessageEvent<MarkdownParseRequest>) => {
  ranges = data.ranges;
  ticket = data.ticket;
  revision = data.revision;
  if (data.source !== undefined) {
    doc = Text.of(data.source.split('\n'));
    parsed = null;
    fragments = [];
  } else if (data.changes) {
    const changes = ChangeSet.fromJSON(data.changes);
    const ranges: ChangedRange[] = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
    fragments = TreeFragment.applyChanges(fragments, ranges);
    doc = changes.apply(doc);
    parsed = null;
  }
  // Coalesce bursts. Pure scrolling reuses the already parsed tree.
  if (timer === undefined) timer = setTimeout(sendOutline, data.changes ? 50 : 0);
};
