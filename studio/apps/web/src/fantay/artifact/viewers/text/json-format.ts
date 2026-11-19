// SPDX-License-Identifier: AGPL-3.0-only
// Re-indents JSON for reading without ever parsing a value. The old viewer formatted with
// `JSON.parse` + `JSON.stringify` and had to refuse any file whose numbers would not survive the
// round trip (`1.0`, `-0`, `12345678901234567890`, `1e400`). Here the text is only re-spaced: every
// string, number and literal is copied character for character, so precision cannot change and no
// file has to be refused for its numbers. `JSON.parse` is still called once, only to prove the text
// is JSON before its structure is trusted. Pure: no React, no DOM.

/** Above this size the text is shown as it is: formatting would double it in memory for little gain. */
export const JSON_FORMAT_MAX_CHARS = 2 * 1024 * 1024;

export interface JsonReading {
  /** The re-indented text; null when the file is already regular, is not valid JSON, or is too large. */
  formatted: string | null;
  /** The file reads badly as it stands (minified), so the formatted view is the better first view. */
  preferFormatted: boolean;
}

const NONE: JsonReading = { formatted: null, preferFormatted: false };

const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === LF || code === CR;
}

function isStructural(code: number): boolean {
  return (
    code === COMMA || code === COLON || code === OPEN_BRACE || code === CLOSE_BRACE || code === OPEN_BRACKET || code === CLOSE_BRACKET
  );
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-spaces text that is known to be valid JSON. Tokens are copied verbatim; only the whitespace
 * between them is rewritten. Callers check validity first (`formatJson` does).
 */
export function reindentJson(text: string, indent = '  '): string {
  const out: string[] = [];
  const indents: string[] = [''];
  let depth = 0;
  const breakLine = (): void => {
    while (indents.length <= depth) indents.push((indents[indents.length - 1] ?? '') + indent);
    out.push('\n', indents[depth] ?? '');
  };

  const length = text.length;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (isSpace(code)) {
      index += 1;
    } else if (code === QUOTE) {
      let end = index + 1;
      while (end < length) {
        const inner = text.charCodeAt(end);
        if (inner === BACKSLASH) end += 2;
        else if (inner === QUOTE) break;
        else end += 1;
      }
      out.push(text.slice(index, end + 1));
      index = end + 1;
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      let next = index + 1;
      while (next < length && isSpace(text.charCodeAt(next))) next += 1;
      const closer = code === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET;
      if (text.charCodeAt(next) === closer) {
        // An empty container stays on one line.
        out.push(code === OPEN_BRACE ? '{}' : '[]');
        index = next + 1;
      } else {
        out.push(text[index] ?? '');
        depth += 1;
        breakLine();
        index += 1;
      }
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      depth = Math.max(0, depth - 1);
      breakLine();
      out.push(text[index] ?? '');
      index += 1;
    } else if (code === COMMA) {
      out.push(',');
      breakLine();
      index += 1;
    } else if (code === COLON) {
      out.push(': ');
      index += 1;
    } else {
      // A number or a literal: everything up to the next structural character or space.
      let end = index + 1;
      while (end < length) {
        const inner = text.charCodeAt(end);
        if (isSpace(inner) || isStructural(inner)) break;
        end += 1;
      }
      out.push(text.slice(index, end));
      index = end;
    }
  }
  return out.join('');
}

/** The indent a file already uses (a tab, or 1 to 8 spaces); two spaces when it has none. */
export function detectJsonIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return '  ';
  const lead = match[1] ?? '';
  if (lead.startsWith('\t')) return '\t';
  return ' '.repeat(Math.min(8, Math.max(1, lead.length)));
}

function normalize(text: string): string {
  const withoutMark = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return (withoutMark.includes('\r') ? withoutMark.replace(/\r\n?/g, '\n') : withoutMark).trimEnd();
}

/** Characters per line; a minified file has thousands, a hand-written one a few dozen. */
function isMinified(text: string): boolean {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return text.length / lines > 160;
}

/** How a `.json` file should be offered: nothing to add when it is already laid out regularly. */
export function readJson(text: string): JsonReading {
  if (text.length > JSON_FORMAT_MAX_CHARS) return NONE;
  const source = normalize(text);
  if (source === '' || !isValidJson(source)) return NONE;
  const minified = isMinified(source);
  // A file indented with four spaces or tabs is regular too: it is compared in its own indent.
  if (!minified && reindentJson(source, detectJsonIndent(source)) === source) return NONE;
  const formatted = reindentJson(source);
  if (formatted === source) return NONE;
  return { formatted, preferFormatted: minified };
}

/**
 * JSON Lines: each line is one record, and that is the view the format is for, so it stays the
 * default. The formatted view opens every record up; a line that is not JSON is left as it is.
 */
export function readJsonLines(text: string): JsonReading {
  if (text.length > JSON_FORMAT_MAX_CHARS) return NONE;
  const source = normalize(text);
  if (source === '') return NONE;
  let changed = false;
  const records = source.split('\n').map((line) => {
    const record = line.trim();
    if (record === '' || !isValidJson(record)) return line;
    const formatted = reindentJson(record);
    if (formatted !== line) changed = true;
    return formatted;
  });
  return changed ? { formatted: records.join('\n'), preferFormatted: false } : NONE;
}
