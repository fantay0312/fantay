// SPDX-License-Identifier: Apache-2.0
// World-book activation: key matching (text keys and the two-tier regex matcher), timers, gates, recursive passes,
// inclusion groups, probability and the token budget. Deterministic for a given rng.
import type {
  PaLoreEntry, PaLoreReason, PaLoreStatus, PaLorebook, PaLoreTimer, PaSoulTraceLore,
} from "../api/personal-agent-soul.js";
import { SOUL_LIMITS } from "./limits.js";
import { compileLoreKey } from "./lore-key.js";
import { estimateTokens } from "./tokens.js";

export type LoreBookLike = Pick<PaLorebook, "id" | "name" | "scanDepth" | "tokenBudget" | "recursive" | "caseSensitive" | "matchWholeWords" | "entries">;
export interface ActivateLoreInput {
  books: ReadonlyArray<{ book: LoreBookLike; rank: 0 | 1 | 2 }>;   // 0 chat, 1 character, 2 global; array order is "book order"
  disabled: ReadonlySet<string>;                                    // `${bookId}:${entryId}`
  messages: readonly string[];                                      // newest first; `Name: text` in rooms; hidden excluded
  extraScan: readonly string[];                                     // the chat note and the character note
  index: number;                                                    // slots before the reply slot
  timers: Readonly<Record<string, PaLoreTimer>>;
  names: { char: string; user: string };
  budgetOverride?: number;
  maxBudget?: number;                                               // floor(0.35 × contextTokens)
  regexTest?: (source: string, flags: string, text: string) => boolean | null;   // null: timed out
  rng: () => number;
}
export interface ActivatedEntry {
  bookId: string; entryId: string; title: string; content: string; position: PaLoreEntry["position"];
  depth: number; role: PaLoreEntry["role"]; order: number; constant: boolean; tokens: number;
}
export interface ActivateLoreResult {
  included: ActivatedEntry[];                                       // order ascending (step G)
  trace: PaSoulTraceLore[];                                         // every entry of every book exactly once
  used: number; limit: number;
  timers: Record<string, PaLoreTimer>;                              // to persist on commit only
  constantCut: boolean;                                             // a constant entry did not fit
  regexTimeouts: number;
}

/** One scanned string. The two comparison forms are computed once. */
class Unit {
  private nfkc: string | undefined;
  private lower: string | undefined;
  constructor(readonly raw: string) {}
  text(caseSensitive: boolean): string {
    if (this.nfkc === undefined) this.nfkc = this.raw.normalize("NFKC");
    if (caseSensitive) return this.nfkc;
    if (this.lower === undefined) this.lower = this.nfkc.toLowerCase();
    return this.lower;
  }
}

type Matcher =
  | { kind: "text"; raw: string; needle: string; whole: boolean; caseSensitive: boolean }
  | { kind: "regex"; raw: string; source: string; flags: string; safe: boolean; compiled: RegExp | null; cache: Map<string, boolean | null> }
  | { kind: "invalid"; raw: string };

interface Candidate {
  walk: number;
  book: LoreBookLike;
  entry: PaLoreEntry;
  key: string;
  tokens: number;
  primary: Matcher[];
  secondary: Matcher[];
  scanDepth: number;
  sticky: boolean;
  cooling: boolean;
  phase: "undecided" | "final" | "committed";
  status: PaLoreStatus;
  reason: PaLoreReason;
  sawRecursion: boolean;
  notes: { rejected: boolean; timeout: boolean; needsDaemon: boolean };
}

const WORD_CHAR = /[A-Za-z0-9_]/;
const ASCII_WORD_KEY = /^[A-Za-z0-9_]+$/;

function findWholeWord(haystack: string, needle: string): boolean {
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

export function activateLore(input: ActivateLoreInput): ActivateLoreResult {
  const { index, rng } = input;
  let regexTimeouts = 0;

  // A. Prepare: walk order is (rank, book order, entry index).
  const books = input.books.map((item, order) => ({ ...item, order }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  // Function replacements: a name is data, so `$'`, `$&` and friends in it must not expand.
  const replaceNames = (key: string) => key
    .replace(/\{\{\s*char\s*\}\}/gi, () => input.names.char)
    .replace(/\{\{\s*user\s*\}\}/gi, () => input.names.user)
    .trim()
    .slice(0, SOUL_LIMITS.loreKey);
  const compile = (keys: readonly string[], caseSensitive: boolean, whole: boolean): Matcher[] => {
    const out: Matcher[] = [];
    for (const key of keys) {
      const compiled = compileLoreKey(key);
      if (compiled.kind === "empty") continue;
      if (compiled.kind === "invalid") {
        out.push({ kind: "invalid", raw: key.trim() });
      } else if (compiled.kind === "regex") {
        let regex: RegExp | null = null;
        if (compiled.safe) {
          try {
            regex = new RegExp(compiled.source, compiled.flags);
          } catch {
            regex = null;
          }
        }
        out.push({ kind: "regex", raw: key.trim(), source: compiled.source, flags: compiled.flags, safe: compiled.safe && regex !== null, compiled: regex, cache: new Map() });
      } else {
        const needle = replaceNames(compiled.needle);
        if (!needle) continue;
        const normalized = caseSensitive ? needle.normalize("NFKC") : needle.normalize("NFKC").toLowerCase();
        out.push({ kind: "text", raw: needle, needle: normalized, whole: whole && ASCII_WORD_KEY.test(normalized), caseSensitive });
      }
    }
    return out;
  };

  const candidates: Candidate[] = [];
  const entryKeys = new Set<string>();
  for (const { book } of books) {
    for (const entry of book.entries) {
      const key = `${book.id}:${entry.id}`;
      entryKeys.add(key);
      const caseSensitive = entry.caseSensitive ?? book.caseSensitive;
      const whole = entry.matchWholeWords ?? book.matchWholeWords;
      candidates.push({
        walk: candidates.length, book, entry, key, tokens: estimateTokens(entry.content),
        primary: compile(entry.keys, caseSensitive, whole),
        secondary: compile(entry.secondaryKeys, caseSensitive, whole),
        scanDepth: Math.max(0, entry.scanDepth ?? book.scanDepth),
        sticky: false, cooling: false, phase: "undecided",
        status: "inactive", reason: { code: "no-key" }, sawRecursion: false,
        notes: { rejected: false, timeout: false, needsDaemon: false },
      });
    }
  }

  // B. Timers.
  const timers = new Map<string, PaLoreTimer>();
  for (const [key, record] of Object.entries(input.timers)) {
    if (!entryKeys.has(key) || typeof record !== "object" || record === null) continue;
    const { at, stickyEnd, cooldownEnd } = record;
    if (![at, stickyEnd, cooldownEnd].every(value => typeof value === "number" && Number.isFinite(value))) continue;
    if (at >= index || index >= cooldownEnd) continue;
    timers.set(key, { at, stickyEnd, cooldownEnd });
  }
  for (const candidate of candidates) {
    const record = timers.get(candidate.key);
    if (!record) continue;
    candidate.sticky = index < record.stickyEnd;
    candidate.cooling = !candidate.sticky && index < record.cooldownEnd;
  }

  // C. Gate, first hit wins, constant entries included.
  const finish = (candidate: Candidate, status: PaLoreStatus, reason: PaLoreReason) => {
    candidate.phase = "final";
    candidate.status = status;
    candidate.reason = reason;
  };
  for (const candidate of candidates) {
    const { entry } = candidate;
    if (!entry.enabled || input.disabled.has(candidate.key)) finish(candidate, "disabled", { code: "disabled" });
    else if (!entry.content.trim()) finish(candidate, "inactive", { code: "empty" });
    else if (index < entry.delay) finish(candidate, "inactive", { code: "delay" });
    else if (candidate.cooling) finish(candidate, "cooldown", { code: "cooldown" });
  }

  // Matching.
  const messageUnits = input.messages.map(text => new Unit(text));
  const extraUnits = input.extraScan.filter(text => text.trim() !== "").map(text => new Unit(text));
  const recursionUnits: Unit[] = [];
  let recursionChars = 0;
  const regexHit = (matcher: Extract<Matcher, { kind: "regex" }>, unit: Unit, candidate: Candidate): boolean => {
    const text = unit.raw.slice(0, SOUL_LIMITS.loreRegexInput);
    if (matcher.safe && matcher.compiled) return matcher.compiled.test(text);
    if (!input.regexTest) {
      candidate.notes.needsDaemon = true;
      return false;
    }
    let result = matcher.cache.get(text);
    if (result === undefined) {
      try {
        result = input.regexTest(matcher.source, matcher.flags, text);
      } catch {
        result = null;
      }
      if (result === null) regexTimeouts += 1;
      matcher.cache.set(text, result);
    }
    if (result === null) candidate.notes.timeout = true;
    return result === true;
  };
  const hits = (matcher: Matcher, units: readonly Unit[], candidate: Candidate): boolean => {
    if (matcher.kind === "invalid") {
      candidate.notes.rejected = true;
      return false;
    }
    for (const unit of units) {
      if (matcher.kind === "regex") {
        if (regexHit(matcher, unit, candidate)) return true;
        continue;
      }
      const haystack = unit.text(matcher.caseSensitive);
      if (matcher.whole ? findWholeWord(haystack, matcher.needle) : haystack.includes(matcher.needle)) return true;
    }
    return false;
  };
  const activation = (candidate: Candidate, pass: number): PaLoreReason | null => {
    const { entry, book } = candidate;
    if (entry.recursionOnly && pass === 0) return null;
    if (pass > 0) candidate.sawRecursion = true;
    if (candidate.sticky) return { code: "sticky" };
    if (entry.constant) return { code: "constant" };
    const units = candidate.scanDepth > 0 ? [...messageUnits.slice(0, candidate.scanDepth), ...extraUnits] : [];
    if (pass > 0 && book.recursive && !entry.excludeRecursion) units.push(...recursionUnits);
    if (units.length === 0) return null;
    const primary = candidate.primary.find(matcher => hits(matcher, units, candidate));
    if (!primary) return null;
    if (entry.selective && candidate.secondary.length > 0) {
      const results = candidate.secondary.map(matcher => hits(matcher, units, candidate));
      const holds = entry.logic === "and_any" ? results.some(Boolean)
        : entry.logic === "and_all" ? results.every(Boolean)
        : entry.logic === "not_any" ? !results.some(Boolean)
        : !results.every(Boolean);
      if (!holds) return null;
    }
    return { code: "key", key: primary.raw };
  };

  // D. Passes; E. groups, probability and commit inside each pass.
  const keptGroups = new Set<string>();
  for (let pass = 0; pass < SOUL_LIMITS.lorePasses; pass += 1) {
    const fresh: Array<{ candidate: Candidate; reason: PaLoreReason }> = [];
    for (const candidate of candidates) {
      if (candidate.phase !== "undecided") continue;
      const reason = activation(candidate, pass);
      if (reason) fresh.push({ candidate, reason });
    }
    if (fresh.length === 0) break;
    const alive = new Set(fresh.map(item => item.candidate));
    const groupNames = [...new Set(fresh.flatMap(item => item.candidate.entry.groups))].sort();
    for (const group of groupNames) {
      const members = fresh.map(item => item.candidate).filter(candidate => alive.has(candidate) && candidate.entry.groups.includes(group));
      if (members.length === 0) continue;
      let winners: Candidate[];
      if (keptGroups.has(group)) winners = [];
      else if (members.length === 1) winners = members;
      else {
        const sticky = members.filter(candidate => candidate.sticky);
        const override = members.filter(candidate => candidate.entry.groupOverride);
        if (sticky.length > 0) winners = sticky;
        else if (override.length > 0) {
          winners = [override.reduce((best, candidate) => (candidate.entry.order > best.entry.order ? candidate : best))];
        } else {
          const weights = members.map(candidate => Math.max(1, candidate.entry.groupWeight));
          let point = rng() * weights.reduce((sum, weight) => sum + weight, 0);
          let picked = members[members.length - 1] as Candidate;
          for (let at = 0; at < members.length; at += 1) {
            point -= weights[at] ?? 0;
            if (point < 0) {
              picked = members[at] as Candidate;
              break;
            }
          }
          winners = [picked];
        }
      }
      for (const member of members) {
        if (winners.includes(member)) continue;
        alive.delete(member);
        finish(member, "group", { code: "group" });
      }
    }
    for (const { candidate } of fresh) {
      if (!alive.has(candidate) || candidate.entry.probability >= 100 || candidate.sticky) continue;
      if (rng() * 100 < candidate.entry.probability) continue;
      alive.delete(candidate);
      finish(candidate, "probability", { code: "probability" });
    }
    const committed = fresh.filter(item => alive.has(item.candidate));
    if (committed.length === 0) break;
    for (const { candidate, reason } of committed) {
      candidate.phase = "committed";
      candidate.status = "included";
      candidate.reason = reason;
      for (const group of candidate.entry.groups) keptGroups.add(group);
      if (candidate.entry.preventRecursion || recursionChars >= SOUL_LIMITS.loreRecursionBuffer) continue;
      const piece = candidate.entry.content.slice(0, SOUL_LIMITS.loreRecursionBuffer - recursionChars);
      recursionUnits.push(new Unit(piece));
      recursionChars += piece.length;
    }
  }

  // F. Budget, once over every committed entry.
  const committed = candidates.filter(candidate => candidate.phase === "committed");
  const budgetBooks = committed.length > 0 ? committed.map(candidate => candidate.book) : books.map(item => item.book);
  let limit = input.budgetOverride ?? budgetBooks.reduce((max, book) => Math.max(max, book.tokenBudget), 0);
  if (input.maxBudget !== undefined) limit = Math.min(limit, input.maxBudget);
  limit = Math.max(0, limit);
  const ranked = [...committed].sort((a, b) =>
    Number(b.sticky) - Number(a.sticky)
    || Number(b.entry.constant) - Number(a.entry.constant)
    || b.entry.order - a.entry.order
    || a.walk - b.walk);
  let used = 0;
  let constantCut = false;
  const included: Candidate[] = [];
  for (const candidate of ranked) {
    if (candidate.entry.ignoreBudget) {
      included.push(candidate);
      continue;
    }
    if (used + candidate.tokens <= limit) {
      used += candidate.tokens;
      included.push(candidate);
      continue;
    }
    finish(candidate, "budget", { code: "over-budget", need: candidate.tokens, left: limit - used });
    if (candidate.entry.constant) constantCut = true;
  }

  // Never-activated entries: the most specific explanation.
  for (const candidate of candidates) {
    if (candidate.phase !== "undecided") continue;
    const { notes } = candidate;
    const code: PaLoreReason["code"] = notes.timeout ? "regex-timeout"
      : notes.needsDaemon ? "regex-needs-daemon"
      : notes.rejected ? "regex-rejected"
      : candidate.entry.recursionOnly && !candidate.sawRecursion ? "recursion-only"
      : "no-key";
    finish(candidate, "inactive", { code });
  }

  // G. Output, order ascending, ties in walk order.
  included.sort((a, b) => a.entry.order - b.entry.order || a.walk - b.walk);

  // H. Timers out.
  const timersOut = new Map(timers);
  for (const candidate of included) {
    const { sticky, cooldown } = candidate.entry;
    if ((sticky > 0 || cooldown > 0) && !timers.has(candidate.key)) {
      timersOut.set(candidate.key, { at: index, stickyEnd: index + sticky, cooldownEnd: index + sticky + cooldown });
    }
  }

  return {
    included: included.map(({ book, entry, tokens }) => ({
      bookId: book.id, entryId: entry.id, title: entry.title, content: entry.content, position: entry.position,
      depth: entry.depth, role: entry.role, order: entry.order, constant: entry.constant, tokens,
    })),
    trace: candidates.map(({ book, entry, tokens, status, reason }) => ({
      lorebookId: book.id, lorebookName: book.name, entryId: entry.id, title: entry.title, tokens,
      status, reason, position: entry.position, constant: entry.constant,
    })),
    used,
    limit,
    timers: Object.fromEntries(timersOut),
    constantCut,
    regexTimeouts,
  };
}
