// SPDX-License-Identifier: Apache-2.0
// Display helpers for roleplay text: action and speech spans, and folding of card markup the app does not run.

export type RoleplayToken = { kind: "text" | "action" | "speech"; text: string };
export type MarkupSegment = { kind: "text" | "markup"; text: string };

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯\u{20000}-\u{10ffff}]/u;
const LINE_BREAK = /[\r\n]/;
const MAX_ASTERISK_ACTION = 400;
const PAIRS: ReadonlyMap<string, { close: string; kind: "action" | "speech" }> = new Map([
  ["（", { close: "）", kind: "action" }],
  ["“", { close: "”", kind: "speech" }],
  ["「", { close: "」", kind: "speech" }],
  ["『", { close: "』", kind: "speech" }],
  ["\"", { close: "\"", kind: "speech" }],
]);

/**
 * Forward-only searches over one segment. A scan asks with non-decreasing `from`, so each answer is reused while it is
 * still ahead (and a miss stays a miss): a line of 32 000 unclosed brackets costs one pass, not one pass per bracket.
 */
interface SegmentFinder {
  next(char: string, from: number): number;
  hasCjk(from: number, end: number): boolean;
}
function finderFor(segment: string): SegmentFinder {
  const found = new Map<string, { from: number; at: number }>();
  const cjk = new RegExp(CJK.source, "gu");
  let cjkFrom = -1;
  let cjkAt = -1;
  return {
    next(char, from) {
      const known = found.get(char);
      if (known && from >= known.from && (known.at < 0 || known.at >= from)) return known.at;
      const at = segment.indexOf(char, from);
      found.set(char, { from, at });
      return at;
    },
    hasCjk(from, end) {
      if (cjkFrom < 0 || from < cjkFrom || (cjkAt >= 0 && cjkAt < from)) {
        cjk.lastIndex = from;
        cjkAt = cjk.exec(segment)?.index ?? -1;
        cjkFrom = from;
      }
      return cjkAt >= 0 && cjkAt < end;
    },
  };
}

/** The span opening at `start` of a single-line, code-free segment (`end` is exclusive); null when none opens there. */
function spanAt(segment: string, start: number, finder: SegmentFinder): { end: number; kind: "action" | "speech" } | null {
  const char = segment[start];
  if (char === "*") {
    const next = segment[start + 1];
    if (segment[start - 1] === "*" || next === undefined || next === "*" || /\s/.test(next)) return null;
    const close = finder.next("*", start + 1);
    if (close < 0 || close - start - 1 > MAX_ASTERISK_ACTION) return null;
    if (segment[close + 1] === "*" || /\s/.test(segment[close - 1] ?? " ")) return null;
    return { end: close + 1, kind: "action" };
  }
  if (char === "(") {
    const close = finder.next(")", start + 1);
    if (close <= start + 1 || !finder.hasCjk(start + 1, close)) return null;
    return { end: close + 1, kind: "action" };
  }
  const pair = char === undefined ? undefined : PAIRS.get(char);
  if (!pair) return null;
  const close = finder.next(pair.close, start + 1);
  if (close <= start + 1) return null;
  return { end: close + 1, kind: pair.kind };
}

/** Splits text into code regions (fenced blocks and inline code) and prose pieces that never cross a line break. */
function proseAndCode(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let fence: { char: string; size: number } | null = null;
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    if (fence) {
      parts.push({ code: true, text: line });
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body);
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    if (open?.[1]) {
      fence = { char: open[1][0] ?? "`", size: open[1].length };
      parts.push({ code: true, text: line });
      continue;
    }
    // Inline code: a run of N backticks up to the next run of exactly N backticks on the same line.
    let cursor = 0;
    let index = 0;
    while (index < line.length) {
      if (line[index] !== "`") {
        index += 1;
        continue;
      }
      let runEnd = index;
      while (line[runEnd] === "`") runEnd += 1;
      const size = runEnd - index;
      let search = runEnd;
      let closeAt = -1;
      while (search < line.length) {
        const found = line.indexOf("`", search);
        if (found < 0) break;
        let foundEnd = found;
        while (line[foundEnd] === "`") foundEnd += 1;
        if (foundEnd - found === size) {
          closeAt = foundEnd;
          break;
        }
        search = foundEnd;
      }
      if (closeAt < 0) {
        index = runEnd;
        continue;
      }
      if (index > cursor) parts.push({ code: false, text: line.slice(cursor, index) });
      parts.push({ code: true, text: line.slice(index, closeAt) });
      cursor = closeAt;
      index = closeAt;
    }
    if (cursor < line.length) parts.push({ code: false, text: line.slice(cursor) });
  }
  return parts;
}

/** Styling only: the stored message is never changed, and concatenating the token texts returns the input. */
export function tokenizeRoleplay(text: string): RoleplayToken[] {
  const tokens: RoleplayToken[] = [];
  const push = (kind: RoleplayToken["kind"], part: string) => {
    if (!part) return;
    const last = tokens[tokens.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += part;
    else tokens.push({ kind, text: part });
  };
  for (const part of proseAndCode(text)) {
    if (part.code) {
      push("text", part.text);
      continue;
    }
    const segment = part.text;
    const finder = finderFor(segment);
    let textStart = 0;
    let index = 0;
    while (index < segment.length) {
      const span = spanAt(segment, index, finder);
      if (span && !LINE_BREAK.test(segment.slice(index, span.end))) {
        push("text", segment.slice(textStart, index));
        push(span.kind, segment.slice(index, span.end));
        index = span.end;
        textStart = span.end;
      } else {
        index += 1;
      }
    }
    push("text", segment.slice(textStart));
  }
  return tokens;
}

// ---- card markup -------------------------------------------------------------------------------------------------
const INLINE_TAGS: ReadonlySet<string> = new Set([
  "b", "i", "u", "s", "em", "strong", "span", "font", "center", "div", "p", "br", "small", "sub", "sup",
]);
const DROPPED_BLOCKS = /<(style|script)(?=[\s/>])[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*>/g;

interface TagToken { start: number; end: number; name: string; closing: boolean; selfClosing: boolean }

/** Never throws; text without `<` returns a single text segment. */
export function foldCardMarkup(text: string): MarkupSegment[] {
  if (!text.includes("<")) return [{ kind: "text", text }];
  const source = text.replace(DROPPED_BLOCKS, "");
  const tags: TagToken[] = [];
  for (const match of source.matchAll(TAG)) {
    const start = match.index ?? 0;
    tags.push({
      start,
      end: start + match[0].length,
      name: (match[2] ?? "").toLowerCase(),
      closing: match[1] === "/",
      selfClosing: match[0].endsWith("/>"),
    });
  }
  // Pair every non-inline opening tag with its matching closing tag (per name, innermost first).
  const pairEnd = new Map<number, number>();
  const open = new Map<string, number[]>();
  tags.forEach((tag, index) => {
    if (INLINE_TAGS.has(tag.name) || tag.selfClosing) return;
    const stack = open.get(tag.name) ?? [];
    if (!tag.closing) {
      stack.push(index);
      open.set(tag.name, stack);
      return;
    }
    const opener = stack.pop();
    if (opener !== undefined) pairEnd.set(opener, index);
  });

  const segments: MarkupSegment[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) segments.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let cursor = 0;
  tags.forEach((tag, index) => {
    if (tag.start < cursor) return;
    if (INLINE_TAGS.has(tag.name)) {
      buffer += source.slice(cursor, tag.start) + (tag.name === "br" && !tag.closing ? "\n" : "");
      cursor = tag.end;
      return;
    }
    const closeIndex = pairEnd.get(index);
    const close = closeIndex === undefined ? undefined : tags[closeIndex];
    if (!close) return;
    const block = source.slice(tag.start, close.end);
    if (!block.includes("\n")) return;
    buffer += source.slice(cursor, tag.start);
    flush();
    segments.push({ kind: "markup", text: block });
    cursor = close.end;
  });
  buffer += source.slice(cursor);
  flush();
  return segments.length > 0 ? segments : [{ kind: "text", text: "" }];
}
