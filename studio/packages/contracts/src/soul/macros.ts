// SPDX-License-Identifier: Apache-2.0
// Macro expansion for card, preset, lore, note and persona strings. One left-to-right pass; the output of a macro is
// inserted verbatim and never rescanned. Writer macros never run. History and the user's own text are never expanded.
import type { PaStateValue } from "../api/personal-agent-soul.js";
import {
  formatSoulDate, formatSoulDaypart, formatSoulDuration, formatSoulIsoDate, formatSoulTime, formatSoulWeekday,
  soulClock, type SoulLocale,
} from "./locale.js";
import { rollDice } from "./play.js";
import { hashSeed, seededRng } from "./rng.js";
import { formatStateNumber } from "./state.js";

export interface MacroContext {
  char: string; user: string;
  persona: string;                                   // persona description
  original?: string;                                 // text being overridden ({{original}})
  now: number; timezoneOffsetMin: number; locale: SoulLocale;
  lastMessage?: string; lastUserMessage?: string; lastCharMessage?: string;
  idleMs?: number;
  state?: ReadonlyMap<string, PaStateValue>;
  pickSeed: string;                                  // the conversation id
  blockId: string;                                   // salt for stable macros
  zone: "system" | "tail" | "greeting";
  rng: () => number;                                 // real randomness; used only when zone !== 'system'
  onVolatile?: (name: string) => void;               // a time macro was expanded in zone 'system'
}

/** Bodies longer than this are literal text. */
const MAX_TAG_BODY = 2000;
const VOLATILE = new Set(["time", "date", "weekday", "isodate", "isotime", "daypart", "idle_duration"]);
const WRITERS = ["setvar", "addvar", "incvar", "decvar", "deletevar", "setglobalvar", "addglobalvar", "incglobalvar",
  "decglobalvar"];
const LEGACY_TAG = /<(user|bot|char)>/gi;

interface MacroCall {
  args: readonly string[];
  body: string;                                      // the trimmed tag body
  random: () => number;                              // the random source this tag may use
}
type MacroFn = (call: MacroCall, ctx: MacroContext) => string;

function pickOne(args: readonly string[], random: () => number): string {
  if (args.length === 0) return "";
  const index = Math.min(args.length - 1, Math.max(0, Math.floor(random() * args.length)));
  return args[index] ?? "";
}

function stateText(value: PaStateValue, locale: SoulLocale): string {
  if (Array.isArray(value)) return value.join(locale === "zh" ? "、" : ", ");
  return typeof value === "number" ? formatStateNumber(value) : value;
}

function lookupState(state: ReadonlyMap<string, PaStateValue> | undefined, key: string): PaStateValue | undefined {
  if (!state || !key) return undefined;
  const direct = state.get(key);
  if (direct !== undefined) return direct;
  const folded = key.toLowerCase();
  for (const [name, value] of state) if (name.toLowerCase() === folded) return value;
  return undefined;
}

const clockOf = (ctx: MacroContext) => soulClock(ctx.now, ctx.timezoneOffsetMin);

const REGISTRY = new Map<string, MacroFn>([
  ["char", (_call, ctx) => ctx.char],
  ["user", (_call, ctx) => ctx.user],
  ["persona", (_call, ctx) => ctx.persona],
  ["original", (_call, ctx) => ctx.original ?? ""],
  ["random", call => pickOne(call.args, call.random)],
  ["pick", (call, ctx) => pickOne(call.args, seededRng(`${ctx.pickSeed}:${hashSeed(call.body)}`))],
  ["roll", call => {
    const raw = (call.args[0] ?? "").trim();
    const notation = /^\d+$/.test(raw) ? `1d${raw}` : raw;
    const result = notation ? rollDice(notation, call.random) : null;
    return result ? String(result.total) : "";
  }],
  ["time", (_call, ctx) => formatSoulTime(clockOf(ctx))],
  ["date", (_call, ctx) => formatSoulDate(clockOf(ctx), ctx.locale)],
  ["weekday", (_call, ctx) => formatSoulWeekday(clockOf(ctx), ctx.locale)],
  ["isodate", (_call, ctx) => formatSoulIsoDate(clockOf(ctx))],
  ["isotime", (_call, ctx) => formatSoulTime(clockOf(ctx))],
  ["daypart", (_call, ctx) => formatSoulDaypart(clockOf(ctx).hour, ctx.locale)],
  ["idle_duration", (_call, ctx) => formatSoulDuration(ctx.idleMs, ctx.locale)],
  ["lastmessage", (_call, ctx) => ctx.lastMessage ?? ""],
  ["lastusermessage", (_call, ctx) => ctx.lastUserMessage ?? ""],
  ["lastcharmessage", (_call, ctx) => ctx.lastCharMessage ?? ""],
  ["getvar", (call, ctx) => {
    const value = lookupState(ctx.state, (call.args[0] ?? "").trim());
    return value === undefined ? "" : stateText(value, ctx.locale);
  }],
  ["newline", () => "\n"],
  ...WRITERS.map((name): [string, MacroFn] => [name, () => ""]),
]);

/** Splits on commas; `\,` is a literal comma. Items are trimmed. */
function splitCommaArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === ",") {
      current += ",";
      index += 1;
    } else if (char === ",") {
      args.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  args.push(current.trim());
  return args;
}

/** Tag grammar: `//` comment; `name::a::b`; `name:a,b`; otherwise the first word is the name and the rest one argument. */
function parseTag(body: string): { comment: true } | { comment: false; name: string; args: string[] } {
  if (body.startsWith("//")) return { comment: true };
  const double = body.indexOf("::");
  if (double >= 0) {
    return { comment: false, name: body.slice(0, double).trim().toLowerCase(), args: body.slice(double + 2).split("::") };
  }
  const colon = body.indexOf(":");
  if (colon >= 0) {
    return { comment: false, name: body.slice(0, colon).trim().toLowerCase(), args: splitCommaArgs(body.slice(colon + 1)) };
  }
  const match = /^(\S*)\s*([\s\S]*)$/.exec(body);
  const name = (match?.[1] ?? "").toLowerCase();
  const rest = match?.[2] ?? "";
  return { comment: false, name, args: rest ? [rest] : [] };
}

export function expandMacros(text: string, ctx: MacroContext): string {
  if (!text.includes("{{") && !/<(?:user|bot|char)>/i.test(text)) return text;
  const legacy = (literal: string) => literal.replace(LEGACY_TAG, (_match, name: string) =>
    (name.toLowerCase() === "user" ? ctx.user : ctx.char));
  let out = "";
  let trimNext = false;
  const emit = (piece: string) => {
    let next = piece;
    if (trimNext) {
      next = next.replace(/^\s+/, "");
      if (!next) return;
      trimNext = false;
    }
    out += next;
  };
  let tagIndex = 0;
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("{{", pos);
    const close = open < 0 ? -1 : text.indexOf("}}", open + 2);
    if (open < 0 || close < 0) {
      emit(legacy(text.slice(pos)));
      break;
    }
    const body = text.slice(open + 2, close);
    const inner = body.indexOf("{{");
    if (inner >= 0) {
      // The first `{{` is literal; scanning resumes at the inner one.
      emit(legacy(text.slice(pos, open + 2 + inner)));
      pos = open + 2 + inner;
      continue;
    }
    if (body.length > MAX_TAG_BODY) {
      emit(legacy(text.slice(pos, open + 2)));
      pos = open + 2;
      continue;
    }
    emit(legacy(text.slice(pos, open)));
    pos = close + 2;
    const index = tagIndex;
    tagIndex += 1;
    const trimmed = body.trim();
    const tag = parseTag(trimmed);
    if (tag.comment) continue;
    if (tag.name === "trim") {
      out = out.trimEnd();   // same characters as /\s+$/, without its quadratic scan over inner whitespace runs
      trimNext = true;
      continue;
    }
    const fn = REGISTRY.get(tag.name);
    if (!fn) {
      emit(text.slice(open, close + 2));
      continue;
    }
    if (ctx.zone === "system" && VOLATILE.has(tag.name)) ctx.onVolatile?.(tag.name);
    let random: (() => number) | null = null;
    const call: MacroCall = {
      args: tag.args,
      body: trimmed,
      random: () => {
        if (random === null) {
          random = ctx.zone === "system" ? seededRng(`${ctx.pickSeed}:${ctx.blockId}:${index}`) : ctx.rng;
        }
        return random();
      },
    };
    emit(fn(call, ctx));
  }
  return out;
}
