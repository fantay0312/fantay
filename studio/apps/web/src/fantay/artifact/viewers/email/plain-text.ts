// SPDX-License-Identifier: AGPL-3.0-only
// A plain-text mail body, read the way a person reads it: the reply on top, the quoted messages under
// it set quieter (`>` marks become one hairline per level), the line that introduces a quote
// ("在 … 写道：", "On … wrote:"), and the signature after `-- `. Outlook and Foxmail quote without
// marks, after a "原始邮件" / "Original Message" rule: everything below such a rule is a quote too.
// Line breaks are the sender's and are kept. Web and mail addresses are found so the viewer can make
// them recognisable; they never navigate.

export type MailTextRole = 'text' | 'attribution' | 'signature';

export type MailTextNode =
  | { kind: 'lines'; role: MailTextRole; text: string }
  | { kind: 'quote'; children: MailTextNode[] };

export type MailTextRun = { kind: 'text'; text: string } | { kind: 'url' | 'mail'; text: string };

interface Line {
  depth: number;
  text: string;
  role: MailTextRole;
}

/** Quoting depth deeper than this is drawn at this depth: a hundred hairlines say nothing more. */
const MAX_DEPTH = 6;

const QUOTE_MARKS = /^((?:>[ \t]?)+)/;
const ORIGINAL_RULE = /^\s*[-_=]{2,}\s*(?:original message|原始邮件|原始郵件|原邮件|forwarded message|转发邮件|轉寄郵件)\s*[-_=]{2,}\s*$/i;
const INTRODUCES_QUOTE = /(?:[:：]\s*$)|wrote\s*:?\s*$|写道|寫道|schrieb|a écrit|escribió|scrisse|написал/i;

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let shift = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const marks = QUOTE_MARKS.exec(raw);
    const depth = marks ? (marks[1]?.split('>').length ?? 1) - 1 : 0;
    const content = marks ? raw.slice(marks[0].length) : raw;
    if (depth === 0 && shift === 0 && ORIGINAL_RULE.test(content)) {
      lines.push({ depth: 0, text: content.trim(), role: 'attribution' });
      shift = 1;
      continue;
    }
    lines.push({ depth: Math.min(MAX_DEPTH, depth + shift), text: content, role: 'text' });
  }
  return lines;
}

/** The next line with words in it, from `index` on; null when none follows. */
function nextFilled(lines: readonly Line[], index: number): Line | null {
  for (let at = index; at < lines.length; at += 1) {
    const line = lines[at] as Line;
    if (line.text.trim() !== '') return line;
  }
  return null;
}

function markRoles(lines: Line[]): void {
  let signature = false;
  lines.forEach((line, index) => {
    if (line.role === 'attribution') return;
    // A line that ends in a colon, right before a deeper quote, says whose words follow.
    const next = nextFilled(lines, index + 1);
    if (line.text.trim() !== '' && next && next.depth > line.depth && INTRODUCES_QUOTE.test(line.text.trim())) {
      line.role = 'attribution';
      if (line.depth === 0) signature = false;
      return;
    }
    // The signature is the writer's own, at the top level, and ends where a quote begins.
    if (line.depth > 0) {
      signature = false;
      return;
    }
    if (!signature && (line.text === '-- ' || line.text === '--')) signature = true;
    if (signature) line.role = 'signature';
  });
}

function group(lines: readonly Line[], depth: number): MailTextNode[] {
  const nodes: MailTextNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.depth > depth) {
      let end = index;
      while (end < lines.length && (lines[end] as Line).depth > depth) end += 1;
      const children = group(lines.slice(index, end), depth + 1);
      if (children.length > 0) nodes.push({ kind: 'quote', children });
      index = end;
      continue;
    }
    let end = index;
    while (end < lines.length && (lines[end] as Line).depth === depth && (lines[end] as Line).role === line.role) end += 1;
    const text = lines
      .slice(index, end)
      .map((entry) => entry.text)
      .join('\n')
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\s+$/, '');
    if (text) nodes.push({ kind: 'lines', role: line.role, text });
    index = end;
  }
  return nodes;
}

export function readPlainText(text: string): MailTextNode[] {
  const lines = splitLines(text);
  markRoles(lines);
  return group(lines, 0);
}

const ADDRESS =
  /\b(?:https?:\/\/|www\.)[^\s<>"'`，。、；：！？（）「」『』【】《》]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** A sentence's closing punctuation is not part of the address in front of it. */
function trimAddress(value: string): string {
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1] as string;
    if (/[.,;:!?'"]/.test(last)) end -= 1;
    else if (last === ')' && (value.slice(0, end).match(/\(/g)?.length ?? 0) < (value.slice(0, end).match(/\)/g)?.length ?? 0)) end -= 1;
    else break;
  }
  return value.slice(0, end);
}

/** A line of text cut into plain runs and the web and mail addresses in it. */
export function findAddresses(text: string): MailTextRun[] {
  const runs: MailTextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index ?? 0;
    const value = trimAddress(match[0]);
    if (!value || value.length < 5) continue;
    if (start > at) runs.push({ kind: 'text', text: text.slice(at, start) });
    runs.push({ kind: value.includes('@') && !/^(?:https?:\/\/|www\.)/i.test(value) ? 'mail' : 'url', text: value });
    at = start + value.length;
  }
  if (at < text.length) runs.push({ kind: 'text', text: text.slice(at) });
  return runs;
}
