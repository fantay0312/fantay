// SPDX-License-Identifier: Apache-2.0
// The reply parser: reasoning removal, the <turn_meta> footer (strict block, then loose trailing lines), the footer line
// grammar and the visible text. A pure function of the full text; it never throws.
import type {
  PaFooterStatus, PaMetaParts, PaPlayRequest, PaStateField, PaStateOp, PaStylePresetDoc,
} from "../api/personal-agent-soul.js";
import { anyPart } from "./footer.js";
import { SOUL_LIMITS } from "./limits.js";
import { rollDice } from "./play.js";

export interface SoulReplyContext {
  schema: readonly PaStateField[]; parts: PaMetaParts;
  speakerNames: readonly string[];          // the agent name and the nickname
  userName: string; otherNames: readonly string[];
  format: PaStylePresetDoc["format"];
  decks: ReadonlyArray<{ id: string; name: string }>;
}
export interface SoulReply {
  text: string;
  mood?: string;
  stateOps: PaStateOp[];
  choices: string[];
  remember: Array<{ kind: "fact" | "promise" | "moment" | "preference"; text: string; due?: string }>;   // due: YYYY-MM-DD
  play: PaPlayRequest[];
  footer: PaFooterStatus;
  dropped: Array<{ line: string; reason: "unknown-field" | "invalid-value" | "not-writable" | "part-off" | "limit" }>;
  empty: boolean;                           // nothing visible is left
}

type DropReason = SoulReply["dropped"][number]["reason"];
type RememberItem = SoulReply["remember"][number];

const ALL_PARTS: PaMetaParts = { mood: true, state: true, choices: true, remember: true, play: true };
/** The visible text is re-parsed until it is a fixed point (each round only removes text); this bounds the rounds. */
const SETTLE_ROUNDS = 64;

// ---- P0, P1 ----------------------------------------------------------------------------------------------------
const ZERO_WIDTH = /[﻿​-‍⁠]/g;
const THINK_PAIR = /<\s*(?:think|thinking)\s*>[\s\S]*?<\s*\/\s*(?:think|thinking)\s*>/gi;
const THINK_OPEN = /<\s*(?:think|thinking)\s*>/i;
const THINK_CLOSE = /<\s*\/\s*(?:think|thinking)\s*>/i;

function normalizeRaw(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(ZERO_WIDTH, "");
}

function stripReasoning(text: string): string {
  let out = text.replace(THINK_PAIR, "");
  for (;;) {
    const close = THINK_CLOSE.exec(out);
    if (!close) break;
    const open = THINK_OPEN.exec(out);
    if (open && open.index < close.index) break;
    out = out.slice(close.index + close[0].length);
  }
  const open = THINK_OPEN.exec(out);
  return open ? out.slice(0, open.index) : out;
}

// ---- P2, P3 ----------------------------------------------------------------------------------------------------
const OPENER_SOURCE = "^[ \\t>*`]*[<＜]\\s*(?:turn[_ -]?meta|meta)\\s*[>＞]";
const CLOSER_SOURCE = "[<＜]\\s*\\/\\s*(?:turn[_ -]?meta|meta)\\s*[>＞]";
const FENCE_LINE = /^\s*`{3,}[\w-]*\s*$/;
const RULE_LINE = /^\s*-{3,}\s*$/;
const LOOSE_RESERVED = /^\s*(?:mood|choices|remember|roll|draw|state)\s*[:：=]/i;

function lastOpener(text: string): { index: number; end: number } | null {
  let found: { index: number; end: number } | null = null;
  for (const match of text.matchAll(new RegExp(OPENER_SOURCE, "gim"))) {
    const index = match.index ?? 0;
    found = { index, end: index + match[0].length };
  }
  return found;
}

function closerAfter(text: string, from: number): { index: number; end: number } | null {
  const pattern = new RegExp(CLOSER_SOURCE, "gi");
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? { index: match.index, end: match.index + match[0].length } : null;
}

/** Removes every opener…closer pair (an opener without a closer runs to the end). */
function removeBlocks(text: string): string {
  let out = text;
  for (;;) {
    const match = new RegExp(OPENER_SOURCE, "im").exec(out);
    if (!match) return out;
    const start = match.index;
    const closer = closerAfter(out, start + match[0].length);
    out = out.slice(0, start) + (closer ? out.slice(closer.end) : "");
  }
}

/** `before` ends where the opener line starts; a fence line directly before the opener is consumed. */
function dropFenceBefore(before: string): string {
  const lines = before.split("\n");
  const last = lines.length - 1;
  if (last >= 1 && lines[last] === "" && FENCE_LINE.test(lines[last - 1] ?? "")) {
    lines.splice(last - 1, 1);
    return lines.join("\n");
  }
  return before;
}

/** `after` starts right after the closer; a fence line directly after the closer is consumed. */
function dropFenceAfter(after: string): string {
  const lines = after.split("\n");
  if (FENCE_LINE.test(lines[0] ?? "")) lines.splice(0, 1);
  else if ((lines[0] ?? "").trim() === "" && lines.length > 1 && FENCE_LINE.test(lines[1] ?? "")) lines.splice(1, 1);
  return lines.join("\n");
}

const hasContent = (text: string) => text.split("\n").some(line => line.trim() !== "");

// ---- P4 --------------------------------------------------------------------------------------------------------
interface LineParts { name: string; operator: string; value: string; end: number }   // end: where the value starts
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * The line grammar `/^\s*(name)\s*(\+=|-=|\+:|-:|:=|[:=])\s*(.*)$/` (name: no `:`, `=`, `+`, `-`) as a linear scan;
 * `legacy` is the `state:` part grammar `/^\s*([^=+\-]+?)\s*(\+=|-=|=|\+|-)\s*(.*)$/`. Name and value come back
 * trimmed. The regex forms backtrack cubically on a long run of spaces, and the loose pass runs them on the last line
 * of every reply.
 */
function splitLine(line: string, legacy = false): LineParts | null {
  const at = line.search(legacy ? /[=+-]/ : /[:=+-]/);
  if (at <= 0) return null;
  const char = line[at] ?? "";
  const next = line[at + 1];
  let operator: string;
  if (legacy) operator = char !== "=" && next === "=" ? `${char}=` : char;
  else if (char === "+" || char === "-") {
    if (next !== "=" && next !== ":") return null;
    operator = `${char}${next}`;
  } else operator = char === ":" && next === "=" ? ":=" : char;
  const rest = line.slice(at + operator.length);
  if (LINE_BREAK.test(rest)) return null;
  return { name: line.slice(0, at).trim(), operator, value: rest.trim(), end: at + operator.length };
}

/** NFKC per code point (dashes folded to `-`), with the raw index of every folded unit. */
function foldWithIndex(raw: string): { line: string; rawIndex: number[] } {
  let line = "";
  const rawIndex: number[] = [];
  let at = 0;
  for (const point of raw) {
    const folded = point.normalize("NFKC").replace(/[−—–－]/g, "-");
    for (let unit = 0; unit < folded.length; unit += 1) rawIndex.push(at);
    line += folded;
    at += point.length;
  }
  rawIndex.push(at);
  return { line, rawIndex };
}

/**
 * The line grammar on the folded line (full-width `：＝＋－` work as operators), but the value is cut from the raw
 * line: a mood, a remembered sentence or a choice keeps its `，！？（）` as written.
 */
function splitRaw(raw: string, legacy = false): LineParts | null {
  const { line, rawIndex } = foldWithIndex(raw);
  let offset = 0;
  let match = splitLine(line, legacy);
  if (!match && !legacy) {
    offset = /^\s*[-*•]\s+/.exec(line)?.[0].length ?? 0;
    if (offset > 0) match = splitLine(line.slice(offset));
  }
  if (!match) return null;
  return { ...match, value: raw.slice(rawIndex[offset + match.end] ?? raw.length).trim() };
}
const PIPE = /[|｜]/;

const RESERVED = new Map<string, Reserved>([
  ["mood", "mood"], ["choices", "choices"], ["remember", "remember"], ["roll", "roll"], ["draw", "draw"], ["state", "state"],
  ["心情", "mood"], ["下一步", "choices"], ["选项", "choices"], ["记住", "remember"], ["掷骰", "roll"], ["抽牌", "draw"],
]);
type Reserved = "mood" | "choices" | "remember" | "roll" | "draw" | "state";
const NOTHING = new Set(["none", "无", "无变化", "不变"]);
const MOOD_TEMPLATES = new Set(["一个词", "心情", "…", "..."]);
const REMEMBER_KINDS = new Map<string, RememberItem["kind"]>([
  ["fact", "fact"], ["preference", "preference"], ["promise", "promise"], ["moment", "moment"],
  ["事实", "fact"], ["喜好", "preference"], ["约定", "promise"], ["瞬间", "moment"],
]);
const CHOICE_ITEM = /^\s*(?:[-*•]\s*|\d+\s*[.．、)）]\s*|[①-⑳❶-❿➀-➓]\s*)([\s\S]+)$/;

const fold = (text: string) => text.normalize("NFKC").trim().toLowerCase();
const normalizeLine = (line: string) => line.normalize("NFKC").replace(/[−—–－]/g, "-");
const codePoints = (text: string, max: number) => Array.from(text).slice(0, max).join("");

function unquote(value: string): string {
  const trimmed = value.trim();
  const pairs: Array<[string, string]> = [
    ["\"", "\""], ["'", "'"], ["“", "”"], ["「", "」"], ["『", "』"], ["‘", "’"], ["＂", "＂"], ["＇", "＇"],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.length >= open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return trimmed;
}

function realDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

interface Collected {
  mood?: string;
  ops: PaStateOp[];
  choices: string[];
  remember: RememberItem[];
  play: PaPlayRequest[];
  dropped: SoulReply["dropped"];
}

const emptyCollected = (): Collected => ({ ops: [], choices: [], remember: [], play: [], dropped: [] });

class LineReader {
  readonly out: Collected = emptyCollected();
  /** Lines that produced at least one valid value. */
  valid = 0;
  private inChoices = false;

  constructor(private readonly ctx: SoulReplyContext, private readonly parts: PaMetaParts) {}

  private drop(line: string, reason: DropReason): void {
    this.out.dropped.push({ line: line.trim(), reason });
  }

  private field(name: string): PaStateField | undefined {
    const folded = fold(name);
    return this.ctx.schema.find(field => field.key.toLowerCase() === folded)
      ?? this.ctx.schema.find(field => fold(field.label) === folded);
  }

  /** Reads one body line; returns true when it yielded a valid value. */
  read(rawLine: string): boolean {
    if (!rawLine.trim() || FENCE_LINE.test(rawLine) || RULE_LINE.test(rawLine)) return false;
    if (this.inChoices) {
      const item = CHOICE_ITEM.exec(rawLine);
      if (item && !splitLine(normalizeLine(rawLine).replace(/^\s*[-*•]\s+/, ""))) {
        return this.addChoices([item[1] ?? ""], rawLine);
      }
      this.inChoices = false;
    }
    const match = splitRaw(rawLine);
    if (!match) {
      this.drop(rawLine, "unknown-field");
      return false;
    }
    const { name, operator, value } = match;
    const reserved = RESERVED.get(name.toLowerCase());
    if (reserved) return this.readReserved(reserved, operator, value, rawLine);
    const field = this.field(name);
    if (!field) {
      this.drop(rawLine, "unknown-field");
      return false;
    }
    if (!this.parts.state) {
      this.drop(rawLine, "part-off");
      return false;
    }
    return this.readField(field, operator, value, rawLine);
  }

  private readReserved(name: Reserved, operator: string, value: string, rawLine: string): boolean {
    const part = name === "roll" || name === "draw" ? this.parts.play : this.parts[name];
    if (!part) {
      this.drop(rawLine, "part-off");
      return false;
    }
    if (name === "choices") {
      this.inChoices = true;
      if (!value || NOTHING.has(fold(value))) return false;
      return this.addChoices(value.split(PIPE), rawLine);
    }
    if (!value || NOTHING.has(fold(value))) return false;
    switch (name) {
      case "mood": return this.readMood(value, rawLine);
      case "remember": return this.readRemember(value, rawLine);
      case "roll": return this.readRoll(value, rawLine);
      case "draw": return this.readDraw(value, rawLine);
      case "state": return this.readLegacyState(value, rawLine);
    }
    return false;
  }

  private readMood(value: string, rawLine: string): boolean {
    const mood = codePoints(unquote(value), SOUL_LIMITS.mood).trim();
    if (!mood || MOOD_TEMPLATES.has(mood)) {
      this.drop(rawLine, "invalid-value");
      return false;
    }
    if (this.out.mood !== undefined) {
      this.drop(rawLine, "limit");
      return false;
    }
    this.out.mood = mood;
    return true;
  }

  private addChoices(items: readonly string[], rawLine: string): boolean {
    let added = false;
    for (const raw of items) {
      const choice = unquote(raw).slice(0, SOUL_LIMITS.choice).trim();
      if (!choice) continue;
      if (this.out.choices.length >= SOUL_LIMITS.choices) {
        this.drop(rawLine, "limit");
        break;
      }
      this.out.choices.push(choice);
      added = true;
    }
    return added;
  }

  private readRemember(value: string, rawLine: string): boolean {
    const pieces = value.split(PIPE).map(piece => piece.trim());
    const kind = REMEMBER_KINDS.get(fold(pieces[0] ?? ""));
    const date = normalizeLine(pieces[1] ?? "").trim();
    let text = value;
    let due: string | undefined;
    if (kind !== undefined && pieces.length >= 2) {
      if (pieces.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        if (realDate(date)) due = date;
        text = pieces.slice(2).join(" | ");
      } else {
        text = pieces.slice(1).join(" | ");
      }
    }
    const content = unquote(text).slice(0, SOUL_LIMITS.rememberText).trim();
    if (!content) {
      this.drop(rawLine, "invalid-value");
      return false;
    }
    if (this.out.remember.length >= SOUL_LIMITS.remember) {
      this.drop(rawLine, "limit");
      return false;
    }
    const resolved = kind !== undefined && pieces.length >= 2 ? kind : "fact";
    this.out.remember.push({ kind: resolved, text: content, ...(due !== undefined && resolved === "promise" ? { due } : {}) });
    return true;
  }

  private addPlay(request: PaPlayRequest, rawLine: string): boolean {
    if (this.out.play.length >= SOUL_LIMITS.playRequests) {
      this.drop(rawLine, "limit");
      return false;
    }
    this.out.play.push(request);
    return true;
  }

  private readRoll(value: string, rawLine: string): boolean {
    const [rawNotation = "", labelRaw = "", rawDc = ""] = value.split(PIPE).map(piece => piece.trim());
    const notationRaw = normalizeLine(rawNotation).trim();
    const dcRaw = normalizeLine(rawDc).trim();
    const roll = notationRaw ? rollDice(notationRaw, () => 0) : null;
    if (!roll) {
      this.drop(rawLine, "invalid-value");
      return false;
    }
    const label = unquote(labelRaw).slice(0, 40).trim();
    const dc = /^\d+$/.test(dcRaw) ? Number(dcRaw) : NaN;
    return this.addPlay({
      kind: "roll", notation: roll.notation,
      ...(label ? { label } : {}),
      ...(Number.isInteger(dc) && dc >= 1 && dc <= 999 ? { dc } : {}),
    }, rawLine);
  }

  private readDraw(value: string, rawLine: string): boolean {
    const wanted = fold(unquote(value));
    const deck = this.ctx.decks.find(candidate => fold(candidate.id) === wanted)
      ?? this.ctx.decks.find(candidate => fold(candidate.name) === wanted);
    if (!deck) {
      this.drop(rawLine, "invalid-value");
      return false;
    }
    return this.addPlay({ kind: "draw", deckId: deck.id }, rawLine);
  }

  private readLegacyState(value: string, rawLine: string): boolean {
    let ok = false;
    for (const piece of value.split(/[;；]/)) {
      if (!piece.trim()) continue;
      const match = splitRaw(piece, true);
      const field = match ? this.field(match.name) : undefined;
      if (!match || !field) {
        this.drop(piece, "unknown-field");
        continue;
      }
      const operator = match.operator === "=" ? ":" : match.operator === "+" ? "+:" : match.operator === "-" ? "-:" : match.operator;
      if (this.readField(field, operator, match.value, piece)) ok = true;
    }
    return ok;
  }

  private pushOps(ops: readonly PaStateOp[], rawLine: string): boolean {
    let added = false;
    for (const op of ops) {
      if (this.out.ops.length >= SOUL_LIMITS.opsPerReply) {
        this.drop(rawLine, "limit");
        break;
      }
      this.out.ops.push(op);
      added = true;
    }
    return added;
  }

  private readField(field: PaStateField, operator: string, value: string, rawLine: string): boolean {
    if (field.writable === "user") {
      this.drop(rawLine, "not-writable");
      return false;
    }
    if (!value || NOTHING.has(fold(value))) return false;
    const invalid = () => {
      this.drop(rawLine, "invalid-value");
      return false;
    };
    const plain = operator === ":" || operator === "=" || operator === ":=";
    switch (field.kind) {
      case "number": {
        const digits = normalizeLine(value);
        const arrow = /(?:→|->)\s*([-+]?\d+(?:\.\d+)?)/.exec(digits);
        const first = /[-+]?\d+(?:\.\d+)?/.exec(digits);
        const number = Number(arrow ? arrow[1] : first?.[0]);
        if ((!arrow && !first) || !Number.isFinite(number)) return invalid();
        if (arrow || operator === ":=") return this.pushOps([{ key: field.key, op: "set", value: number }], rawLine);
        if (operator === "+=" || operator === "+:") return this.pushOps([{ key: field.key, op: "delta", value: number }], rawLine);
        if (operator === "-=" || operator === "-:") return this.pushOps([{ key: field.key, op: "delta", value: -number }], rawLine);
        const signed = /^[-+]/.test(digits);
        return this.pushOps([{ key: field.key, op: signed ? "delta" : "set", value: number }], rawLine);
      }
      case "text": {
        if (!plain) return invalid();
        const text = unquote(value).slice(0, SOUL_LIMITS.stateText);
        return text ? this.pushOps([{ key: field.key, op: "set", value: text }], rawLine) : false;
      }
      case "enum": {
        if (!plain) return invalid();
        const wanted = fold(unquote(value));
        const option = field.options.find(candidate => fold(candidate) === wanted);
        return option === undefined ? invalid() : this.pushOps([{ key: field.key, op: "set", value: option }], rawLine);
      }
      case "list": {
        const items = value.split(/[,，、]/).map(item => unquote(item).slice(0, SOUL_LIMITS.stateListItem).trim())
          .filter(item => item !== "");
        if (items.length === 0) return false;
        const op = operator === "-:" || operator === "-=" ? "remove" : "add";
        return this.pushOps(items.map(item => ({ key: field.key, op, value: item })), rawLine);
      }
    }
  }
}

/** A line the loose pass may read as a footer line: a reserved line name or a schema field, with an operator. */
function footerLinePredicate(ctx: SoulReplyContext): (line: string) => boolean {
  const fieldNames = ctx.schema.flatMap(field => [field.key.toLowerCase(), fold(field.label)]);
  return (line: string): boolean => {
    if (LOOSE_RESERVED.test(line)) return true;
    const match = splitLine(normalizeLine(line));
    return match !== null && fieldNames.includes(fold(match.name));
  };
}

/** P3: trailing footer-like lines. Returns the index of the first consumed line, or null when nothing is accepted. */
function looseFooter(lines: readonly string[], ctx: SoulReplyContext, parts: PaMetaParts): { start: number; reader: LineReader } | null {
  const looksLikeFooter = footerLinePredicate(ctx);
  let start = lines.length;
  const consumed: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || FENCE_LINE.test(line) || RULE_LINE.test(line)) {
      start = index;
      continue;
    }
    if (!looksLikeFooter(line)) break;
    consumed.unshift(line);
    start = index;
  }
  if (consumed.length === 0) return null;
  const reader = new LineReader(ctx, parts);
  for (const line of consumed) if (reader.read(line)) reader.valid += 1;
  return reader.valid > 0 ? { start, reader } : null;
}

// ---- P5 --------------------------------------------------------------------------------------------------------
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelPattern = (name: string) => `(?:\\*\\*|【|\\[)?${escapeRegex(name)}(?:\\*\\*|】|\\])?\\s*[:：]`;

function visibleText(text: string, ctx: SoulReplyContext): string {
  let out = text;
  // One leading label per spec; a repeated label (`A：A：…`) is stripped in the same step so the text is a fixed point.
  const speakers = ctx.speakerNames.map(name => name.trim()).filter(name => name !== "");
  if (speakers.length > 0) {
    const label = new RegExp(`^\\s*(?:${speakers.map(labelPattern).join("|")})\\s*`);
    for (let match = label.exec(out); match && match[0].length > 0; match = label.exec(out)) out = out.slice(match[0].length);
  }
  if (ctx.format !== "script") {
    const cutNames = [ctx.userName, ...ctx.otherNames].map(name => name.trim()).filter(name => Array.from(name).length >= 2);
    if (cutNames.length > 0) {
      const cut = new RegExp(`^\\s*(?:${cutNames.map(labelPattern).join("|")})`);
      const lines = out.split("\n");
      const at = lines.findIndex((line, index) => index > 0 && cut.test(line));
      if (at > 0) out = lines.slice(0, at).join("\n");
    }
  }
  out = out.replace(/<aside\b[^>]*>[\s\S]*?<\/aside\s*>/gi, "");
  out = out.replace(/[<＜]\/?(?:turn[_ -]?meta)[^>＞]*[>＞]/gi, "");
  out = out.split("\n").filter(line => !/turn_meta/i.test(line)).join("\n");
  return out.trim().replace(/\n{3,}/g, "\n\n");
}

// ---- driver ----------------------------------------------------------------------------------------------------
interface Analysis { visible: string; status: Exclude<PaFooterStatus, "off">; reader: LineReader | null }

function analyse(raw: string, ctx: SoulReplyContext): Analysis {
  const normalized = normalizeRaw(raw);
  const text = stripReasoning(normalized);
  const on = anyPart(ctx.parts);
  const opener = lastOpener(text);
  if (opener) {
    const closer = closerAfter(text, opener.end);
    let body: string;
    let after = "";
    if (closer) {
      body = text.slice(opener.end, closer.index);
      after = dropFenceAfter(text.slice(closer.end));
    } else {
      body = text.slice(opener.end);
      if (!normalized.endsWith("\n")) body = body.split("\n").slice(0, -1).join("\n");
    }
    const before = dropFenceBefore(removeBlocks(text.slice(0, opener.index)));
    const visible = hasContent(after) ? `${before.replace(/\n$/, "")}\n${after.replace(/^[ \t]*\n/, "")}` : before;
    let reader: LineReader | null = null;
    if (on) {
      reader = new LineReader(ctx, ctx.parts);
      for (const line of body.split("\n")) if (reader.read(line)) reader.valid += 1;
    }
    return { visible: visibleText(visible, ctx), status: closer ? "ok" : "unclosed", reader };
  }
  const lines = text.split("\n");
  const loose = looseFooter(lines, ctx, on ? ctx.parts : ALL_PARTS);
  if (!loose) return { visible: visibleText(text, ctx), status: "missing", reader: null };
  return { visible: visibleText(lines.slice(0, loose.start).join("\n"), ctx), status: "loose", reader: on ? loose.reader : null };
}

function settle(text: string, ctx: SoulReplyContext): string {
  let current = text;
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    const next = analyse(current, ctx).visible;
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function parseSoulReply(raw: string, ctx: SoulReplyContext): SoulReply {
  try {
    const first = analyse(typeof raw === "string" ? raw : "", ctx);
    const text = settle(first.visible, ctx);
    const on = anyPart(ctx.parts);
    const collected = on && first.reader ? first.reader.out : emptyCollected();
    return {
      text,
      ...(collected.mood !== undefined ? { mood: collected.mood } : {}),
      stateOps: collected.ops,
      choices: collected.choices,
      remember: collected.remember,
      play: collected.play,
      footer: on ? first.status : "off",
      dropped: collected.dropped,
      empty: text === "",
    };
  } catch {
    const text = (typeof raw === "string" ? raw : "").split("\n").filter(line => !/turn_meta/i.test(line)).join("\n").trim();
    return {
      text, stateOps: [], choices: [], remember: [], play: [],
      footer: anyPart(ctx.parts) ? "missing" : "off", dropped: [], empty: text === "",
    };
  }
}

// ---- live text -------------------------------------------------------------------------------------------------
// The reply as it is still being written. It runs the final parser's own pass on the text so far, after holding back
// whatever the rest of the reply could still turn into reasoning, a footer, an aside or a speaker label. Everything
// held is shown again once the next characters prove it is plain text, so what is shown only ever grows into the
// final visible text (the final message is never shorter than any live text before it).
const TAIL_TAG = /[<＜][^<>＜＞\n]{0,40}$/;
const ASIDE_OPEN = /<aside/gi;
const ASIDE_CLOSE = /<\/aside\s*>/i;
const LIVE_FORBIDDEN = /turn_meta|<think|<\/think|<aside/i;
const HELD_MARKERS = /^[ \t>*`\-•]+/;
const FIELD_REST = /^\s*(?:[:：=+\-]|$)/;
const NAME_REST = /^[*】\]\s:：]*$/;
const RESERVED_NAMES: readonly string[] = [...RESERVED.keys()];

const foldName = (name: string) => name.trim().normalize("NFKC").toLowerCase();

/** The unfinished last line may still become a footer line or a speaker label: hold it until it cannot. */
function holdLine(line: string, ctx: SoulReplyContext): boolean {
  const s = line.normalize("NFKC").replace(HELD_MARKERS, "").toLowerCase();
  if (s === "") return line.trim() !== "";
  const fields = [...RESERVED_NAMES, ...ctx.schema.flatMap(field => [field.key.toLowerCase(), fold(field.label)])];
  for (const field of fields) {
    if (field === "") continue;
    if (field.startsWith(s) || (s.startsWith(field) && FIELD_REST.test(s.slice(field.length)))) return true;
  }
  const names = [
    ...ctx.speakerNames.map(foldName),
    ...[ctx.userName, ...ctx.otherNames].map(foldName).filter(name => Array.from(name).length >= 2),
  ].filter(name => name !== "");
  const t = s.startsWith("**") ? s.slice(2) : s.startsWith("【") || s.startsWith("[") ? s.slice(1) : s;
  if (t === "") return true;
  return names.some(name => name.startsWith(t) || (t.startsWith(name) && NAME_REST.test(t.slice(name.length))));
}

/** Trailing lines the loose footer pass could still consume once a valid footer line follows them. */
function holdTrailingFooter(text: string, ctx: SoulReplyContext): string {
  const looksLikeFooter = footerLinePredicate(ctx);
  const lines = text.split("\n");
  let start = lines.length;
  let footerLines = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || FENCE_LINE.test(line) || RULE_LINE.test(line)) {
      start = index;
      continue;
    }
    if (!looksLikeFooter(line)) break;
    footerLines += 1;
    start = index;
  }
  return footerLines > 0 ? lines.slice(0, start).join("\n") : text;
}

function liveText(raw: string, ctx: SoulReplyContext): string {
  let text = stripReasoning(normalizeRaw(raw));
  const tag = TAIL_TAG.exec(text);
  if (tag) text = text.slice(0, tag.index);
  let asideAt = -1;
  for (const match of text.matchAll(ASIDE_OPEN)) asideAt = match.index ?? asideAt;
  if (asideAt >= 0 && !ASIDE_CLOSE.test(text.slice(asideAt))) text = text.slice(0, asideAt);

  const open = !text.endsWith("\n");
  if (open) {
    const cut = text.lastIndexOf("\n") + 1;
    if (holdLine(text.slice(cut), ctx)) text = text.slice(0, cut);
  }
  // An opening fence or a rule at the end may still belong to the footer.
  const lines = text.split("\n");
  let end = lines.length;
  for (let last = end - 1; ; last -= 1) {
    while (last >= 0 && (lines[last] ?? "").trim() === "") last -= 1;
    if (last < 0 || !(FENCE_LINE.test(lines[last] ?? "") || RULE_LINE.test(lines[last] ?? ""))) break;
    end = last;
  }
  text = holdTrailingFooter(lines.slice(0, end).join("\n"), ctx);

  let out = settle(analyse(text, ctx).visible, ctx);
  // A label the final pass strips (`A：A：…`) can uncover the start of another one on a still unfinished first line.
  if (open && !text.trim().includes("\n") && !out.includes("\n") && holdLine(out, ctx)) out = "";
  const forbidden = LIVE_FORBIDDEN.exec(out);
  if (forbidden) out = out.slice(0, forbidden.index);
  out = out.trimEnd();
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1).trimEnd() : out;
}

/** The visible text of a reply that is still being written. Pure; never throws ('' on any error). */
export function liveReplyText(raw: string, ctx: SoulReplyContext): string {
  try {
    return typeof raw === "string" && raw !== "" ? liveText(raw, ctx) : "";
  } catch {
    return "";
  }
}
