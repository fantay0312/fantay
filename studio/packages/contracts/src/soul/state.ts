// SPDX-License-Identifier: Apache-2.0
// Story state: schema semantics of one op, the per-slot fold with anchored user edits, and what an op really changed.
// State lives in a Map, never in a plain object keyed by card-supplied names.
import type { PaStateField, PaStateOp, PaStateValue, PaUserStateOp } from "../api/personal-agent-soul.js";
import { SOUL_LIMITS } from "./limits.js";
import { type SoulMessage, visibleSlots } from "./rules.js";

export type StateMap = Map<string, PaStateValue>;

/** Rounds to 4 decimals; -0 becomes 0. */
function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** A state number as the prompt, the footer and the macros print it: at most 4 decimals, no trailing zeros. */
export function formatStateNumber(value: number): string {
  return String(round4(value));
}

/** The comparison form of a list item or enum option: NFKC, trimmed, case-folded. */
function foldItem(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase();
}

function clampNumber(field: Extract<PaStateField, { kind: "number" }>, value: number): number {
  let next = value;
  if (field.min !== undefined && next < field.min) next = field.min;
  if (field.max !== undefined && next > field.max) next = field.max;
  return round4(next);
}

function findField(schema: readonly PaStateField[], key: string): PaStateField | undefined {
  const folded = key.toLowerCase();
  return schema.find(field => field.key.toLowerCase() === folded);
}

function asNumber(value: PaStateOp["value"]): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[-+]?\d+(?:\.\d+)?\s*$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanItem(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const item = value.trim().slice(0, SOUL_LIMITS.stateListItem);
  return item ? item : null;
}

function uniqueItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = cleanItem(raw);
    if (item === null) continue;
    const folded = foldItem(item);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(item);
    if (out.length >= SOUL_LIMITS.stateListItems) break;
  }
  return out;
}

export function initialState(schema: readonly PaStateField[]): StateMap {
  const state: StateMap = new Map();
  for (const field of schema) {
    if (field.kind === "number") state.set(field.key, clampNumber(field, field.initial));
    else if (field.kind === "list") state.set(field.key, uniqueItems(field.initial));
    else state.set(field.key, field.initial.slice(0, field.kind === "text" ? SOUL_LIMITS.stateText : SOUL_LIMITS.stateOption));
  }
  return state;
}

function currentNumber(field: Extract<PaStateField, { kind: "number" }>, state: StateMap): number {
  const value = state.get(field.key);
  return typeof value === "number" && Number.isFinite(value) ? value : clampNumber(field, field.initial);
}

function currentList(field: Extract<PaStateField, { kind: "list" }>, state: StateMap): string[] {
  const value = state.get(field.key);
  return Array.isArray(value) ? [...value] : uniqueItems(field.initial);
}

/** Applies one op; returns false and changes nothing when the op is invalid for the current schema. Never throws. */
export function applyOp(schema: readonly PaStateField[], state: StateMap, op: PaStateOp, source: "model" | "user"): boolean {
  if (typeof op !== "object" || op === null || typeof op.key !== "string") return false;
  const field = findField(schema, op.key);
  if (!field) return false;
  if (source === "model" && field.writable === "user") return false;
  switch (field.kind) {
    case "number": {
      const value = asNumber(op.value);
      if (value === null) return false;
      if (op.op === "set") {
        state.set(field.key, clampNumber(field, value));
        return true;
      }
      if (op.op !== "delta") return false;
      let step = value;
      if (source === "model" && field.maxStep !== undefined) step = Math.max(-field.maxStep, Math.min(field.maxStep, step));
      state.set(field.key, clampNumber(field, currentNumber(field, state) + step));
      return true;
    }
    case "text": {
      if (op.op !== "set" || typeof op.value !== "string") return false;
      state.set(field.key, op.value.slice(0, SOUL_LIMITS.stateText));
      return true;
    }
    case "enum": {
      if (op.op !== "set" || typeof op.value !== "string") return false;
      const wanted = foldItem(op.value);
      const option = field.options.find(candidate => foldItem(candidate) === wanted);
      if (option === undefined) return false;
      state.set(field.key, option);
      return true;
    }
    case "list": {
      if (op.op === "set") {
        if (source !== "user" || !Array.isArray(op.value)) return false;
        state.set(field.key, uniqueItems(op.value));
        return true;
      }
      if (op.op !== "add" && op.op !== "remove") return false;
      const items = Array.isArray(op.value) ? op.value.map(cleanItem) : [cleanItem(op.value)];
      if (items.length === 0 || items.some(item => item === null)) return false;
      const list = currentList(field, state);
      for (const item of items) {
        if (item === null) continue;
        const folded = foldItem(item);
        const at = list.findIndex(existing => foldItem(existing) === folded);
        if (op.op === "add") {
          if (at < 0 && list.length < SOUL_LIMITS.stateListItems) list.push(item);
        } else if (at >= 0) {
          list.splice(at, 1);
        }
      }
      state.set(field.key, list);
      return true;
    }
  }
}

export interface StateSlot { slotId: string; ops: readonly PaStateOp[] }

/** Slots of one conversation from its messages: visibleSlots order, ops of the SELECTED variant (hidden slots included). */
export function chatStateSlots(messages: readonly SoulMessage[]): StateSlot[] {
  return visibleSlots(messages).map(slot => ({ slotId: slot.slotId, ops: slot.selected.soul?.stateOps ?? [] }));
}

export function foldChatState(schema: readonly PaStateField[], slots: readonly StateSlot[],
  userOps: readonly PaUserStateOp[], options?: { upTo?: string }): StateMap {
  const state = initialState(schema);
  const slotIds = new Set(slots.map(slot => slot.slotId));
  const anchored = new Map<string, PaUserStateOp[]>();
  const leading: PaUserStateOp[] = [];
  const orphans: PaUserStateOp[] = [];
  for (const op of userOps) {
    if (op.after === null) leading.push(op);
    else if (slotIds.has(op.after)) {
      const list = anchored.get(op.after);
      if (list) list.push(op);
      else anchored.set(op.after, [op]);
    } else orphans.push(op);
  }
  for (const op of leading) applyOp(schema, state, op, "user");
  const upTo = options?.upTo;
  for (const slot of slots) {
    if (upTo !== undefined && slot.slotId === upTo) break;
    for (const op of slot.ops) applyOp(schema, state, op, "model");
    for (const op of anchored.get(slot.slotId) ?? []) applyOp(schema, state, op, "user");
  }
  if (upTo === undefined) for (const op of orphans) applyOp(schema, state, op, "user");
  return state;
}

/** Object.fromEntries(state); lists are copied. */
export function stateRecord(state: StateMap): Record<string, PaStateValue> {
  return Object.fromEntries([...state].map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
}

export interface StateEffect {
  key: string; label: string; kind: PaStateField["kind"];
  delta?: number; value?: PaStateValue; added?: string[]; removed?: string[];
}

/** What `ops` really change when applied to `before` (after clamps); used for the delta line under a reply. */
export function opEffects(schema: readonly PaStateField[], before: StateMap, ops: readonly PaStateOp[],
  source: "model" | "user"): StateEffect[] {
  const after: StateMap = new Map([...before].map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
  const touched: PaStateField[] = [];
  for (const op of ops) {
    if (!applyOp(schema, after, op, source)) continue;
    const field = findField(schema, op.key);
    if (field && !touched.includes(field)) touched.push(field);
  }
  const effects: StateEffect[] = [];
  for (const field of touched) {
    const base = { key: field.key, label: field.label, kind: field.kind };
    const was = before.get(field.key);
    const now = after.get(field.key);
    if (field.kind === "number") {
      const start = typeof was === "number" ? was : clampNumber(field, field.initial);
      const end = typeof now === "number" ? now : start;
      const delta = round4(end - start);
      if (delta !== 0) effects.push({ ...base, delta, value: end });
    } else if (field.kind === "list") {
      const startList = Array.isArray(was) ? was : uniqueItems(field.initial);
      const endList = Array.isArray(now) ? now : startList;
      const startKeys = new Set(startList.map(foldItem));
      const endKeys = new Set(endList.map(foldItem));
      const added = endList.filter(item => !startKeys.has(foldItem(item)));
      const removed = startList.filter(item => !endKeys.has(foldItem(item)));
      if (added.length > 0 || removed.length > 0) effects.push({ ...base, added, removed, value: [...endList] });
    } else if (now !== undefined && now !== was) {
      effects.push({ ...base, value: now });
    }
  }
  return effects;
}

/** Re-anchors user ops when a slot disappears or changes id. */
export function reanchorUserOps(ops: readonly PaUserStateOp[],
  change: { removed: string; previous: string | null } | { renamed: string; to: string }): PaUserStateOp[] {
  if ("removed" in change) return ops.map(op => (op.after === change.removed ? { ...op, after: change.previous } : { ...op }));
  return ops.map(op => (op.after === change.renamed ? { ...op, after: change.to } : { ...op }));
}
