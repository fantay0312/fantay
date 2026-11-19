// SPDX-License-Identifier: Apache-2.0
// Foreign data hygiene: every value kept from an imported card, world book or preset passes through here.
import { SOUL_LIMITS } from "./limits.js";

export interface SanitizeOptions { maxDepth?: number; maxNodes?: number; maxString?: number }

const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

type Frame =
  | { kind: "array"; source: readonly unknown[]; index: number; out: unknown[]; depth: number; key: string }
  | { kind: "object"; source: object; keys: string[]; index: number; out: Array<[string, unknown]>; depth: number; key: string };

function sanitizeLeaf(value: unknown, maxString: number): unknown {
  switch (typeof value) {
    case "string":
      if (value.startsWith("data:") && value.length > SOUL_LIMITS.dataUriInline) return `[data omitted, ${value.length} chars]`;
      return value.length > maxString ? value.slice(0, maxString) : value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    default:
      // null, undefined, functions, symbols and bigints.
      return null;
  }
}

function containerKind(value: object): "array" | "object" | null {
  try {
    if (Array.isArray(value)) return "array";
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null ? "object" : null;
  } catch {
    return null;
  }
}

function readSafely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Makes any JSON-like value safe to keep: no reserved keys, no non-finite numbers, bounded size. Never throws. */
export function sanitizeForeign(value: unknown, options: SanitizeOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? SOUL_LIMITS.foreignDepth;
  const maxNodes = options.maxNodes ?? SOUL_LIMITS.foreignNodes;
  const maxString = options.maxString ?? SOUL_LIMITS.foreignString;
  const stack: Frame[] = [];
  let nodes = 0;
  let result: unknown = null;

  const deliver = (output: unknown, key: string): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) result = output;
    else if (parent.kind === "array") parent.out.push(output);
    else parent.out.push([key, output]);
  };

  const visit = (input: unknown, depth: number, key: string): void => {
    nodes += 1;
    if (depth > maxDepth) return deliver(null, key);
    if (input === null || typeof input !== "object") return deliver(sanitizeLeaf(input, maxString), key);
    if (nodes > maxNodes) return deliver(null, key);
    const kind = containerKind(input);
    if (kind === "array") {
      stack.push({ kind, source: input as readonly unknown[], index: 0, out: [], depth, key });
    } else if (kind === "object") {
      const keys = readSafely(() => Object.keys(input));
      const own = Array.isArray(keys) ? (keys as string[]).filter(name => !RESERVED_KEYS.has(name)) : [];
      stack.push({ kind, source: input, keys: own, index: 0, out: [], depth, key });
    } else {
      deliver(null, key);
    }
  };

  try {
    visit(value, 0, "");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      if (frame.kind === "array") {
        const length = readSafely(() => frame.source.length);
        if (typeof length === "number" && frame.index < length) {
          const index = frame.index;
          frame.index += 1;
          visit(readSafely(() => frame.source[index]), frame.depth + 1, "");
          continue;
        }
        stack.pop();
        deliver(frame.out, frame.key);
      } else {
        const name = frame.keys[frame.index];
        if (name !== undefined) {
          frame.index += 1;
          visit(readSafely(() => (frame.source as Record<string, unknown>)[name]), frame.depth + 1, name);
          continue;
        }
        stack.pop();
        deliver(Object.fromEntries(frame.out), frame.key);
      }
    }
    return result;
  } catch {
    return null;
  }
}

/** Keeps entries of `record` in insertion order while JSON.stringify of the result stays within `maxJson` chars. */
export function capPreserved(record: Record<string, unknown>, maxJson: number): { kept: Record<string, unknown>; dropped: string[] } {
  const entries: Array<[string, unknown]> = [];
  const dropped: string[] = [];
  let size = 2; // "{}"
  for (const key of Object.keys(record)) {
    const value = record[key];
    let piece: string | undefined;
    try {
      const json = JSON.stringify(value);
      piece = json === undefined ? undefined : `${JSON.stringify(key)}:${json}`;
    } catch {
      piece = undefined;
    }
    const cost = piece === undefined ? Infinity : piece.length + (entries.length > 0 ? 1 : 0);
    if (size + cost <= maxJson) {
      entries.push([key, value]);
      size += cost;
    } else {
      dropped.push(key);
    }
  }
  return { kept: Object.fromEntries(entries), dropped };
}
