// SPDX-License-Identifier: Apache-2.0
// Two-tier world-book key compiler: plain text keys, and `/regex/flags` literals split into a bounded safe subset
// (run inline) and everything else (run only through the daemon's time-limited tester).
import { SOUL_LIMITS } from "./limits.js";

export type LoreKey =
  | { kind: "empty" }
  | { kind: "text"; needle: string }
  | { kind: "regex"; source: string; flags: string; safe: boolean }
  | { kind: "invalid" };

const KEPT_FLAGS = "imsu";
const DROPPED_FLAGS = "gyd";
const MAX_OPTIONAL_QUANTIFIERS = 8;
/** Upper bound on backtracking paths per start position: 8 `?` give 2^8, and alternations count the same way. */
const MAX_BRANCH_PATHS = 2 ** MAX_OPTIONAL_QUANTIFIERS;

/** Index of the last `/` after position 0 that is preceded by an even number of backslashes; -1 when none. */
function lastUnescapedSlash(text: string): number {
  for (let index = text.length - 1; index > 0; index -= 1) {
    if (text[index] !== "/") continue;
    let backslashes = 0;
    for (let probe = index - 1; probe >= 0 && text[probe] === "\\"; probe -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

/**
 * The bounded subset: outside escapes and character classes no `*`, `+` or `{`, no backreference, at most 8 `?`
 * quantifiers. Alternation backtracks like `?` does (`(a|aa)(a|aa)…b` is exponential with no quantifier at all), so the
 * product of every choice point's fan-out (`?` counts 2, a group or the top level counts its alternatives) must stay
 * within 2^8. Without alternation this is exactly the `?` cap.
 */
function isSafeSource(source: string): boolean {
  let optional = 0;
  let paths = 1;
  const alternatives: number[] = [1];   // per open group; index 0 is the top level
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (!inClass && next !== undefined && ((next >= "1" && next <= "9") || (next === "k" && source[index + 2] === "<"))) {
        return false;
      }
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "*" || char === "+" || char === "{") return false;
    else if (char === "?" && source[index - 1] !== "(") {
      optional += 1;
      if (optional > MAX_OPTIONAL_QUANTIFIERS) return false;
      paths *= 2;
    } else if (char === "(") alternatives.push(1);
    else if (char === "|") alternatives[alternatives.length - 1] = (alternatives[alternatives.length - 1] ?? 1) + 1;
    else if (char === ")" && alternatives.length > 1) paths *= alternatives.pop() ?? 1;
    if (paths > MAX_BRANCH_PATHS) return false;
  }
  for (const count of alternatives) paths *= count;
  return paths <= MAX_BRANCH_PATHS;
}

export function compileLoreKey(key: string): LoreKey {
  const trimmed = key.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("/")) {
    const slash = lastUnescapedSlash(trimmed);
    const source = slash > 0 ? trimmed.slice(1, slash) : "";
    const rawFlags = slash > 0 ? trimmed.slice(slash + 1) : "";
    if (source && /^[a-z]*$/.test(rawFlags)) {
      let flags = "";
      for (const flag of rawFlags) {
        if (KEPT_FLAGS.includes(flag)) {
          if (!flags.includes(flag)) flags += flag;
        } else if (!DROPPED_FLAGS.includes(flag)) {
          return { kind: "invalid" };
        }
      }
      if (source.length > SOUL_LIMITS.loreRegexSource) return { kind: "invalid" };
      try {
        new RegExp(source, flags);
      } catch {
        return { kind: "invalid" };
      }
      return { kind: "regex", source, flags, safe: isSafeSource(source) };
    }
  }
  return { kind: "text", needle: trimmed };
}

/** Splits a key string the way world files write it: one `/regex/flags` literal stays whole, otherwise ASCII commas. */
export function splitKeyList(value: unknown): string[] {
  let raw: string[];
  if (Array.isArray(value)) raw = value.filter((item): item is string => typeof item === "string");
  else if (typeof value === "string") {
    const kind = compileLoreKey(value).kind;
    raw = kind === "regex" || kind === "invalid" ? [value] : value.split(",");
  } else raw = [];
  const keys: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    keys.push(trimmed.slice(0, SOUL_LIMITS.loreKey));
    if (keys.length >= SOUL_LIMITS.loreKeys) break;
  }
  return keys;
}
