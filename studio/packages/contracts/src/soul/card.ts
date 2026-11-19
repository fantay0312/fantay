// SPDX-License-Identifier: Apache-2.0
// Character card import (V1, V2 and V3 JSON) and V3 export. A card is data: nothing in it is executed or fetched;
// script-like extensions and remote assets are quarantined, unknown fields are preserved for the round trip.
import type { z } from "zod";
import { paCharacterInputSchema } from "../api/personal-agent-soul.js";
import type {
  PaCardEmbeddedAsset,
  PaCardImportPreview,
  PaCharacter,
  PaCharacterDoc,
  PaEmotion,
  PaLorebook,
  PaNeedsReviewItem,
  PaPreserved,
} from "../api/personal-agent-soul.js";
import { isRecord, num, str, strList } from "./coerce.js";
import type { ReviewSink } from "./coerce.js";
import { emotionFromAssetName } from "./emotion.js";
import { SOUL_LIMITS as L } from "./limits.js";
import { capPreserved, sanitizeForeign } from "./sanitize.js";
import { capNeedsReview, coerceRole, exportCharacterBook, fileNameStem, mapCharacterBook } from "./world.js";
import { safeZipName } from "./zip.js";

export interface CardImportOptions { fileName?: string; now: number }

type CardFormat = "ccv1" | "ccv2" | "ccv3";
type PortraitMime = "image/png" | "image/jpeg" | "image/webp";
type PreservedBucket = keyof PaPreserved;
interface CardView {
  format: CardFormat;
  root: Record<string, unknown>;
  data: Record<string, unknown>;        // V1: the root (a mapped copy for the char_name spelling)
  rootFields: ReadonlySet<string>;      // root keys that are read or never preserved
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const BUILTIN_PRESET = /^builtin:[a-z0-9-]{1,40}$/;
/** `data` keys that fall back to the top-level V1 mirror when empty. */
const MIRRORED: ReadonlySet<string> = new Set(["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"]);
const V1_MIRRORS = [
  "name", "description", "personality", "scenario", "first_mes", "mes_example", "creatorcomment", "tags", "talkativeness",
] as const;
const DATA_FIELDS = [
  "name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt",
  "post_history_instructions", "alternate_greetings", "character_book", "tags", "creator", "character_version",
  "extensions", "nickname", "assets",
] as const;
const CHAR_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["char_name", "name"], ["char_persona", "description"], ["world_scenario", "scenario"],
  ["char_greeting", "first_mes"], ["example_dialogue", "mes_example"],
];
const V2_ROOT_FIELDS: ReadonlySet<string> = new Set(["spec", "spec_version", "data", ...V1_MIRRORS]);
const V1_ROOT_FIELDS: ReadonlySet<string> = new Set([...V2_ROOT_FIELDS, ...DATA_FIELDS]);
const V1_CHAR_ROOT_FIELDS: ReadonlySet<string> = new Set([...V1_ROOT_FIELDS, ...CHAR_FIELDS.map(([from]) => from)]);
const DATA_FIELD_SET: ReadonlySet<string> = new Set(DATA_FIELDS);

const CONSUMED_EXTENSIONS: ReadonlySet<string> = new Set(["depth_prompt", "talkativeness", "fantay"]);
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(["regex_scripts", "tavern_helper", "TavernHelper_scripts", "quick_reply"]);
const SCRIPT_EXTENSION_KEY = /script|quick_?reply|custom_?js|iframe/i;
/** Ordinary words that contain "script" (description, transcript, subscription, prescription, manuscript). */
const NOT_SCRIPT_KEY = /descri|transcri|subscri|prescri|manuscript/i;
/** Root keys only a card body carries; an object with `entries` and none of them is a world book. */
const CARD_BODY_KEYS: readonly string[] = [
  "data", "description", "personality", "scenario", "first_mes", "mes_example", ...CHAR_FIELDS.map(([from]) => from),
];
const RISU_QUARANTINE: ReadonlySet<string> = new Set([
  "customScripts", "triggerscript", "virtualscript", "backgroundHTML", "lowLevelAccess", "additionalAssets",
]);
const HTML_TAG = /<\s*(img|style|script|iframe|div|span|table|font|center|details|audio|video)\b/i;
const PORTRAIT_URI = /^data:(image\/(?:png|jpeg|webp));base64,/i;
/** A file inside the card's own archive; the specification spells it `embeded://`. */
const EMBEDDED_URI = /^embed{1,2}ed:\/\/(.+)$/i;
const ASSET_LABEL_CHARS = 60;

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const present = (value: unknown): boolean => value !== undefined && value !== null;
const safeKeys = (record: Record<string, unknown>): string[] => Object.keys(record).filter(key => !RESERVED_KEYS.has(key));
const isEmptyValue = (value: unknown): boolean =>
  !present(value) || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);

// ---- detection ---------------------------------------------------------------------------------------------------

const isScriptExtension = (key: string): boolean =>
  SCRIPT_EXTENSIONS.has(key) || (SCRIPT_EXTENSION_KEY.test(key) && !NOT_SCRIPT_KEY.test(key));

/** A SillyTavern world file (`entries` as a map or a list, no card body) or a lorebook_v3 file: not a card. Callers
 *  route it to `importWorldInfo` instead of reading it as an empty V1 card. */
function isWorldShaped(json: Record<string, unknown>): boolean {
  if (own(json, "spec") === "lorebook_v3") return true;
  const entries = own(json, "entries");
  return (Array.isArray(entries) || isRecord(entries)) && !CARD_BODY_KEYS.some(key => Object.hasOwn(json, key));
}

function readCard(json: unknown):
  CardView | { error: "not-object" | "no-name" } | { error: "unsupported-format"; detail: string } {
  if (!isRecord(json)) return { error: "not-object" };
  if (isWorldShaped(json)) return { error: "unsupported-format", detail: "world book" };
  const spec = own(json, "spec");
  const data = own(json, "data");
  if ((spec === "chara_card_v3" || spec === "chara_card_v2") && isRecord(data)) {
    return { format: spec === "chara_card_v3" ? "ccv3" : "ccv2", root: json, data, rootFields: V2_ROOT_FIELDS };
  }
  if (typeof own(json, "name") === "string") return { format: "ccv1", root: json, data: json, rootFields: V1_ROOT_FIELDS };
  if (typeof own(json, "char_name") === "string") {
    const mapped = CHAR_FIELDS
      .filter(([from, to]) => present(own(json, from)) && isEmptyValue(own(json, to)))
      .map(([from, to]): [string, unknown] => [to, own(json, from)]);
    const entries = safeKeys(json).map((key): [string, unknown] => [key, json[key]]);
    return { format: "ccv1", root: json, data: Object.fromEntries([...entries, ...mapped]), rootFields: V1_CHAR_ROOT_FIELDS };
  }
  return { error: "no-name" };
}

/** `data.x`, falling back to the top-level mirror when `data.x` is empty. */
function readField(view: CardView, key: string): unknown {
  const value = own(view.data, key);
  if (view.format === "ccv1" || !MIRRORED.has(key) || !isEmptyValue(value)) return value;
  const mirror = own(view.root, key);
  return isEmptyValue(mirror) ? value : mirror;
}

// ---- field helpers -----------------------------------------------------------------------------------------------

/** One `extensions.fantay` part through its own schema; the schema default when absent, null or invalid. */
function fantayPart<S extends z.ZodTypeAny>(schema: S, value: unknown, field: string, sink: ReviewSink): z.output<S> {
  if (present(value)) {
    const parsed = schema.safeParse(sanitizeForeign(value));
    if (parsed.success) return parsed.data;
    sink({ key: field, kind: "other", action: "truncated", summary: `${field} is not valid and was dropped` });
  }
  return schema.parse(undefined);
}

/** A markdown image whose target starts with http: or https: (one linear pass; no backtracking regex). */
function hasRemoteImage(text: string): boolean {
  let open = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "]") {
      if (open && (text.startsWith("(http:", index + 1) || text.startsWith("(https:", index + 1))) return true;
      open = false;
    } else if (char === "!" && text[index + 1] === "[") {
      open = true;
      index += 1;
    }
  }
  return false;
}

function reviewMarkup(field: string, texts: readonly string[], sink: ReviewSink): void {
  if (texts.some(text => HTML_TAG.test(text))) {
    sink({ key: field, kind: "html", action: "kept", summary: `${field} contains HTML; it is kept and shown as text` });
  }
  if (texts.some(hasRemoteImage)) {
    sink({ key: field, kind: "html", action: "kept", summary: `${field} links remote images; they are never loaded` });
  }
  if (texts.some(text => text.includes("<%"))) {
    sink({ key: field, kind: "script", action: "kept", summary: `${field} contains template code; it is kept as text and never run` });
  }
}

function alternateGreetings(value: unknown, sink: ReviewSink): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") out.push(str(item, L.firstMessage, `alternateGreetings.${index}`, sink));
  });
  return out;
}

function capGreetings(greetings: string[], sink: ReviewSink): string[] {
  let list = greetings;
  if (list.length > L.alternateGreetings) {
    sink({
      key: "alternateGreetings", kind: "other", action: "truncated",
      summary: `alternateGreetings truncated from ${list.length} to ${L.alternateGreetings} items`,
    });
    list = list.slice(0, L.alternateGreetings);
  }
  let total = list.reduce((sum, text) => sum + text.length, 0);
  let cut = 0;
  while (total > L.alternateGreetingsTotal && list.length > 0) {
    total -= list[list.length - 1]?.length ?? 0;
    list = list.slice(0, -1);
    cut += 1;
  }
  if (cut > 0) {
    sink({
      key: "alternateGreetings", kind: "other", action: "truncated",
      summary: `${cut} alternate greetings dropped from the end: they are limited to ${L.alternateGreetingsTotal} chars in total`,
    });
  }
  return list;
}

function suggestedPortrait(assets: unknown): { mime: PortraitMime; data: string } | null {
  if (!Array.isArray(assets)) return null;
  const maxChars = Math.ceil((L.assetBytes * 4) / 3) + 4;
  for (const asset of assets) {
    if (!isRecord(asset) || own(asset, "type") !== "icon" || own(asset, "name") !== "main") continue;
    const uri = own(asset, "uri");
    if (typeof uri !== "string") continue;
    const match = PORTRAIT_URI.exec(uri);
    if (!match) continue;
    const rest = uri.slice(match[0].length);
    if (rest.length > maxChars * 2) continue;
    const payload = rest.replace(/\s+/g, "");
    if (payload.length === 0 || payload.length > maxChars || payload.length % 4 === 1) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) continue;
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const size = Math.floor((payload.length * 3) / 4) - padding;
    if (size <= 0 || size > L.assetBytes) continue;
    const mime = (match[1] ?? "").toLowerCase();
    if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp") return { mime, data: payload };
  }
  return null;
}

/** Whether an asset `uri` names a file inside the card's own archive (`embeded://path`). */
export function isEmbeddedAssetUri(uri: unknown): boolean {
  return typeof uri === "string" && EMBEDDED_URI.test(uri);
}

/** Every safe archive path the card names in `data.assets` (`embeded://path`), planned for import or not. */
export function cardEmbeddedPaths(json: unknown): Set<string> {
  const paths = new Set<string>();
  const view = readCard(json);
  if ("error" in view) return paths;
  const assets = own(view.data, "assets");
  if (!Array.isArray(assets)) return paths;
  for (const asset of assets) {
    const uri = isRecord(asset) ? own(asset, "uri") : undefined;
    const match = typeof uri === "string" ? EMBEDDED_URI.exec(uri) : null;
    const path = match ? safeZipName((match[1] ?? "").replace(/^\/+/, "")) : null;
    if (path !== null && !path.endsWith("/")) paths.add(path);
  }
  return paths;
}

/**
 * The archive images a card plans to import (`embeded://path`): the portrait (an `icon`, `main` first; only when the
 * card has no inline portrait) and one `emotion` image per mood. Every other embedded asset is a review item.
 */
function planEmbedded(assets: readonly unknown[], hasPortrait: boolean, sink: ReviewSink): PaCardEmbeddedAsset[] {
  interface Candidate { index: number; path: string; name: string; type: string; label: string }
  const candidates: Candidate[] = [];
  assets.forEach((asset, index) => {
    if (!isRecord(asset)) return;
    const uri = own(asset, "uri");
    const match = typeof uri === "string" ? EMBEDDED_URI.exec(uri) : null;
    if (!match) return;
    const rawName = own(asset, "name");
    const name = typeof rawName === "string" ? rawName : "";
    const rawType = own(asset, "type");
    const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
    const label = (name || String(index)).slice(0, ASSET_LABEL_CHARS);
    const path = safeZipName((match[1] ?? "").replace(/^\/+/, ""));
    if (path === null || path.endsWith("/")) {
      sink({ key: `data.assets.${index}`, kind: "other", action: "kept", summary: `asset ${label} has an unsafe path; it is not imported` });
      return;
    }
    candidates.push({ index, path, name, type, label });
  });

  const planned = new Set<Candidate>();
  const plan: PaCardEmbeddedAsset[] = [];
  if (!hasPortrait) {
    const icons = candidates.filter(item => item.type === "icon");
    const portrait = icons.find(item => item.name === "main") ?? icons[0];
    if (portrait) {
      planned.add(portrait);
      plan.push({ index: portrait.index, role: "portrait", path: portrait.path, name: portrait.name });
    }
  }
  const moods = new Set<PaEmotion>();
  for (const item of candidates) {
    if (planned.has(item)) continue;
    if (item.type !== "emotion") {
      sink({
        key: `data.assets.${item.index}`, kind: "other", action: "kept",
        summary: `asset ${item.label} (${item.type.slice(0, ASSET_LABEL_CHARS)}) is not imported`,
      });
      continue;
    }
    const emotion = emotionFromAssetName(item.name);
    if (emotion === null) {
      sink({ key: `data.assets.${item.index}`, kind: "other", action: "kept", summary: `emotion image ${item.label} matches no mood; it is not imported` });
      continue;
    }
    if (moods.has(emotion)) {
      sink({ key: `data.assets.${item.index}`, kind: "other", action: "kept", summary: `emotion image ${item.label} repeats ${emotion}; it is not imported` });
      continue;
    }
    moods.add(emotion);
    plan.push({ index: item.index, role: "sprite", emotion, path: item.path, name: item.name });
  }
  return plan;
}

/** Sanitises each bucket and keeps the whole record within `SOUL_LIMITS.preservedJson` chars of JSON. */
function buildPreserved(buckets: ReadonlyArray<readonly [PreservedBucket, Array<[string, unknown]>]>, sink: ReviewSink): PaPreserved {
  const preserved: PaPreserved = {};
  let used = 2;
  let written = 0;
  for (const [bucket, entries] of buckets) {
    if (entries.length === 0) continue;
    const cleaned = sanitizeForeign(Object.fromEntries(entries));
    const record = isRecord(cleaned) ? cleaned : {};
    const head = JSON.stringify(bucket).length + 1 + (written > 0 ? 1 : 0);
    const { kept, dropped } = capPreserved(record, L.preservedJson - used - head);
    for (const key of dropped) {
      sink({
        key: `${bucket}.${key}`, kind: "other", action: "truncated",
        summary: `${bucket}.${key} was not preserved: preserved card data is limited to ${L.preservedJson} chars`,
      });
    }
    if (Object.keys(kept).length === 0) continue;
    preserved[bucket] = kept;
    used += head + JSON.stringify(kept).length;
    written += 1;
  }
  return preserved;
}

// ---- import ------------------------------------------------------------------------------------------------------

export function parseCardText(text: string, options: CardImportOptions): PaCardImportPreview {
  const raw = typeof text === "string" ? text : "";
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (body.length > L.cardTextChars) return { ok: false, error: "too-large", detail: `${body.length} chars` };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: "bad-json", detail: error instanceof Error ? error.message : "invalid JSON" };
  }
  return parseCharacterCard(json, options);
}

export function parseCharacterCard(json: unknown, options: CardImportOptions): PaCardImportPreview {
  try {
    return importCard(json, isRecord(options) ? options : { now: 0 });
  } catch {
    return { ok: false, error: "unsupported-format", detail: "unreadable card" };
  }
}

function importCard(json: unknown, options: CardImportOptions): PaCardImportPreview {
  const view = readCard(json);
  if ("error" in view) return { ok: false, ...view };
  const items: PaNeedsReviewItem[] = [];
  const sink: ReviewSink = item => {
    items.push(item);
  };
  const { root, data } = view;

  // Name: the trimmed card name, else the file-name stem.
  let name = str(readField(view, "name"), Number.MAX_SAFE_INTEGER, "name", sink).trim();
  if (!name) name = fileNameStem(options.fileName);
  if (!name) return { ok: false, error: "no-name" };
  if (name.length > L.name) name = str(name, L.name, "name", sink).trim();

  const extensionsValue = own(data, "extensions");
  const ext: Record<string, unknown> = isRecord(extensionsValue) ? extensionsValue : {};
  const fantayValue = own(ext, "fantay");
  const fantay: Record<string, unknown> = isRecord(fantayValue) ? fantayValue : {};

  let firstMessage = str(readField(view, "first_mes"), L.firstMessage, "firstMessage", sink);
  let greetings = alternateGreetings(own(data, "alternate_greetings"), sink);
  if (firstMessage.trim() === "" && greetings.length > 0) {
    firstMessage = greetings[0] ?? "";
    greetings = greetings.slice(1);
  }
  greetings = capGreetings(greetings, sink);

  const depthPrompt = own(ext, "depth_prompt");
  let characterNote: PaCharacterDoc["characterNote"] = null;
  if (isRecord(depthPrompt)) {
    const text = str(own(depthPrompt, "prompt"), L.characterNote, "characterNote", sink);
    if (text.trim() !== "") {
      characterNote = {
        text,
        depth: num(own(depthPrompt, "depth"), 4, 0, L.noteDepth, true),
        role: coerceRole(own(depthPrompt, "role")),
      };
    }
  }
  const notes = own(data, "creator_notes");
  const presetValue = own(fantay, "presetId");
  const shape = paCharacterInputSchema.shape;
  const description = str(readField(view, "description"), L.description, "description", sink);
  const creatorNotes = str(isEmptyValue(notes) ? own(root, "creatorcomment") : notes, L.creatorNotes, "creatorNotes", sink);

  const doc: PaCharacterDoc = {
    nickname: str(own(data, "nickname"), L.nickname, "nickname", sink),
    tagline: str(own(fantay, "tagline"), L.tagline, "tagline", sink),
    description,
    personality: str(readField(view, "personality"), L.personality, "personality", sink),
    scenario: str(readField(view, "scenario"), L.scenario, "scenario", sink),
    firstMessage,
    alternateGreetings: greetings,
    openers: strList(own(fantay, "openers"), L.openers, L.opener, "openers", sink),
    exampleDialogue: str(readField(view, "mes_example"), L.exampleDialogue, "exampleDialogue", sink),
    systemPrompt: str(own(data, "system_prompt"), L.systemPrompt, "systemPrompt", sink),
    postHistoryInstructions: str(own(data, "post_history_instructions"), L.postHistoryInstructions, "postHistoryInstructions", sink),
    characterNote,
    creatorNotes,
    tags: strList(readField(view, "tags"), L.tags, L.tag, "tags", sink),
    creator: str(own(data, "creator"), L.creator, "creator", sink),
    characterVersion: str(own(data, "character_version"), L.characterVersion, "characterVersion", sink),
    presetId: typeof presetValue === "string" && BUILTIN_PRESET.test(presetValue) ? presetValue : null,
    personaId: null,
    lorebookIds: [],
    talkativeness: num(own(ext, "talkativeness") ?? own(root, "talkativeness"), 0.5, 0, 1, false),
    portraitAssetId: null,
    appearance: fantayPart(shape.appearance, own(fantay, "appearance"), "extensions.fantay.appearance", sink),
    stateSchema: fantayPart(shape.stateSchema, own(fantay, "stateSchema"), "extensions.fantay.stateSchema", sink),
    decks: fantayPart(shape.decks, own(fantay, "decks"), "extensions.fantay.decks", sink),
    sprites: {},
    voice: null,
    autoMemory: false,
  };

  reviewMarkup("firstMessage", [doc.firstMessage], sink);
  reviewMarkup("alternateGreetings", doc.alternateGreetings, sink);
  reviewMarkup("description", [doc.description], sink);
  reviewMarkup("creatorNotes", [doc.creatorNotes], sink);

  // Extensions: preserved, or quarantined when they hold executable data.
  const keptExtensions: Array<[string, unknown]> = [];
  const quarantine: Array<[string, unknown]> = [];
  for (const key of safeKeys(ext)) {
    if (CONSUMED_EXTENSIONS.has(key)) continue;
    const value = ext[key];
    if (isScriptExtension(key)) {
      quarantine.push([key, value]);
      sink({ key: `extensions.${key}`, kind: "script", action: "quarantined", summary: `extensions.${key} holds scripts; stored and never run` });
    } else if (key === "risuai" && isRecord(value)) {
      const moved: Array<[string, unknown]> = [];
      const rest: Array<[string, unknown]> = [];
      for (const sub of safeKeys(value)) (RISU_QUARANTINE.has(sub) ? moved : rest).push([sub, value[sub]]);
      for (const [sub] of moved) {
        sink({ key: `extensions.risuai.${sub}`, kind: "script", action: "quarantined", summary: `extensions.risuai.${sub} is executable; stored and never run` });
      }
      if (moved.length > 0) quarantine.push([key, Object.fromEntries(moved)]);
      keptExtensions.push([key, Object.fromEntries(rest)]);
    } else {
      keptExtensions.push([key, value]);
    }
  }

  // Root and data buckets; assets split into local (preserved) and remote (quarantined).
  const rootEntries = safeKeys(root).filter(key => !view.rootFields.has(key)).map((key): [string, unknown] => [key, root[key]]);
  const dataEntries = view.format === "ccv1"
    ? []
    : safeKeys(data).filter(key => !DATA_FIELD_SET.has(key)).map((key): [string, unknown] => [key, data[key]]);
  const assets = own(data, "assets");
  const portrait = suggestedPortrait(assets);
  let embedded: PaCardEmbeddedAsset[] = [];
  if (Array.isArray(assets)) {
    embedded = planEmbedded(assets, portrait !== null, sink);
    const local: unknown[] = [];
    const remote: unknown[] = [];
    assets.forEach((asset, index) => {
      const uri = isRecord(asset) ? own(asset, "uri") : undefined;
      if (typeof uri === "string" && /^\s*https?:/i.test(uri)) {
        remote.push(asset);
        const label = isRecord(asset) && typeof own(asset, "name") === "string" ? String(own(asset, "name")).slice(0, 60) : String(index);
        sink({ key: `data.assets.${index}`, kind: "remote", action: "quarantined", summary: `asset ${label} points to a remote URL; it is never fetched` });
      } else {
        local.push(asset);
      }
    });
    dataEntries.push(["assets", local]);
    if (remote.length > 0) quarantine.push(["assets", remote]);
  } else if (present(assets)) {
    dataEntries.push(["assets", assets]);
  }

  const book = own(data, "character_book");
  const mapped = present(book) ? mapCharacterBook(book, name, sink) : null;
  const world = own(ext, "world");
  if (mapped === null && typeof world === "string" && world.trim() !== "") {
    sink({ key: "extensions.world", kind: "other", action: "kept", summary: `depends on external world book ${world.trim().slice(0, 120)}` });
  }

  const preserved = buildPreserved([
    ["root", rootEntries],
    ["data", dataEntries],
    ["extensions", keptExtensions],
    ["quarantine", quarantine],
  ], sink);
  const preservedKeys = (["root", "data", "extensions"] as const)
    .flatMap(bucket => Object.keys(preserved[bucket] ?? {}).map(key => `${bucket}.${key}`));

  const parsed = paCharacterInputSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: "unsupported-format", detail: `card fields could not be mapped (${issue?.path.join(".") ?? ""})` };
  }
  return {
    ok: true,
    format: view.format,
    name,
    character: parsed.data,
    lorebook: mapped?.lorebook ?? null,
    meta: {
      origin: { format: view.format, name: options.fileName ?? name, importedAt: options.now },
      preserved,
      needsReview: capNeedsReview(items),
    },
    lorebookMeta: mapped?.meta ?? null,
    preservedKeys,
    portrait,
    embedded,
  };
}

// ---- export ------------------------------------------------------------------------------------------------------

/** Quarantined extensions to write back; a record already present in the kept extensions is merged one level. */
function quarantinedExtensions(kept: Record<string, unknown>, quarantine: Record<string, unknown>): Record<string, unknown> {
  const entries = safeKeys(quarantine)
    .filter(key => key !== "assets")
    .map((key): [string, unknown] => {
      const value = quarantine[key];
      const base = own(kept, key);
      return [key, isRecord(base) && isRecord(value) ? { ...base, ...value } : value];
    });
  return Object.fromEntries(entries);
}

export function exportCharacterCard(input: {
  name: string;                                   // the agent name
  character: PaCharacter;
  lorebooks: readonly PaLorebook[];               // in binding order
  now: number;
  includeQuarantined?: boolean;                   // default false
}): Record<string, unknown> {
  const { character, now } = input;
  const preserved: PaPreserved = isRecord(character.preserved) ? character.preserved : {};
  const root = isRecord(preserved.root) ? preserved.root : {};
  const keptData = isRecord(preserved.data) ? preserved.data : {};
  const keptExtensions = isRecord(preserved.extensions) ? preserved.extensions : {};
  const quarantine = isRecord(preserved.quarantine) ? preserved.quarantine : {};
  const includeQuarantined = input.includeQuarantined === true;
  const book = exportCharacterBook(input.lorebooks);
  const creationDate = own(keptData, "creation_date");
  const groupOnly = own(keptData, "group_only_greetings");
  const localAssets = own(keptData, "assets");
  const remoteAssets = own(quarantine, "assets");
  const note = character.characterNote;

  const data: Record<string, unknown> = {
    ...keptData,
    name: input.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    first_mes: character.firstMessage,
    mes_example: character.exampleDialogue,
    creator_notes: character.creatorNotes,
    system_prompt: character.systemPrompt,
    post_history_instructions: character.postHistoryInstructions,
    alternate_greetings: [...character.alternateGreetings],
    tags: [...character.tags],
    creator: character.creator,
    character_version: character.characterVersion,
    ...(character.nickname ? { nickname: character.nickname } : {}),
    group_only_greetings: Array.isArray(groupOnly) ? groupOnly : [],
    creation_date: typeof creationDate === "number" && Number.isFinite(creationDate)
      ? creationDate
      : Math.floor(character.createdAt / 1000),
    modification_date: Math.floor(now / 1000),
    ...(book !== null ? { character_book: book } : {}),
    extensions: {
      ...keptExtensions,
      ...(includeQuarantined ? quarantinedExtensions(keptExtensions, quarantine) : {}),
      talkativeness: character.talkativeness,
      ...(note !== null ? { depth_prompt: { prompt: note.text, depth: note.depth, role: note.role } } : {}),
      fantay: {
        tagline: character.tagline,
        presetId: character.presetId !== null && BUILTIN_PRESET.test(character.presetId) ? character.presetId : null,
        appearance: character.appearance,
        stateSchema: character.stateSchema,
        decks: character.decks,
        openers: [...character.openers],
      },
    },
    ...(includeQuarantined && Array.isArray(remoteAssets) && remoteAssets.length > 0
      ? { assets: [...(Array.isArray(localAssets) ? localAssets : []), ...remoteAssets] }
      : {}),
  };
  return { ...root, spec: "chara_card_v3", spec_version: "3.0", data };
}
