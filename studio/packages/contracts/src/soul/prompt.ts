// SPDX-License-Identifier: Apache-2.0
// The soul prompt: one IR with three zones. The system zone stays byte-identical between turns; the history window
// moves in steps of eight; everything volatile sits in the tail of the final user turn. Two renderers read the IR:
// a structured wire (system + messages) and one flat prompt.
import type {
  PaActiveEvent, PaCharacterDoc, PaChatSettingsDoc, PaChatWire, PaLoreTimer, PaMetaParts, PaSoulTrace, PaSoulWarning,
  PaStateOp, PaStateValue, PaStylePreset,
} from "../api/personal-agent-soul.js";
import { anyPart, buildFooterContract, footerReminder, renderFooter, resolveMetaParts } from "./footer.js";
import {
  SOUL_TEXT, fill, fillMapped, formatSoulDate, formatSoulDaypart, formatSoulDuration, formatSoulTime, formatSoulWeekday,
  soulClock, type SoulLocale, type SoulTextKey,
} from "./locale.js";
import { activateLore, type ActivateLoreInput, type ActivatedEntry } from "./lorebook.js";
import { expandMacros, type MacroContext } from "./macros.js";
import { resolveNames } from "./rules.js";
import { formatStateNumber } from "./state.js";
import { estimateTokens } from "./tokens.js";

export interface SoulHistoryItem {
  id: string;                                   // message id
  role: "owner" | "self" | "other" | "story";   // story: roll, draw and event messages
  name: string;                                 // speaker name; owner items carry the persona name
  text: string;
  at: number;
  mood?: string;                                // self items, for footer replay
  stateOps?: readonly PaStateOp[];
}
export interface ComposeSoulInput {
  conversationId: string;
  group: boolean;
  agentName: string;
  agentRole: string;                            // the character block when the speaker has no card
  character: PaCharacterDoc | null;
  persona: { id: string | null; name: string; description: string };
  preset: PaStylePreset;                        // already resolved
  chat: PaChatSettingsDoc;
  books: ActivateLoreInput["books"];
  loreTimers: Readonly<Record<string, PaLoreTimer>>;
  loreIndex: number;
  history: readonly SoulHistoryItem[];          // oldest first, in-context items only
  historyTotals: { total: number; hidden: number };
  memories: ReadonlyArray<{ id: string; content: string; source: string; kind?: string; dueAt?: number | null }>;
  state: Record<string, PaStateValue>;
  cast: ReadonlyArray<{ name: string; tagline: string }>;      // the other room members
  decks: ReadonlyArray<{ id: string; name: string }>;
  activeEvent: PaActiveEvent | null;
  directive: { kind: "continue" | "reachout" | "regenerate" | "react"; text?: string } | null;
  care: "none" | "concern" | "crisis";
  locale: SoulLocale;
  now: number; timezoneOffsetMin: number;
  lastOwnerAt: number | null;                   // time of the owner message before the pending ones
  lastMood: { text: string; at: number } | null;
  firstMetAt: number | null;
  contextTokens: number;
  historyBudgetTokens: number;
  regexTest?: ActivateLoreInput["regexTest"];
  rng: () => number;
}
export interface SoulBlock { id: string; text: string; tokens: number }
export interface SoulPart { id: string; kind: "text" | "aside"; role: SoulHistoryItem["role"] | "app"; name: string; text: string }
export interface SoulTurn { role: "user" | "assistant"; parts: SoulPart[] }
export interface SoulPromptIR {
  locale: SoulLocale; group: boolean; names: { char: string; user: string };
  system: SoulBlock[]; turns: SoulTurn[]; tail: SoulBlock[];
}
export interface ComposeSoulResult {
  ir: SoulPromptIR;
  wire: PaChatWire;                             // without contextTokens and sampling (the daemon adds them)
  flat: string;
  trace: PaSoulTrace;                           // wire: 'flat', no messageId, no footer (the daemon fills them)
  loreTimers: Record<string, PaLoreTimer>;
  parts: PaMetaParts;
  names: { char: string; user: string };
  replyTokens: number;
}

export const SOUL_BLOCK_IDS = {
  system: ["frame", "main", "style", "contract", "persona", "lore-before", "character", "lore-after", "cast", "examples"],
  tail: ["lore-triggered", "memory", "state", "event", "now", "care", "post", "directive", "reminder", "nudge"],
} as const satisfies {
  system: readonly ["frame", "main", "style", "contract", "persona", "lore-before", "character", "lore-after", "cast", "examples"];
  tail: readonly ["lore-triggered", "memory", "state", "event", "now", "care", "post", "directive", "reminder", "nudge"];
};

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MILESTONES = new Set([7, 30, 100, 365]);
const MEMORY_KINDS = new Set(["promise", "moment", "preference", "fact", "procedure"]);
const USER_ROLES: ReadonlySet<SoulPart["role"]> = new Set(["owner", "other", "story"]);

const nonEmpty = (text: string) => text.trim() !== "";
const firstCodePoints = (text: string, count: number) => Array.from(text).slice(0, count).join("");

interface Injection { id: string; depth: number; text: string }

export function composeSoulPrompt(input: ComposeSoulInput): ComposeSoulResult {
  const { locale, group, character, preset, chat, now, contextTokens } = input;
  const zh = locale === "zh";
  const text = SOUL_TEXT[locale];

  // 1. Names and parts.
  const names = resolveNames({ agentName: input.agentName, nickname: character?.nickname ?? null, personaName: input.persona.name, locale });
  const parts = resolveMetaParts({ preset, character, chat, group, care: input.care });
  const partsOn = anyPart(parts);
  const replyTokens = (preset.sampling.maxTokens ?? 1024) + (partsOn ? 160 : 0);

  // 2. Macros: every card, preset, lore, note and persona string. History is never expanded.
  const newest = (role?: SoulHistoryItem["role"]) => {
    for (let at = input.history.length - 1; at >= 0; at -= 1) {
      const item = input.history[at];
      if (item && (role === undefined || item.role === role)) return item.text;
    }
    return undefined;
  };
  const lastMessage = newest();
  const lastUserMessage = newest("owner");
  const lastCharMessage = newest("self");
  const volatileBlocks = new Set<string>();
  const baseContext: Omit<MacroContext, "blockId" | "zone"> = {
    char: names.char, user: names.user, persona: input.persona.description,
    now, timezoneOffsetMin: input.timezoneOffsetMin, locale,
    ...(lastMessage !== undefined ? { lastMessage } : {}),
    ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
    ...(lastCharMessage !== undefined ? { lastCharMessage } : {}),
    ...(input.lastOwnerAt !== null ? { idleMs: now - input.lastOwnerAt } : {}),
    state: new Map(Object.entries(input.state)),
    pickSeed: input.conversationId,
    rng: input.rng,
  };
  /** Expands `source`; `blockId` salts stable macros, `warnBlock` names the system block a volatile macro landed in. */
  const expand = (source: string, zone: "system" | "tail", blockId: string, options: { original?: string; warnBlock?: string } = {}) =>
    expandMacros(source, {
      ...baseContext, zone, blockId,
      ...(options.original !== undefined ? { original: options.original } : {}),
      ...(zone === "system" ? { onVolatile: () => volatileBlocks.add(options.warnBlock ?? blockId) } : {}),
    });
  /** A built-in string: its own text is expanded, inserted values are not. */
  const say = (key: SoulTextKey, zone: "system" | "tail", blockId: string, vars: Record<string, string | number> = {}) =>
    fillMapped(text[key], vars, literal => expand(literal, zone, blockId));

  // 3. World book.
  const speakerName = (item: SoulHistoryItem) =>
    (item.role === "self" ? names.char : item.name || (item.role === "owner" ? names.user : ""));
  const loreMessages = [...input.history].reverse().filter(item => nonEmpty(item.text)).map(item => {
    const name = speakerName(item);
    return group && name ? `${name}: ${item.text}` : item.text;
  });
  const characterNote = character?.characterNote ?? null;
  const chatNote = chat.authorNote;
  const lore = activateLore({
    books: input.books,
    disabled: new Set(chat.disabledLoreEntryIds),
    messages: loreMessages,
    extraScan: [chatNote?.text ?? "", characterNote?.text ?? ""].filter(nonEmpty),
    index: input.loreIndex,
    timers: input.loreTimers,
    names,
    maxBudget: Math.floor(0.35 * contextTokens),
    ...(input.regexTest ? { regexTest: input.regexTest } : {}),
    rng: input.rng,
  });
  const loreId = (entry: ActivatedEntry) => `lore:${entry.bookId}:${entry.entryId}`;
  const loreTexts = (entries: readonly ActivatedEntry[], zone: "system" | "tail", warnBlock: string) =>
    entries.map(entry => expand(entry.content, zone, loreId(entry), { warnBlock })).filter(nonEmpty);
  const withHeading = (heading: string, pieces: readonly string[]) =>
    (pieces.length > 0 ? `${heading}\n${pieces.join("\n\n")}` : "");

  // 4. System blocks.
  const system: SoulBlock[] = [];
  const pushBlock = (list: SoulBlock[], id: string, blockText: string) => {
    if (nonEmpty(blockText)) list.push({ id, text: blockText, tokens: estimateTokens(blockText) });
  };
  pushBlock(system, "frame", say("frame", "system", "frame"));
  const presetMain = expand(preset.main, "system", "main");
  pushBlock(system, "main", character && nonEmpty(character.systemPrompt)
    ? expand(character.systemPrompt, "system", "main", { original: presetMain })
    : presetMain);
  const styleLines = [
    say(`style.format.${preset.format}`, "system", "style"),
    say(`style.length.${preset.replyLength}`, "system", "style"),
    preset.narration !== "none" ? say(`style.narration.${preset.narration}`, "system", "style") : "",
    say(`style.agency.${preset.userAgency}`, "system", "style"),
    preset.tempo !== "normal" ? say(`style.tempo.${preset.tempo}`, "system", "style") : "",
    preset.multiBubble && preset.format === "im" ? say("style.multiBubble", "system", "style") : "",
    nonEmpty(preset.extra) ? expand(preset.extra, "system", "style") : "",
  ].filter(nonEmpty);
  pushBlock(system, "style", [say("style.heading", "system", "style"), ...styleLines].join("\n"));
  const stateSchema = !group && character ? character.stateSchema : [];
  pushBlock(system, "contract", expand(buildFooterContract({ parts, schema: stateSchema, decks: input.decks, locale }), "system", "contract"));
  if (nonEmpty(input.persona.description)) {
    pushBlock(system, "persona", `${say("persona.heading", "system", "persona")}\n${expand(input.persona.description, "system", "persona")}`);
  }
  const constantBefore = lore.included.filter(entry => entry.constant && entry.position === "before_char");
  const constantAfter = lore.included.filter(entry => entry.constant && entry.position === "after_char");
  pushBlock(system, "lore-before", withHeading(say("loreBefore.heading", "system", "lore-before"), loreTexts(constantBefore, "system", "lore-before")));
  if (character) {
    const scenario = nonEmpty(chat.scenario) ? chat.scenario : character.scenario;
    const pieces = [
      nonEmpty(character.description) ? expand(character.description, "system", "character") : "",
      nonEmpty(character.personality) ? say("character.personality", "system", "character") + expand(character.personality, "system", "character") : "",
      nonEmpty(scenario) ? say("character.scenario", "system", "character") + expand(scenario, "system", "character") : "",
    ].filter(nonEmpty);
    if (pieces.length > 0) pushBlock(system, "character", [say("character.heading", "system", "character"), ...pieces].join("\n"));
  } else if (nonEmpty(input.agentRole)) {
    pushBlock(system, "character", `${say("character.heading", "system", "character")}\n${input.agentRole}`);
  }
  pushBlock(system, "lore-after", withHeading(say("loreAfter.heading", "system", "lore-after"), loreTexts(constantAfter, "system", "lore-after")));
  if (group && input.cast.length > 0) {
    const castLines = input.cast.map(member => (nonEmpty(member.tagline)
      ? `- ${member.name}${zh ? "：" : ": "}${member.tagline}`
      : `- ${member.name}`));
    pushBlock(system, "cast", [say("cast.heading", "system", "cast"), ...castLines, say("cast.rule", "system", "cast")].join("\n"));
  }
  if (character && nonEmpty(character.exampleDialogue)) {
    const cap = Math.min(1500, Math.floor(0.1 * contextTokens));
    const kept: string[] = [];
    let used = 0;
    for (const block of character.exampleDialogue.split(/<START>/i).map(piece => piece.trim()).filter(nonEmpty)) {
      const expanded = expand(block, "system", "examples").trim();
      if (!expanded) continue;
      const tokens = estimateTokens(expanded);
      if (used + tokens > cap) break;
      used += tokens;
      kept.push(expanded);
    }
    if (kept.length > 0) {
      const examples = `${say("examples.heading", "system", "examples")}\n${kept.join("\n\n")}`;
      pushBlock(system, "examples", partsOn ? `${examples}\n\n${say("examples.contract", "system", "examples")}` : examples);
    }
  }

  // 5. Tail blocks.
  const tail: SoulBlock[] = [];
  const crisis = input.care === "crisis";
  const notesAtZero: string[] = [];
  if (characterNote && characterNote.depth === 0 && nonEmpty(characterNote.text)) {
    notesAtZero.push(expand(characterNote.text, "tail", "note-character"));
  }
  if (chatNote && chatNote.depth === 0 && nonEmpty(chatNote.text)) notesAtZero.push(expand(chatNote.text, "tail", "note-chat"));
  const triggered = [
    ...loreTexts(lore.included.filter(entry => !entry.constant && entry.position === "before_char"), "tail", "lore-triggered"),
    ...loreTexts(lore.included.filter(entry => !entry.constant && entry.position === "after_char"), "tail", "lore-triggered"),
    ...loreTexts(lore.included.filter(entry => entry.position === "at_depth" && entry.depth === 0), "tail", "lore-triggered"),
    ...notesAtZero.filter(nonEmpty),
  ];
  pushBlock(tail, "lore-triggered", withHeading(say("loreTriggered.heading", "tail", "lore-triggered"), triggered));

  const clock = soulClock(now, input.timezoneOffsetMin);
  const memories = [
    ...input.memories.filter(memory => memory.kind === "promise"),
    ...input.memories.filter(memory => memory.kind !== "promise"),
  ];
  if (memories.length > 0) {
    const memoryLines = memories.map(memory => {
      const kind = memory.kind !== undefined && MEMORY_KINDS.has(memory.kind) ? text[`memory.kind.${memory.kind}` as SoulTextKey] : "";
      const date = memory.kind === "promise" && typeof memory.dueAt === "number"
        ? formatSoulDate(soulClock(memory.dueAt, input.timezoneOffsetMin), locale, true)
        : "";
      const tag = kind ? `[${date ? `${kind} · ${date}` : kind}] ` : "";
      const source = nonEmpty(memory.source) ? (zh ? `（${memory.source}）` : ` (${memory.source})`) : "";
      return `- ${tag}${memory.content}${source}`;
    });
    pushBlock(tail, "memory", [say("memory.heading", "tail", "memory"), ...memoryLines].join("\n"));
  }

  if (parts.state && stateSchema.length > 0) {
    const empty = text["state.empty"];
    const stateLines = stateSchema.map(field => {
      const value = Object.hasOwn(input.state, field.key) ? input.state[field.key] : field.initial;
      let shown: string;
      if (Array.isArray(value)) shown = value.length > 0 ? value.join(zh ? "、" : ", ") : empty;
      else if (typeof value === "number") {
        shown = formatStateNumber(value);
        if (field.kind === "number" && field.max !== undefined) shown += ` / ${formatStateNumber(field.max)}`;
      } else shown = value !== undefined && value !== "" ? value : empty;
      return `${field.label} ${field.key} = ${shown}`;
    });
    pushBlock(tail, "state", [say("state.heading", "tail", "state"), ...stateLines].join("\n"));
  }

  if (!crisis && input.activeEvent) {
    const event = input.activeEvent;
    pushBlock(tail, "event", say("event", "tail", "event", { title: event.title, summary: event.summary, n: event.remainingTurns }));
  }

  const nowLines: string[] = [];
  if (preset.timeAware) {
    nowLines.push(say("now", "tail", "now", {
      date: formatSoulDate(clock, locale), weekday: formatSoulWeekday(clock, locale),
      time: formatSoulTime(clock), daypart: formatSoulDaypart(clock.hour, locale),
    }));
    if (input.lastOwnerAt !== null && now - input.lastOwnerAt >= 20 * MINUTE) {
      nowLines.push(say("gap", "tail", "now", { duration: formatSoulDuration(now - input.lastOwnerAt, locale) }));
    }
  }
  if (input.lastMood && nonEmpty(input.lastMood.text) && now - input.lastMood.at < DAY) {
    nowLines.push(say("mood", "tail", "now", { mood: input.lastMood.text, duration: formatSoulDuration(now - input.lastMood.at, locale) }));
  }
  let due: { content: string; dueAt: number } | null = null;
  for (const memory of input.memories) {
    if (memory.kind !== "promise" || typeof memory.dueAt !== "number") continue;
    if (memory.dueAt < now - 7 * DAY || memory.dueAt > now + 48 * HOUR) continue;
    if (!due || memory.dueAt < due.dueAt) due = { content: memory.content, dueAt: memory.dueAt };
  }
  if (due) {
    const days = soulClock(due.dueAt, input.timezoneOffsetMin).dayNumber - clock.dayNumber;
    const when = days === 0 ? text["due.today"]
      : days === 1 ? text["due.tomorrow"]
      : days === 2 ? text["due.dayAfter"]
      : days < 0 ? fill(text["due.past"], { n: -days })
      : formatSoulDate(soulClock(due.dueAt, input.timezoneOffsetMin), locale, true);
    nowLines.push(say("due", "tail", "now", { text: due.content, when }));
  }
  if (preset.timeAware && input.firstMetAt !== null) {
    const day = clock.dayNumber - soulClock(input.firstMetAt, input.timezoneOffsetMin).dayNumber + 1;
    if (MILESTONES.has(day)) nowLines.push(say("milestone", "tail", "now", { n: day }));
  }
  pushBlock(tail, "now", nowLines.join("\n"));

  if (input.care !== "none") pushBlock(tail, "care", say(input.care === "crisis" ? "care.crisis" : "care.concern", "tail", "care"));
  if (!crisis) {
    const presetPost = expand(preset.postHistory, "tail", "post");
    pushBlock(tail, "post", character && nonEmpty(character.postHistoryInstructions)
      ? expand(character.postHistoryInstructions, "tail", "post", { original: presetPost })
      : presetPost);
  }
  if (!crisis && input.directive) {
    const directiveText = input.directive.text;
    pushBlock(tail, "directive", [
      say(`directive.${input.directive.kind}`, "tail", "directive"),
      ...(directiveText !== undefined && nonEmpty(directiveText) ? [directiveText] : []),
    ].join("\n"));
  }
  const rememberHint = parts.remember && input.lastOwnerAt !== null && now - input.lastOwnerAt >= 6 * HOUR;
  pushBlock(tail, "reminder", expand(footerReminder(parts, locale, rememberHint), "tail", "reminder"));
  pushBlock(tail, "nudge", say(group ? "nudge.group" : "nudge", "tail", "nudge"));

  // 6. Budget of the fixed zones.
  const warnings: PaSoulWarning[] = [];
  const sumTokens = (blocks: readonly SoulBlock[]) => blocks.reduce((sum, block) => sum + block.tokens, 0);
  let fixed = sumTokens(system) + sumTokens(tail);
  const examplesAt = system.findIndex(block => block.id === "examples");
  if (fixed > 0.6 * contextTokens && examplesAt >= 0) {
    system.splice(examplesAt, 1);
    warnings.push({ code: "examples-dropped" });
    fixed = sumTokens(system) + sumTokens(tail);
  }
  if (fixed + replyTokens + 256 > contextTokens) warnings.push({ code: "over-window" });
  if (lore.constantCut) warnings.push({ code: "lore-constant-cut" });
  if (lore.regexTimeouts > 0) warnings.push({ code: "regex-timeout", detail: String(lore.regexTimeouts) });
  for (const block of system) {
    if (volatileBlocks.has(block.id)) warnings.push({ code: "volatile-macro-in-system", detail: block.id });
  }

  // 7. History window, anchored in steps of eight.
  const items = input.history.filter(item => nonEmpty(item.text));
  const count = items.length;
  const budget = Math.max(0, Math.min(input.historyBudgetTokens, contextTokens - fixed - replyTokens - 256));
  const suffix = new Array<number>(count + 1).fill(0);
  for (let at = count - 1; at >= 0; at -= 1) {
    const item = items[at];
    suffix[at] = (suffix[at + 1] ?? 0) + (item ? estimateTokens(item.name + item.text) : 0);
  }
  const fits = (start: number) => (suffix[start] ?? 0) <= budget;
  let start = -1;
  for (let candidate = 0; candidate <= count - 4; candidate += 8) {
    if (fits(candidate)) {
      start = candidate;
      break;
    }
  }
  if (start < 0) {
    start = Math.max(0, count - 4);
    if (!fits(start)) {
      start = Math.max(0, count - 2);
      warnings.push({ code: "history-floor" });
    }
  }
  const windowItems = items.slice(start).map(item => ({ ...item }));

  // 9. Footer replay on the last two `self` items.
  if (partsOn) {
    let replayed = 0;
    for (let at = windowItems.length - 1; at >= 0 && replayed < 2; at -= 1) {
      const item = windowItems[at];
      if (!item || item.role !== "self") continue;
      const footer = renderFooter({
        ...(item.mood !== undefined ? { mood: item.mood } : {}),
        ...(item.stateOps !== undefined ? { stateOps: item.stateOps } : {}),
        parts,
      });
      windowItems[at] = { ...item, text: `${item.text}\n\n${footer}` };
      replayed += 1;
    }
  }

  // 8. Injections: at-depth lore and notes with depth >= 1, as asides attached to user-role items.
  const injections: Injection[] = [];
  for (const entry of lore.included) {
    if (entry.position !== "at_depth" || entry.depth < 1) continue;
    const id = loreId(entry);
    injections.push({ id, depth: entry.depth, text: expand(entry.content, "tail", id) });
  }
  if (characterNote && characterNote.depth >= 1 && nonEmpty(characterNote.text)) {
    injections.push({ id: "note-character", depth: characterNote.depth, text: expand(characterNote.text, "tail", "note-character") });
  }
  if (chatNote && chatNote.depth >= 1 && nonEmpty(chatNote.text)) {
    injections.push({ id: "note-chat", depth: chatNote.depth, text: expand(chatNote.text, "tail", "note-chat") });
  }
  const before = windowItems.map((): SoulPart[] => []);
  const after = windowItems.map((): SoulPart[] => []);
  const lead: SoulPart[] = [];
  const isUserItem = (at: number) => {
    const item = windowItems[at];
    return item !== undefined && USER_ROLES.has(item.role);
  };
  for (const injection of injections) {
    if (!nonEmpty(injection.text)) continue;
    const part: SoulPart = { id: injection.id, kind: "aside", role: "app", name: "", text: injection.text };
    const boundary = Math.max(0, windowItems.length - injection.depth);
    if (boundary < windowItems.length && isUserItem(boundary)) {
      before[boundary]?.push(part);
      continue;
    }
    let host = -1;
    for (let at = Math.min(boundary, windowItems.length) - 1; at >= 0; at -= 1) {
      if (isUserItem(at)) {
        host = at;
        break;
      }
    }
    if (host >= 0) after[host]?.push(part);
    else lead.push(part);
  }

  // 10. Turns.
  const sequence: Array<{ role: SoulTurn["role"]; part: SoulPart }> = [];
  windowItems.forEach((item, at) => {
    for (const part of before[at] ?? []) sequence.push({ role: "user", part });
    sequence.push({
      role: item.role === "self" ? "assistant" : "user",
      part: { id: item.id, kind: item.role === "story" ? "aside" : "text", role: item.role, name: item.name, text: item.text },
    });
    for (const part of after[at] ?? []) sequence.push({ role: "user", part });
  });
  const turns: SoulTurn[] = [];
  for (const { role, part } of sequence) {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else turns.push({ role, parts: [part] });
  }
  if (turns.length > 0 && turns[0]?.role !== "user") {
    turns.unshift({ role: "user", parts: [{ id: "start", kind: "aside", role: "app", name: "", text: say("start", "tail", "start") }] });
  }
  if (turns.length === 0 || turns[turns.length - 1]?.role !== "user") turns.push({ role: "user", parts: [] });
  if (lead.length > 0) turns.find(turn => turn.role === "user")?.parts.unshift(...lead);

  // 11. Render.
  const ir: SoulPromptIR = { locale, group, names, system, turns, tail };
  const wire = renderWire(ir);
  const flat = renderFlat(ir);
  const stop = stopSequences(names, input.cast.map(member => member.name), group);

  // 12. Trace.
  const historyTokens = turns.reduce((sum, turn) =>
    sum + turn.parts.reduce((inner, part) => inner + estimateTokens(part.name + part.text), 0), 0);
  const trace: PaSoulTrace = {
    conversationId: input.conversationId,
    at: now,
    speaker: { agentId: "", name: names.char },
    persona: { id: input.persona.id, name: names.user },
    preset: { id: preset.id, name: preset.name },
    locale,
    wire: "flat",
    parts,
    blocks: [
      ...system.map(block => ({ id: block.id, zone: "system" as const, tokens: block.tokens })),
      { id: "history", zone: "history", tokens: historyTokens },
      ...tail.map(block => ({ id: block.id, zone: "tail" as const, tokens: block.tokens })),
    ],
    lore: lore.trace,
    loreInactive: lore.trace.filter(entry => entry.status === "inactive").length,
    loreBudget: { used: lore.used, limit: lore.limit },
    memories: input.memories.map(memory => ({ id: memory.id, title: firstCodePoints(memory.content, 40) })),
    history: { included: windowItems.length, total: input.historyTotals.total, hidden: input.historyTotals.hidden },
    totalTokens: fixed + historyTokens,
    contextTokens,
    replyTokens,
    warnings,
  };

  return {
    ir,
    wire: { system: wire.system, messages: wire.messages, transcript: flat.transcript, stop },
    flat: flat.flat,
    trace,
    loreTimers: lore.timers,
    parts,
    names,
    replyTokens,
  };
}

const aside = (body: string) => `<aside>${body}</aside>`;

function renderPart(part: SoulPart, ir: SoulPromptIR): string {
  if (part.kind === "aside") return aside(part.text);
  if (!ir.group || part.role === "self") return part.text;
  const name = part.role === "owner" ? part.name || ir.names.user : part.name;
  return name ? `${name}: ${part.text}` : part.text;
}

export function renderWire(ir: SoulPromptIR): { system: string; messages: PaChatWire["messages"] } {
  const system = ir.system.map(block => block.text).join("\n\n");
  const messages: PaChatWire["messages"] = ir.turns.map(turn => ({
    role: turn.role, content: turn.parts.map(part => renderPart(part, ir)).join("\n\n"),
  }));
  const tail = ir.tail.map(block => aside(block.text));
  let last = -1;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    if (messages[at]?.role === "user") {
      last = at;
      break;
    }
  }
  const target = last >= 0 ? messages[last] : undefined;
  if (target) target.content = [target.content, ...tail].filter(piece => piece !== "").join("\n\n");
  else messages.push({ role: "user", content: tail.join("\n\n") });
  return { system, messages };
}

export function renderFlat(ir: SoulPromptIR): { flat: string; transcript: string } {
  const text = SOUL_TEXT[ir.locale];
  const blocks = ir.turns.flatMap(turn => turn.parts.map(part => {
    if (part.kind === "aside") return aside(part.text);
    const name = part.role === "self" ? ir.names.char : part.role === "owner" ? part.name || ir.names.user : part.name;
    return name ? `${name}: ${part.text}` : part.text;
  }));
  const conversation = ["<conversation>", ...(blocks.length > 0 ? [blocks.join("\n\n")] : []), "</conversation>"].join("\n");
  const closing = expandMacros(text.flatClosing, {
    char: ir.names.char, user: ir.names.user, persona: "", now: 0, timezoneOffsetMin: 0, locale: ir.locale,
    pickSeed: "", blockId: "flatClosing", zone: "tail", rng: () => 0,
  });
  const transcript = [conversation, ...ir.tail.map(block => aside(block.text)), closing].join("\n\n");
  const system = ir.system.map(block => block.text).join("\n\n");
  return { flat: `${text.flatHeader}\n\n${system}\n\n${transcript}`, transcript };
}

export function stopSequences(names: { char: string; user: string }, others: readonly string[], group: boolean): string[] {
  const out: string[] = [];
  for (const raw of [names.user, ...(group ? others : [])]) {
    const name = raw.trim();
    if (Array.from(name).length < 2) continue;
    for (const stop of [`\n${name}:`, `\n${name}：`]) if (!out.includes(stop)) out.push(stop);
  }
  return out.slice(0, 8);
}
