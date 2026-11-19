// SPDX-License-Identifier: Apache-2.0
// CHARX: a character card zip (`card.json` plus the images it names as `embeded://path`). Only `card.json` and the
// images the card parser planned are ever inflated; every other entry is listed in the report and left unread.
import { PA_EMOTIONS } from "../api/personal-agent-soul.js";
import type { PaCardImportPreview, PaEmotion } from "../api/personal-agent-soul.js";
import { cardEmbeddedPaths, isEmbeddedAssetUri, parseCharacterCard } from "./card.js";
import type { CardImportOptions } from "./card.js";
import { emotionFromAssetName } from "./emotion.js";
import { SOUL_LIMITS } from "./limits.js";
import { buildZip, readZipEntry, readZipIndex } from "./zip.js";
import type { ZipEntry, ZipInflate, ZipSkipReason } from "./zip.js";

export interface CharxAsset {
  role: "portrait" | "sprite"; emotion?: PaEmotion; name: string; path: string;
  mime: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array;
}
/** `not-planned`: the card names the file, but it is not one of the images this version imports (the card review
 *  says why); `not-referenced`: the card does not name it at all. */
export type CharxReason = "not-referenced" | "not-planned" | "not-image" | "too-large" | "missing" | "corrupt" | "limit" | ZipSkipReason;
export interface CharxReportItem { path: string; action: "imported" | "skipped"; reason?: CharxReason }
export type CharxResult =
  | { ok: false; error: "not-zip" | "corrupt" | "too-large" | "too-many" | "zip64" | "no-card" | "bad-json" }
  | { ok: true; card: unknown; preview: PaCardImportPreview; assets: CharxAsset[]; report: CharxReportItem[] };

const CARD_NAME = "card.json";

function sniffImage(data: Uint8Array): CharxAsset["mime"] | null {
  const at = (index: number) => data[index] ?? -1;
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte)) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const ascii = (from: number, text: string) => Array.from(text).every((char, index) => at(from + index) === char.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** At most `SOUL_LIMITS.charxReport` items; when capped, the last item carries the number of items left out. */
function capReport(items: readonly CharxReportItem[]): CharxReportItem[] {
  const max = SOUL_LIMITS.charxReport;
  if (items.length <= max) return [...items];
  const kept = items.slice(0, max - 1);
  return [...kept, { path: String(items.length - kept.length), action: "skipped", reason: "limit" }];
}

export async function readCharx(bytes: Uint8Array, inflate: ZipInflate, options: CardImportOptions): Promise<CharxResult> {
  const index = readZipIndex(bytes);
  if (!index.ok) return { ok: false, error: index.error };

  const byName = new Map<string, ZipEntry>(index.entries.map(entry => [entry.name, entry]));
  const cardEntry = byName.get(CARD_NAME);
  if (!cardEntry || cardEntry.directory) return { ok: false, error: "no-card" };
  const cardRead = await readZipEntry(bytes, index, cardEntry, inflate, SOUL_LIMITS.charxCardBytes);
  if (!cardRead.ok) return { ok: false, error: cardRead.error === "too-large" ? "too-large" : "corrupt" };
  let card: unknown;
  try {
    const text = new TextDecoder("utf-8").decode(cardRead.data);
    card = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return { ok: false, error: "bad-json" };
  }

  const preview = parseCharacterCard(card, options);
  if (!preview.ok) return { ok: true, card, preview, assets: [], report: [] };

  const assets: CharxAsset[] = [];
  const report: CharxReportItem[] = [];
  const referenced = new Set<string>();
  let budget = SOUL_LIMITS.charxExtractBytes;
  for (const item of preview.embedded) {
    referenced.add(item.path);
    const entry = byName.get(item.path);
    if (!entry || entry.directory) {
      report.push({ path: item.path, action: "skipped", reason: "missing" });
      continue;
    }
    const read = await readZipEntry(bytes, index, entry, inflate, Math.min(SOUL_LIMITS.charxAssetBytes, budget));
    if (!read.ok) {
      report.push({ path: item.path, action: "skipped", reason: read.error === "too-large" ? "too-large" : "corrupt" });
      continue;
    }
    const mime = sniffImage(read.data);
    if (mime === null) {
      report.push({ path: item.path, action: "skipped", reason: "not-image" });
      continue;
    }
    budget -= read.data.length;
    assets.push({
      role: item.role, ...(item.emotion !== undefined ? { emotion: item.emotion } : {}),
      name: item.name, path: item.path, mime, data: read.data,
    });
    report.push({ path: item.path, action: "imported" });
  }
  const named = cardEmbeddedPaths(card);
  for (const entry of index.entries) {
    if (entry.directory || entry.name === CARD_NAME || referenced.has(entry.name)) continue;
    report.push({ path: entry.name, action: "skipped", reason: named.has(entry.name) ? "not-planned" : "not-referenced" });
  }
  for (const skipped of index.skipped) report.push({ path: skipped.name, action: "skipped", reason: skipped.reason });
  return { ok: true, card, preview, assets, report: capReport(report) };
}

/**
 * Packs an exported V3 card with its pictures as a CHARX archive: `card.json`, the portrait as the `icon` named
 * `main` and one `emotion` image per mood, each listed in `data.assets` as `embeded://path` with the bytes as they are
 * stored (no re-encoding). `readCharx` reads the result back to the same portrait and sprites. Asset entries of the
 * card that point into another archive are dropped, because their files are not in this one; so are entries the
 * packed pictures replace (an `icon` named `main`, an `emotion` of a packed mood). Inline and default entries stay. An
 * image that is not PNG, JPEG or WebP is left out.
 */
export function buildCharx(input: {
  card: Record<string, unknown>;
  portrait?: Uint8Array | null;
  sprites?: Partial<Record<PaEmotion, Uint8Array | null>>;
}): Uint8Array {
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const packed: Array<{ type: "icon" | "emotion"; name: string; uri: string; ext: string }> = [];
  const pack = (type: "icon" | "emotion", name: string, data: Uint8Array | null | undefined): boolean => {
    const mime = data instanceof Uint8Array ? sniffImage(data) : null;
    if (!data || mime === null) return false;
    const ext = mime.slice("image/".length);
    const path = `assets/${type}/${name}.${ext}`;
    files.push({ name: path, data });
    packed.push({ type, name, uri: `embeded://${path}`, ext });
    return true;
  };
  const hasPortrait = pack("icon", "main", input.portrait);
  const moods = new Set<PaEmotion>();
  for (const emotion of PA_EMOTIONS) if (pack("emotion", emotion, input.sprites?.[emotion])) moods.add(emotion);

  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const data: Record<string, unknown> = record(input.card.data) ? { ...input.card.data } : {};
  const kept = (Array.isArray(data.assets) ? data.assets : []).filter(asset => {
    if (!record(asset)) return true;
    if (isEmbeddedAssetUri(asset.uri)) return false;
    const type = typeof asset.type === "string" ? asset.type.toLowerCase() : "";
    if (type === "icon" && asset.name === "main") return !hasPortrait;
    if (type === "emotion" && typeof asset.name === "string") {
      const emotion = emotionFromAssetName(asset.name);
      return emotion === null || !moods.has(emotion);
    }
    return true;
  });
  if (packed.length + kept.length > 0) data.assets = [...packed, ...kept];
  else delete data.assets;
  const card = new TextEncoder().encode(JSON.stringify({ ...input.card, data }));
  return buildZip([{ name: CARD_NAME, data: card }, ...files]);
}
