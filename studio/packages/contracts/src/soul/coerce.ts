// SPDX-License-Identifier: Apache-2.0
// Coercion helpers used by every importer field. Each one accepts any value and never throws.
import type { PaNeedsReviewItem } from "../api/personal-agent-soul.js";

export type ReviewSink = (item: PaNeedsReviewItem) => void;

/** A string as is; number or boolean through String(v); anything else ''. CRLF and lone CR become LF; NUL is removed.
 *  Over `max`: sliced, and one item { key: field, kind: 'other', action: 'truncated', summary: `${field} truncated from ${n} to ${max}` }. */
export function str(value: unknown, max: number, field: string, sink: ReviewSink): string {
  const raw = typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value)
    : "";
  const text = raw.replace(/\r\n?/g, "\n").replace(/\0/g, "");
  if (text.length <= max) return text;
  sink({ key: field, kind: "other", action: "truncated", summary: `${field} truncated from ${text.length} to ${max}` });
  return text.slice(0, max);
}

/** An array keeps its string items; a string is split on ASCII commas. Trim, drop empty, de-duplicate case-insensitively
 *  (NFKC + lower case), clip each item to `maxLen`, keep the first `maxItems` (one 'truncated' item when anything is cut). */
export function strList(value: unknown, maxItems: number, maxLen: number, field: string, sink: ReviewSink): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const fold = trimmed.normalize("NFKC").toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    unique.push(trimmed);
  }
  let clipped = 0;
  const kept = unique.slice(0, Math.max(0, maxItems)).map(item => {
    if (item.length <= maxLen) return item;
    clipped += 1;
    return item.slice(0, maxLen);
  });
  const dropped = unique.length - kept.length;
  if (dropped > 0 || clipped > 0) {
    sink({
      key: field, kind: "other", action: "truncated",
      summary: `${field} truncated: ${dropped} of ${unique.length} items dropped, ${clipped} clipped to ${maxLen} chars`,
    });
  }
  return kept;
}

/** A finite number or a numeric string; NaN, Infinity or anything else gives `def`. Math.round when `int`; clamped. */
export function num(value: unknown, def: number, min: number, max: number, int: boolean): number {
  let n = def;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) n = Number(value);
  if (int) n = Math.round(n);
  return Math.min(max, Math.max(min, n));
}

/** boolean; 'true' / 'false' (case-insensitive); 1 / 0; anything else `def`. */
export function bool(value: unknown, def: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "true") return true;
    if (word === "false") return false;
    return def;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return def;
}

/** Plain object, not array, not null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
