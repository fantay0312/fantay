import { createHash, randomUUID } from "node:crypto";
import type {
  MovieDocument,
  MovieEditChange,
  MovieEditReceipt,
  MovieSaveRequest,
  MovieShot,
} from "@open-design/contracts";

export type EditableMovie = MovieSaveRequest["document"];
interface Entry {
  id: string;
  label: string;
  before: EditableMovie;
  after: EditableMovie;
}
interface History {
  past: Entry[];
  future: Entry[];
}
const histories = new WeakMap<MovieDocument, History>();
const MAX_ENTRIES = 25,
  MAX_BYTES = 8 * 1024 * 1024;
const empty = (): History => ({ past: [], future: [] });
const stable = (v: unknown): string =>
  v === undefined
    ? "null"
    : v === null || typeof v !== "object"
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? `[${v.map(stable).join(",")}]`
        : `{${Object.keys(v)
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .sort()
            .map(
              (k) =>
                `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`,
            )
            .join(",")}}`;
export function editableMovie(d: EditableMovie): EditableMovie {
  return structuredClone({
    title: d.title,
    brief: d.brief,
    startMode: d.startMode,
    aspect: d.aspect,
    ...(d.settings ? { settings: d.settings } : {}),
    style: d.style,
    shots: d.shots,
  });
}
export const movieEditKey = (d: EditableMovie) =>
  createHash("sha256")
    .update(stable(editableMovie(d)))
    .digest("hex");
export const movieContentKey = (d: EditableMovie) =>
  stable([d.title, d.aspect, d.settings, d.style, d.shots]);
export const sameMovieShot=(before:MovieShot,after:MovieShot|undefined)=>stable(before)===stable(after);
function aligned(doc: MovieDocument, data: History): boolean {
  const expected = data.past.at(-1)?.after ?? data.future.at(-1)?.before;
  return !expected || movieEditKey(doc) === movieEditKey(expected);
}
function attach(doc: MovieDocument, data: History): void {
  histories.set(doc, data);
  const blocked = !aligned(doc, data);
  doc.editHistory = {
    undoCount: data.past.length,
    redoCount: data.future.length,
    ...(data.past.at(-1) ? { undoLabel: data.past.at(-1)!.label } : {}),
    ...(data.future.at(-1) ? { redoLabel: data.future.at(-1)!.label } : {}),
    ...(blocked ? { blocked: true } : {}),
  };
}
/** Storage-only snapshots never cross the API or enter model context. */
export function hydrateMovieHistory(
  doc: MovieDocument & { _editHistory?: History },
): MovieDocument {
  const raw = doc._editHistory;
  delete doc._editHistory;
  const valid =
    raw &&
    Array.isArray(raw.past) &&
    Array.isArray(raw.future) &&
    raw.past.length + raw.future.length <= MAX_ENTRIES &&
    Buffer.byteLength(JSON.stringify(raw)) <= MAX_BYTES &&
    [...raw.past, ...raw.future].every(
      (e) =>
        typeof e?.id === "string" &&
        typeof e.label === "string" &&
        e.before &&
        e.after,
    );
  attach(doc, valid ? raw : empty());
  return doc;
}
export function carryMovieHistory(
  from: MovieDocument | null,
  to: MovieDocument,
): void {
  if (!histories.has(to))
    attach(to, from ? (histories.get(from) ?? empty()) : empty());
}
/** Import establishes a new editing baseline; prior histories remain in the migration archive. */
export function resetMovieHistory(doc: MovieDocument): void {
  attach(doc, empty());
}
export function storedMovie(
  doc: MovieDocument,
): MovieDocument & { _editHistory: History } {
  return { ...doc, _editHistory: histories.get(doc) ?? empty() };
}
function summary(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > 400 ? value.slice(0, 397) + "…" : value;
  return Array.isArray(value) ? `${value.length} items` : "Updated";
}
export function movieEditChanges(
  before: EditableMovie,
  after: EditableMovie,
): MovieEditChange[] {
  const result: MovieEditChange[] = [];
  const add = (
    field: string,
    a: unknown,
    b: unknown,
    extra: Partial<MovieEditChange> = {},
  ) => {
    if (stable(a) !== stable(b))
      result.push({ field, before: summary(a), after: summary(b), ...extra });
  };
  for (const key of ["title", "brief", "startMode", "aspect", "settings"] as const)
    add(key, before[key], after[key]);
  if (stable(before.style) !== stable(after.style))
    add(
      "style",
      before.style.name,
      after.style.name === before.style.name
        ? `${after.style.name} · updated`
        : after.style.name,
    );
  const ids = [...new Set([...before.shots, ...after.shots].map((s) => s.id))];
  for (const id of ids) {
    const a = before.shots.find((s) => s.id === id),
      b = after.shots.find((s) => s.id === id),
      extra = { shotId: id, shotTitle: b?.title ?? a?.title ?? id };
    if (!a || !b) {
      add(a ? "shot.removed" : "shot.added", a?.title, b?.title, extra);
      continue;
    }
    for (const key of [
      "title",
      "body",
      "direction",
      "duration",
      "layout",
      "media",
      "placement",
      "locked",
      "captionStyle",
      "textAnimation",
    ] as const)
      add(`shot.${key}`, a[key], b[key], extra);
    for (const key of ["assetId", "in", "rate", "volume", "fit", "x", "y", "width", "height", "opacity", "audioOnly", "muted", "fadeIn", "fadeOut", "audioFadeIn", "audioFadeOut", "rotation", "crop", "color", "keyframes"] as const)
      add(`clip.${key}`, a.clip?.[key], b.clip?.[key], extra);
    if (stable(a.visual) !== stable(b.visual))
      add(
        "visual",
        a.visual?.layers.length,
        b.visual?.layers.length === a.visual?.layers.length
          ? "Updated"
          : b.visual?.layers.length,
        extra,
      );
    const captionIds = [
      ...new Set(
        [...(a.captions ?? []), ...(b.captions ?? [])].map((c) => c.id!),
      ),
    ];
    for (const captionId of captionIds) {
      const x = a.captions?.find((c) => c.id === captionId),
        y = b.captions?.find((c) => c.id === captionId),
        ctx = { ...extra, captionId };
      if (!x || !y) {
        add(x ? "caption.removed" : "caption.added", x?.text, y?.text, ctx);
        continue;
      }
      for (const key of ["text", "start", "end"] as const)
        add(`caption.${key}`, x[key], y[key], ctx);
    }
  }
  add(
    "shot.order",
    before.shots.map((s) => s.id).join(", "),
    after.shots.map((s) => s.id).join(", "),
  );
  return result;
}
function receipt(
  before: MovieDocument,
  after: MovieDocument,
  label: string,
  action: MovieEditReceipt["action"],
  recorded: boolean,
): MovieEditReceipt {
  const changes = movieEditChanges(before, after);
  return {
    id: randomUUID(),
    label,
    action,
    createdAt: new Date().toISOString(),
    fromRevision: before.revision,
    revision: before.revision + 1,
    contentRevision: after.contentRevision,
    changedShotIds: [
      ...new Set(changes.flatMap((c) => (c.shotId ? [c.shotId] : []))),
    ],
    changes: changes.slice(0, 100),
    truncated: changes.length > 100,
    historyRecorded: recorded,
  };
}
export function recordMovieHistory(
  before: MovieDocument,
  after: MovieDocument,
  label = "Edit film",
): MovieDocument {
  const changed = movieEditKey(before) !== movieEditKey(after);
  let data = histories.get(before) ?? empty();
  let recorded = false;
  if (changed) {
    const entry = {
      id: randomUUID(),
      label,
      before: editableMovie(before),
      after: editableMovie(after),
    };
    data = aligned(before, data)
      ? { past: [...data.past, entry], future: [] }
      : { past: [entry], future: [] };
    while (
      data.past.length > MAX_ENTRIES ||
      Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES
    )
      data.past.shift();
    recorded = data.past.some((e) => e.id === entry.id);
  }
  attach(after, data);
  if (changed) after.lastEdit = receipt(before, after, label, "edit", recorded);
  return after;
}
export function historyTarget(
  doc: MovieDocument,
  direction: "undo" | "redo",
): EditableMovie {
  const data = histories.get(doc) ?? empty();
  if (!aligned(doc, data))
    throw new Error(
      "History no longer matches this film. Reload before editing.",
    );
  const entry = (direction === "undo" ? data.past : data.future).at(-1);
  if (!entry)
    throw new Error(
      direction === "undo" ? "Nothing to undo" : "Nothing to redo",
    );
  return editableMovie(direction === "undo" ? entry.before : entry.after);
}
export function completeHistoryStep(
  before: MovieDocument,
  after: MovieDocument,
  direction: "undo" | "redo",
): MovieDocument {
  const previous = histories.get(before) ?? empty(),
    data = { past: [...previous.past], future: [...previous.future] };
  const entry = (direction === "undo" ? data.past : data.future).pop()!;
  (direction === "undo" ? data.future : data.past).push(entry);
  attach(after, data);
  after.lastEdit = receipt(before, after, entry.label, direction, true);
  return after;
}
