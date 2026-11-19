// SPDX-License-Identifier: Apache-2.0
// World-book import and export: SillyTavern world files and card `character_book` blocks to and from lorebooks.
// Imported text is data: only eight decorators are interpreted, scripts never run and remote URLs are never fetched.
import { PA_LORE_LOGIC, paLorebookInputSchema } from "../api/personal-agent-soul.js";
import type {
  PaLoreEntry,
  PaLorebook,
  PaLorebookDoc,
  PaLorebookImportMeta,
  PaNeedsReviewItem,
  PaWorldImportPreview,
} from "../api/personal-agent-soul.js";
import { bool, isRecord, num, str, strList } from "./coerce.js";
import type { ReviewSink } from "./coerce.js";
import { SOUL_LIMITS as L } from "./limits.js";
import { compileLoreKey, splitKeyList } from "./lore-key.js";
import { capPreserved, sanitizeForeign } from "./sanitize.js";

export interface WorldImportOptions { name?: string; fileName?: string }

type LoreRole = PaLoreEntry["role"];
type LorePosition = PaLoreEntry["position"];
type LoreLogic = PaLoreEntry["logic"];

const ROLES: readonly LoreRole[] = ["system", "user", "assistant"];
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
/** Keys of `entry.preserved` the mapping owns: the original uid, the original position number, raw decorator lines. */
const BOOKKEEPING: ReadonlySet<string> = new Set(["uid", "position", "decorators"]);
/** Top-level fields a SillyTavern world entry maps; everything else is preserved. */
const WORLD_FIELDS: ReadonlySet<string> = new Set([
  "uid", "key", "keysecondary", "selective", "selectiveLogic", "comment", "content", "disable", "constant", "order",
  "position", "depth", "role", "scanDepth", "caseSensitive", "matchWholeWords", "probability", "useProbability", "group",
  "groupOverride", "groupWeight", "sticky", "cooldown", "delay", "excludeRecursion", "preventRecursion",
  "delayUntilRecursion", "ignoreBudget",
]);
/** Top-level fields a card `character_book` entry maps (`extensions` is split by CARD_EXTENSION_FIELDS). */
const CARD_FIELDS: ReadonlySet<string> = new Set([
  "id", "keys", "secondary_keys", "selective", "comment", "name", "content", "enabled", "constant", "insertion_order",
  "position", "case_sensitive", "extensions",
]);
const CARD_EXTENSION_FIELDS: ReadonlySet<string> = new Set([
  "selectiveLogic", "position", "depth", "role", "scan_depth", "case_sensitive", "match_whole_words", "probability",
  "useProbability", "group", "group_override", "group_weight", "sticky", "cooldown", "delay", "exclude_recursion",
  "prevent_recursion", "delay_until_recursion", "ignore_budget",
]);
/** Book-level keys that are read or dropped; any other book key is preserved. */
const BOOK_FIELDS: ReadonlySet<string> = new Set(["entries", "name", "scan_depth", "token_budget", "recursive_scanning", "originalData"]);

const DECORATOR_LINE = /^@@@?[a-z_]+( .*)?$/;
const APPLIED_DECORATOR = /^@@([a-z_]+)(?: (.*))?$/;
const TEMPLATE_LINE = /<%|%>|_\.set\(|<\/?UpdateVariable/;

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const present = (value: unknown): boolean => value !== undefined && value !== null;
const safeKeys = (record: Record<string, unknown>): string[] => Object.keys(record).filter(key => !RESERVED_KEYS.has(key));
const clipForSummary = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

// ---- small shared helpers (also used by card.ts) -----------------------------------------------------------------

/** `0 | 'system'`, `1 | 'user'`, `2 | 'assistant'` (numeric strings and any letter case accepted); anything else `def`. */
export function coerceRole(value: unknown, def: LoreRole = "system"): LoreRole {
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    const named = ROLES.find(role => role === word);
    if (named !== undefined) return named;
    return /^[0-2]$/.test(word) ? (ROLES[Number(word)] ?? def) : def;
  }
  if (value === 0 || value === 1 || value === 2) return ROLES[value] ?? def;
  return def;
}

/** The file name without directories and without its last extension; '' when nothing is left. */
export function fileNameStem(fileName: string | null | undefined): string {
  if (typeof fileName !== "string") return "";
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

/** Caps a report at `SOUL_LIMITS.needsReview` items; when capped, the last item says how many were dropped. */
const REVIEW_KEY_CHARS = 200;
const REVIEW_SUMMARY_CHARS = 400;
const clipTo = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** At most `needsReview` items, each with a clipped key and summary: foreign key names can be megabytes long. */
export function capNeedsReview(items: readonly PaNeedsReviewItem[]): PaNeedsReviewItem[] {
  const clipped = items.slice(0, L.needsReview).map(item => ({
    ...item, key: clipTo(item.key, REVIEW_KEY_CHARS), summary: clipTo(item.summary, REVIEW_SUMMARY_CHARS),
  }));
  if (items.length <= L.needsReview) return clipped;
  const kept = clipped.slice(0, L.needsReview - 1);
  const dropped = items.length - kept.length;
  return [...kept, { key: "needsReview", kind: "other", action: "truncated", summary: `${dropped} more items were not listed` }];
}

// ---- field readers -----------------------------------------------------------------------------------------------

/** `null` when absent or null; a boolean for a boolean-like value; `null` for anything else (the book setting applies). */
function triState(value: unknown): boolean | null {
  if (!present(value)) return null;
  const yes = bool(value, true);
  return yes === bool(value, false) ? yes : null;
}

/** True for `true`, `'true'`, `1` and any positive number (SillyTavern stores a recursion level there). */
function truthy(value: unknown): boolean {
  return bool(value, false) || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

/** 0 and_any, 1 not_all, 2 not_any, 3 and_all (numbers or numeric strings); our own names are accepted too. */
function readLogic(value: unknown): LoreLogic {
  if (typeof value === "string") {
    const named = PA_LORE_LOGIC.find(logic => logic === value.trim());
    if (named !== undefined) return named;
  }
  return PA_LORE_LOGIC[num(value, -1, -Infinity, Infinity, true)] ?? "and_any";
}

function positionNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d{1,15}\s*$/.test(value)) return Number(value);
  return null;
}

interface PositionRead {
  position: LorePosition;
  number: number | null;   // the original SillyTavern position number, stored in preserved.position
  depth?: number;          // forced by positions 2 and 3
  role?: LoreRole;
  outlet?: boolean;        // position 7
}

function readPosition(value: unknown): PositionRead {
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "before_char" || word === "after_char" || word === "at_depth") return { position: word, number: null };
  }
  const n = positionNumber(value);
  switch (n) {
    case 0: return { position: "before_char", number: 0 };
    case 1: return { position: "after_char", number: 1 };
    case 2:
    case 3: return { position: "at_depth", number: n, depth: 4, role: "system" };
    case 4: return { position: "at_depth", number: 4 };
    case 5:
    case 6: return { position: "after_char", number: n };
    case 7: return { position: "before_char", number: 7, outlet: true };
    default: return { position: "before_char", number: n };
  }
}

function numberArg(text: string): number | null {
  return /^-?\d{1,15}(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

/** Splits leading decorator lines off the content. */
function splitDecorators(content: string): { decorators: string[]; body: string } {
  const lines = content.split("\n");
  let index = 0;
  while (index < lines.length && DECORATOR_LINE.test(lines[index] ?? "")) index += 1;
  if (index === 0) return { decorators: [], body: content };
  return { decorators: lines.slice(0, index), body: lines.slice(index).join("\n") };
}

function appendKeys(keys: readonly string[], arg: string): string[] {
  const out = [...keys];
  for (const key of splitKeyList(arg)) {
    if (out.length >= L.loreKeys) break;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Applies one of the eight interpreted decorators; any other line is preserved only. */
function applyDecorator(line: string, entry: PaLoreEntry): void {
  const match = APPLIED_DECORATOR.exec(line);
  if (!match) return;
  const arg = (match[2] ?? "").trim();
  const n = numberArg(arg);
  switch (match[1]) {
    case "depth":
      if (n !== null) {
        entry.position = "at_depth";
        entry.depth = num(n, 4, 0, L.loreDepth, true);
      }
      break;
    case "role": {
      const role = ROLES.find(name => name === arg);
      if (role !== undefined) entry.role = role;
      break;
    }
    case "scan_depth":
      if (n !== null) entry.scanDepth = num(n, 4, 0, L.loreScanDepth, true);
      break;
    case "position":
      if (arg === "after_desc") entry.position = "after_char";
      else if (arg === "before_desc") entry.position = "before_char";
      break;
    case "activate":
      entry.constant = true;
      break;
    case "dont_activate":
      entry.enabled = false;
      break;
    case "activate_only_after":
      if (n !== null) entry.delay = num(n * 2, 0, 0, L.loreTimer, true);
      break;
    case "additional_keys":
      entry.keys = appendKeys(entry.keys, arg);
      break;
    default:
      break;
  }
}

/** Whether an interpreted decorator still says what the entry says (export writes back only those). */
function decoratorHolds(line: string, entry: PaLoreEntry): boolean {
  const match = APPLIED_DECORATOR.exec(line);
  if (!match) return true;
  const arg = (match[2] ?? "").trim();
  const n = numberArg(arg);
  switch (match[1]) {
    case "depth": return n === null || (entry.position === "at_depth" && entry.depth === num(n, 4, 0, L.loreDepth, true));
    case "role": return !ROLES.some(name => name === arg) || entry.role === arg;
    case "scan_depth": return n === null || entry.scanDepth === num(n, 4, 0, L.loreScanDepth, true);
    case "position":
      if (arg === "after_desc") return entry.position === "after_char";
      if (arg === "before_desc") return entry.position === "before_char";
      return true;
    case "activate": return entry.constant;
    case "dont_activate": return !entry.enabled;
    case "activate_only_after": return n === null || entry.delay === num(n * 2, 0, 0, L.loreTimer, true);
    case "additional_keys": return splitKeyList(arg).every(key => entry.keys.includes(key));
    default: return true;
  }
}

function isTemplateContent(text: string): boolean {
  if (text.trimStart().startsWith("<%")) return true;
  let lines = 0;
  let hits = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lines += 1;
    if (TEMPLATE_LINE.test(line)) hits += 1;
  }
  return lines > 0 && hits * 2 > lines;
}

function reviewKeys(keys: readonly string[], field: string, sink: ReviewSink): void {
  for (const key of keys) {
    const compiled = compileLoreKey(key);
    if (compiled.kind === "invalid") {
      sink({ key: field, kind: "regex", action: "kept", summary: `invalid regex key ${clipForSummary(key)} never matches` });
    } else if (compiled.kind === "regex" && !compiled.safe) {
      sink({
        key: field, kind: "regex", action: "kept",
        summary: `regex key ${clipForSummary(key)} is outside the safe subset; only the time-limited tester runs it`,
      });
    } else if (compiled.kind === "text" && key.includes("，")) {
      sink({ key: field, kind: "other", action: "kept", summary: `key ${clipForSummary(key)} contains a full-width comma and may never match` });
    }
  }
}

// ---- entries -----------------------------------------------------------------------------------------------------

/** One foreign entry (card `character_book` entry or SillyTavern world entry) to a schema-valid entry.
 *  `index` is the 0-based position in file order; the id is `e${index + 1}`. */
export function mapLoreEntry(raw: unknown, index: number, sink: ReviewSink): PaLoreEntry {
  const source = isRecord(raw) ? raw : {};
  const id = `e${Number.isSafeInteger(index) && index >= 0 ? index + 1 : 1}`;
  const at = (name: string) => `entries.${id}.${name}`;
  const worldStyle = !Object.hasOwn(source, "keys")
    && ["key", "keysecondary", "uid", "disable"].some(name => Object.hasOwn(source, name));
  const extensions = worldStyle ? undefined : own(source, "extensions");
  const ext: Record<string, unknown> = isRecord(extensions) ? extensions : {};
  /** World entry: `worldKey`. Card entry: `extensions[extKey]` first, then the top-level `cardKey`. */
  const read = (worldKey: string, cardKey: string | null, extKey: string | null): unknown => {
    if (worldStyle) return own(source, worldKey);
    if (extKey !== null) {
      const value = own(ext, extKey);
      if (present(value)) return value;
    }
    return cardKey === null ? undefined : own(source, cardKey);
  };

  const comment = own(source, "comment");
  const titleSource = worldStyle || (typeof comment === "string" ? comment !== "" : present(comment)) ? comment : own(source, "name");
  const { decorators, body } = splitDecorators(str(read("content", "content", null), Number.MAX_SAFE_INTEGER, at("content"), sink));
  const place = readPosition(worldStyle ? own(source, "position") : (positionNumber(own(ext, "position")) ?? own(source, "position")));
  const scanDepth = read("scanDepth", null, "scan_depth");
  const entry: PaLoreEntry = {
    id,
    title: str(titleSource, L.loreTitle, at("title"), sink),
    keys: splitKeyList(read("key", "keys", null)),
    secondaryKeys: splitKeyList(read("keysecondary", "secondary_keys", null)),
    selective: bool(read("selective", "selective", null), true),
    logic: readLogic(read("selectiveLogic", null, "selectiveLogic")),
    content: str(body, L.loreContent, at("content"), sink),
    enabled: worldStyle ? !bool(own(source, "disable"), false) : bool(own(source, "enabled"), true),
    constant: bool(read("constant", "constant", null), false),
    order: num(read("order", "insertion_order", null), 100, -L.loreOrder, L.loreOrder, true),
    position: place.position,
    depth: place.depth ?? num(read("depth", null, "depth"), 4, 0, L.loreDepth, true),
    role: place.role ?? coerceRole(read("role", null, "role")),
    scanDepth: present(scanDepth) ? num(scanDepth, 4, 0, L.loreScanDepth, true) : null,
    caseSensitive: triState(read("caseSensitive", "case_sensitive", "case_sensitive")),
    matchWholeWords: triState(read("matchWholeWords", null, "match_whole_words")),
    probability: bool(read("useProbability", null, "useProbability"), true) === false
      ? 100
      : num(read("probability", null, "probability"), 100, 0, 100, true),
    groups: strList(read("group", null, "group"), L.loreGroups, L.loreGroup, at("groups"), sink),
    groupOverride: bool(read("groupOverride", null, "group_override"), false),
    groupWeight: num(read("groupWeight", null, "group_weight"), 100, 1, L.loreGroupWeight, true),
    sticky: num(read("sticky", null, "sticky"), 0, 0, L.loreTimer, true),
    cooldown: num(read("cooldown", null, "cooldown"), 0, 0, L.loreTimer, true),
    delay: num(read("delay", null, "delay"), 0, 0, L.loreTimer, true),
    excludeRecursion: bool(read("excludeRecursion", null, "exclude_recursion"), false),
    preventRecursion: bool(read("preventRecursion", null, "prevent_recursion"), false),
    recursionOnly: truthy(read("delayUntilRecursion", null, "delay_until_recursion")),
    ignoreBudget: bool(read("ignoreBudget", null, "ignore_budget"), false),
    preserved: {},
  };

  if (place.outlet === true) {
    entry.enabled = false;
    sink({
      key: at("position"), kind: "other", action: "disabled",
      summary: `entry ${id} is an outlet entry (position 7) that only a macro places; imported disabled`,
    });
  }
  for (const line of decorators) applyDecorator(line, entry);
  if (isTemplateContent(entry.content)) {
    entry.enabled = false;
    sink({ key: at("content"), kind: "script", action: "disabled", summary: `entry ${id} is template or command code; imported disabled` });
  }
  reviewKeys(entry.keys, at("keys"), sink);
  reviewKeys(entry.secondaryKeys, at("secondaryKeys"), sink);
  if (bool(read("vectorized", "vectorized", "vectorized"), false) && entry.keys.length === 0) {
    sink({ key: at("keys"), kind: "other", action: "kept", summary: `entry ${id} was vector-matched and has no keys; it only fires when constant` });
  }

  // Preserved: bookkeeping first so a large unmapped field cannot push it out.
  const head: Array<[string, unknown]> = [];
  const uid = worldStyle ? own(source, "uid") : (present(own(source, "id")) ? own(source, "id") : own(source, "uid"));
  if (present(uid)) head.push(["uid", uid]);
  if (place.number !== null) head.push(["position", place.number]);
  if (decorators.length > 0) head.push(["decorators", decorators]);
  const consumed = worldStyle ? WORLD_FIELDS : CARD_FIELDS;
  const unmapped: Array<[string, unknown]> = [];
  for (const key of safeKeys(source)) if (!consumed.has(key) && !BOOKKEEPING.has(key)) unmapped.push([key, source[key]]);
  if (!worldStyle) {
    const unknownExtensions = safeKeys(ext).filter(key => !CARD_EXTENSION_FIELDS.has(key)).map((key): [string, unknown] => [key, ext[key]]);
    if (unknownExtensions.length > 0) unmapped.push(["extensions", Object.fromEntries(unknownExtensions)]);
  }
  const cleaned = sanitizeForeign(Object.fromEntries([...head, ...unmapped]));
  const { kept, dropped } = capPreserved(isRecord(cleaned) ? cleaned : {}, L.entryPreserved);
  if (dropped.length > 0) {
    sink({
      key: at("preserved"), kind: "other", action: "truncated",
      summary: `entry ${id}: ${dropped.length} preserved fields over ${L.entryPreserved} chars dropped (${clipForSummary(dropped.join(", "))})`,
    });
  }
  entry.preserved = kept;
  return entry;
}

/** An entries array, or an object map read numeric keys ascending, then other keys in insertion order. */
function entryList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  const keys = safeKeys(value);
  const numeric = keys.filter(key => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
  const other = keys.filter(key => !/^\d+$/.test(key));
  return [...numeric, ...other].map(key => value[key]);
}

// ---- books -------------------------------------------------------------------------------------------------------

interface BookSource {
  format: "card" | "st-world";
  names: readonly unknown[];      // name candidates in order; the first non-empty string wins
  originName: string | null;      // null: the resolved book name
}

function mapBook(book: Record<string, unknown>, source: BookSource, sink: ReviewSink):
  { lorebook: PaLorebookDoc; meta: PaLorebookImportMeta } | null {
  const items: PaNeedsReviewItem[] = [];
  const report: ReviewSink = item => {
    items.push(item);
    sink(item);
  };

  const entries: PaLoreEntry[] = [];
  let skipped = 0;
  let overflow = 0;
  for (const raw of entryList(own(book, "entries")) ?? []) {
    if (!isRecord(raw)) skipped += 1;
    else if (entries.length >= L.loreEntries) overflow += 1;
    else entries.push(mapLoreEntry(raw, entries.length, report));
  }
  if (skipped > 0) report({ key: "entries", kind: "other", action: "truncated", summary: `${skipped} entries were not objects and were skipped` });
  if (overflow > 0) {
    report({ key: "entries", kind: "other", action: "truncated", summary: `${overflow} entries over the limit of ${L.loreEntries} were dropped` });
  }
  let total = entries.reduce((sum, entry) => sum + entry.content.length, 0);
  let cut = 0;
  while (total > L.loreContentTotal) {
    const last = entries.pop();
    if (last === undefined) break;
    total -= last.content.length;
    cut += 1;
  }
  if (cut > 0) {
    report({
      key: "entries", kind: "other", action: "truncated",
      summary: `${cut} entries dropped from the end: total content is limited to ${L.loreContentTotal} chars`,
    });
  }

  let name = "";
  for (const candidate of source.names) {
    const text = typeof candidate === "string" ? candidate.trim() : "";
    if (text) {
      name = str(text, L.lorebookName, "name", report).trim();
      break;
    }
  }
  if (!name) name = "世界书";

  const unknown = safeKeys(book).filter(key => !BOOK_FIELDS.has(key)).map((key): [string, unknown] => [key, book[key]]);
  const cleaned = sanitizeForeign(Object.fromEntries(unknown));
  const { kept, dropped } = capPreserved(isRecord(cleaned) ? cleaned : {}, L.preservedJson);
  for (const key of dropped) {
    report({ key, kind: "other", action: "truncated", summary: `book field ${clipForSummary(key)} not preserved: over ${L.preservedJson} chars` });
  }

  const budget = num(own(book, "token_budget"), 0, -Infinity, Infinity, true);
  const lorebook: PaLorebookDoc = {
    name,
    description: "",
    scanDepth: num(own(book, "scan_depth"), 4, 0, L.loreScanDepth, true),
    tokenBudget: Math.min(L.loreBudgetMax, Math.max(L.loreBudgetMin, Math.max(budget, L.loreImportBudgetFloor))),
    recursive: bool(own(book, "recursive_scanning"), true),
    caseSensitive: false,
    matchWholeWords: true,
    global: false,
    entries,
  };
  const parsed = paLorebookInputSchema.safeParse(lorebook);
  if (!parsed.success) {
    report({ key: "lorebook", kind: "other", action: "truncated", summary: `world book could not be mapped: ${parsed.error.issues[0]?.message ?? "invalid"}` });
    return null;
  }
  return {
    lorebook: parsed.data,
    meta: { origin: { format: source.format, name: source.originName ?? parsed.data.name }, preserved: kept, needsReview: capNeedsReview(items) },
  };
}

function foreignWorldFormat(value: Record<string, unknown>): string | null {
  if (Object.hasOwn(value, "lorebookVersion")) return "NovelAI lorebook";
  if (own(value, "kind") === "memory") return "Agnai memory book";
  if (own(value, "type") === "risu") return "RisuAI lorebook";
  const spec = own(value, "spec");
  if (typeof spec === "string" && spec.startsWith("chara_card")) return "character card";
  return null;
}

export function parseWorldText(text: string, options: WorldImportOptions = {}): PaWorldImportPreview {
  const raw = typeof text === "string" ? text : "";
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (body.length > L.cardTextChars) return { ok: false, error: "too-large", detail: `${body.length} chars` };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: "bad-json", detail: error instanceof Error ? error.message : "invalid JSON" };
  }
  return importWorldInfo(json, options);
}

export function importWorldInfo(json: unknown, options: WorldImportOptions = {}): PaWorldImportPreview {
  try {
    if (!isRecord(json)) return { ok: false, error: "not-object" };
    const foreign = foreignWorldFormat(json);
    if (foreign !== null) return { ok: false, error: "unsupported-format", detail: foreign };
    let book = json;
    if (own(json, "spec") === "lorebook_v3") {
      const data = own(json, "data");
      if (!isRecord(data)) return { ok: false, error: "unsupported-format", detail: "lorebook_v3 without data" };
      book = data;
    }
    const entries = own(book, "entries");
    if (!Array.isArray(entries) && !isRecord(entries)) return { ok: false, error: "unsupported-format", detail: "no entries" };
    const opts: WorldImportOptions = isRecord(options) ? options : {};
    const fileName = typeof opts.fileName === "string" ? opts.fileName : null;
    const mapped = mapBook(book, {
      format: "st-world",
      names: [opts.name, own(book, "name"), fileNameStem(fileName)],
      originName: fileName,
    }, () => {});
    if (mapped === null) return { ok: false, error: "unsupported-format", detail: "world book could not be mapped" };
    return { ok: true, name: mapped.lorebook.name, lorebook: mapped.lorebook, meta: mapped.meta };
  } catch {
    return { ok: false, error: "unsupported-format", detail: "unreadable world book" };
  }
}

/** A card's `character_book`; null when it has no usable entries. Report items go to the book meta and to `sink`. */
export function mapCharacterBook(book: unknown, cardName: string, sink: ReviewSink):
  { lorebook: PaLorebookDoc; meta: PaLorebookImportMeta } | null {
  try {
    if (!isRecord(book)) return null;
    const mapped = mapBook(book, { format: "card", names: [own(book, "name"), `${cardName} 世界书`], originName: cardName }, sink);
    return mapped !== null && mapped.lorebook.entries.length > 0 ? mapped : null;
  } catch {
    return null;
  }
}

// ---- export ------------------------------------------------------------------------------------------------------

function preservedOf(entry: PaLoreEntry): Record<string, unknown> {
  return isRecord(entry.preserved) ? entry.preserved : {};
}

/** `entry.preserved` without the bookkeeping keys, to spread underneath an exported entry. */
function preservedRest(entry: PaLoreEntry): Record<string, unknown> {
  return Object.fromEntries(Object.entries(preservedOf(entry)).filter(([key]) => !BOOKKEEPING.has(key) && !RESERVED_KEYS.has(key)));
}

/** Content with the stored decorator lines prepended (interpreted ones only while the entry still agrees with them). */
function exportContent(entry: PaLoreEntry): string {
  const stored = own(preservedOf(entry), "decorators");
  const lines = Array.isArray(stored)
    ? stored.filter((line): line is string => typeof line === "string" && DECORATOR_LINE.test(line) && decoratorHolds(line, entry))
    : [];
  return lines.length > 0 ? `${lines.join("\n")}\n${entry.content}` : entry.content;
}

/** `preserved.position` while our position still maps to it, else 0 / 1 / 4. */
function exportPosition(entry: PaLoreEntry): number {
  const original = positionNumber(own(preservedOf(entry), "position"));
  if (original !== null) {
    const read = readPosition(original);
    const holds = read.position === entry.position
      && (read.depth === undefined || read.depth === entry.depth)
      && (read.role === undefined || read.role === entry.role)
      && (read.outlet !== true || !entry.enabled);
    if (holds) return original;
  }
  return entry.position === "before_char" ? 0 : entry.position === "after_char" ? 1 : 4;
}

const roleNumber = (role: LoreRole): number => Math.max(0, ROLES.indexOf(role));
const logicNumber = (logic: LoreLogic): number => Math.max(0, PA_LORE_LOGIC.indexOf(logic));
const usesRegex = (entry: PaLoreEntry): boolean =>
  [...entry.keys, ...entry.secondaryKeys].some(key => compileLoreKey(key).kind === "regex");

/** SillyTavern world file. */
export function exportWorldInfo(book: PaLorebook): Record<string, unknown> {
  const entries = book.entries.map((entry, index): [string, Record<string, unknown>] => [String(index), {
    ...preservedRest(entry),
    uid: index,
    key: [...entry.keys],
    keysecondary: [...entry.secondaryKeys],
    comment: entry.title,
    content: exportContent(entry),
    constant: entry.constant,
    selective: entry.selective,
    selectiveLogic: logicNumber(entry.logic),
    order: entry.order,
    position: exportPosition(entry),
    disable: !entry.enabled,
    depth: entry.depth,
    role: roleNumber(entry.role),
    probability: entry.probability,
    useProbability: true,
    group: entry.groups.join(","),
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    delayUntilRecursion: entry.recursionOnly,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    ignoreBudget: entry.ignoreBudget,
  }]);
  return { entries: Object.fromEntries(entries) };
}

/** For card export: the given books merged in order into one `character_book`; null when there are no entries. */
export function exportCharacterBook(books: readonly PaLorebook[]): Record<string, unknown> | null {
  const all = books.flatMap(book => book.entries);
  const first = books[0];
  if (all.length === 0 || first === undefined) return null;
  const firstPreserved = isRecord(first.preserved) ? first.preserved : {};
  const bookExtensions = own(firstPreserved, "extensions");
  const entries = all.map((entry, index) => {
    const rest = preservedRest(entry);
    const restExtensions = own(rest, "extensions");
    return {
      ...rest,
      keys: [...entry.keys],
      secondary_keys: [...entry.secondaryKeys],
      selective: entry.selective,
      constant: entry.constant,
      enabled: entry.enabled,
      insertion_order: entry.order,
      position: entry.position === "after_char" ? "after_char" : "before_char",
      ...(entry.caseSensitive !== null ? { case_sensitive: entry.caseSensitive } : {}),
      comment: entry.title,
      name: entry.title,
      content: exportContent(entry),
      id: index + 1,
      use_regex: usesRegex(entry),
      extensions: {
        ...(isRecord(restExtensions) ? restExtensions : {}),
        position: exportPosition(entry),
        depth: entry.depth,
        role: roleNumber(entry.role),
        selectiveLogic: logicNumber(entry.logic),
        probability: entry.probability,
        useProbability: true,
        group: entry.groups.join(","),
        group_override: entry.groupOverride,
        group_weight: entry.groupWeight,
        sticky: entry.sticky,
        cooldown: entry.cooldown,
        delay: entry.delay,
        exclude_recursion: entry.excludeRecursion,
        prevent_recursion: entry.preventRecursion,
        delay_until_recursion: entry.recursionOnly,
        scan_depth: entry.scanDepth,
        case_sensitive: entry.caseSensitive,
        match_whole_words: entry.matchWholeWords,
        ignore_budget: entry.ignoreBudget,
      },
    };
  });
  return {
    ...firstPreserved,
    name: first.name,
    scan_depth: books.reduce((max, book) => Math.max(max, book.scanDepth), 0),
    token_budget: books.reduce((max, book) => Math.max(max, book.tokenBudget), 0),
    recursive_scanning: books.some(book => book.recursive),
    extensions: isRecord(bookExtensions) ? bookExtensions : {},
    entries,
  };
}
