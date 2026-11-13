import { randomUUID } from "node:crypto";
import type {
  MovieDocument,
  MovieEditOperation,
  MovieEditReceipt,
  MovieEditResponse,
} from "@open-design/contracts";
import {
  applyMovieEdit,
  MovieError,
  mutateMovie,
  parseMovieInput,
  safeMovieAsset,
} from "./store.js";
import {
  completeHistoryStep,
  editableMovie,
  historyTarget,
  movieEditChanges,
} from "./edit-history.js";
import { probeMovieMedia } from "./video-sources.js";
import { editClipStructure } from "./clip-edits.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MovieError("Expected an edit object");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new MovieError(
      "Unknown edit field; only explicit content changes are allowed",
    );
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new MovieError("expectedRevision is required");
  return Number(value);
}
function canEdit(doc: MovieDocument) {
  if (
    doc.renders.some((r) => r.status === "running") ||
    ["preparing", "rendering"].includes(doc.production?.status ?? "")
  )
    throw new MovieError(
      "Wait for production to finish before editing or undoing",
      409,
    );
}
async function validateClips(
  dir: string,
  doc: MovieDocument,
  ids: Set<string>,
) {
  for (const shot of doc.shots) {
    if (!shot.clip || !ids.has(shot.id)) continue;
    const asset = doc.style.assets?.find((a) => a.id === shot.clip!.assetId);
    if (!asset) throw new MovieError("Choose imported media");
    const info = await probeMovieMedia(await safeMovieAsset(dir, asset.path));
    if(shot.clip.audioOnly&&!info.hasAudio)throw new MovieError('This source has no audio track to detach.');
    if (info.kind !== "image" && shot.clip.in + shot.duration * shot.clip.rate > info.duration + 0.04)
      throw new MovieError(`Shot ${shot.id} extends beyond its source video`);
  }
}
export async function editMovie(
  dir: string,
  value: unknown,
): Promise<MovieEditResponse> {
  const request = object(value);
  only(request, ["expectedRevision", "label", "operations"]);
  const expected = revision(request.expectedRevision);
  if (
    !Array.isArray(request.operations) ||
    !request.operations.length ||
    request.operations.length > 100 ||
    JSON.stringify(request).length > 2000000
  )
    throw new MovieError("Provide 1–100 localized edits");
  const label = request.label === undefined ? "Edit selection" : request.label;
  if (typeof label !== "string" || !label.trim() || label.length > 100)
    throw new MovieError("Edit label must be 1–100 characters");
  let responseReceipt: MovieEditReceipt | undefined;
  const document = await mutateMovie(dir, expected, async (current) => {
    if (!current) throw new MovieError("Movie not found", 404);
    canEdit(current);
    const draft = editableMovie(current),
      clipChecks = new Set<string>();
    for (const raw of request.operations as unknown[]) {
      const op = object(raw);
      const changedClips = await editClipStructure(dir, draft, op);
      if (changedClips) {
        changedClips.forEach((id) => clipChecks.add(id));
        continue;
      }
      const shot = draft.shots.find((s) => s.id === op.shotId);
      if (!shot) throw new MovieError("Choose an existing shot ID");
      if (
        op.op === "update-shot" ||
        op.op === "update-clip" ||
        op.op === "update-caption"
      ) {
        only(
          op,
          op.op === "update-caption"
            ? ["op", "shotId", "captionId", "changes"]
            : ["op", "shotId", "changes"],
        );
        const changes = object(op.changes);
        if (!Object.keys(changes).length)
          throw new MovieError("Provide at least one changed field");
        if (op.op === "update-shot") {
          only(changes, ["title", "body", "direction", "duration", "layout", "visual", "captionStyle", "textAnimation"]);
          Object.assign(shot, changes);
          if ("duration" in changes) clipChecks.add(shot.id);
        } else if (op.op === "update-clip") {
          if (!shot.clip) throw new MovieError("This shot has no video clip");
          only(changes, ["assetId", "in", "rate", "volume", "fit", "x", "y", "width", "height", "opacity", "audioOnly", "muted", "fadeIn", "fadeOut", "audioFadeIn", "audioFadeOut", "rotation", "crop", "color", "keyframes"]);
          Object.assign(shot.clip, changes);
          if ('fadeIn' in changes && !('audioFadeIn' in changes)) delete shot.clip.audioFadeIn;
          if ('fadeOut' in changes && !('audioFadeOut' in changes)) delete shot.clip.audioFadeOut;
          clipChecks.add(shot.id);
        } else {
          only(changes, ["start", "end", "text"]);
          const caption = shot.captions?.find((c) => c.id === op.captionId);
          if (!caption) throw new MovieError("Choose an existing caption ID");
          Object.assign(caption, changes);
        }
      } else if (op.op === "add-caption") {
        only(op, ["op", "shotId", "caption"]);
        const c = object(op.caption);
        only(c, ["id", "start", "end", "text"]);
        shot.captions = [
          ...(shot.captions ?? []),
          { ...c, id: c.id ?? randomUUID() } as NonNullable<
            typeof shot.captions
          >[number],
        ];
      } else if (op.op === "remove-caption") {
        only(op, ["op", "shotId", "captionId"]);
        if (!shot.captions?.some((c) => c.id === op.captionId))
          throw new MovieError("Choose an existing caption ID");
        shot.captions = shot.captions.filter((c) => c.id !== op.captionId);
      } else if (op.op === "replace-captions") {
        only(op, ["op", "shotId", "captions"]);
        if (!Array.isArray(op.captions))
          throw new MovieError("captions must be an array");
        shot.captions = op.captions.map((raw) => {
          const c = object(raw);
          only(c, ["id", "start", "end", "text"]);
          return { ...c, id: c.id ?? randomUUID() } as NonNullable<
            typeof shot.captions
          >[number];
        });
      } else throw new MovieError("Unknown edit operation");
    }
    for(const before of current.shots.filter(s=>s.locked)){
      const after=draft.shots.find(s=>s.id===before.id);
      if(after?.locked!==false&&JSON.stringify(before)!==JSON.stringify(after))throw new MovieError('This clip is locked. Unlock it before changing its content or timing.');
    }
    const parsed = parseMovieInput(draft);
    await validateClips(dir, { ...current, ...parsed }, clipChecks);
    const next = applyMovieEdit(current, parsed, { label: label.trim() });
    const changes = movieEditChanges(current, next);
    responseReceipt = changes.length
      ? next.lastEdit
      : {
          id: randomUUID(),
          label: label.trim(),
          action: "edit",
          createdAt: new Date().toISOString(),
          fromRevision: current.revision,
          revision: current.revision + 1,
          contentRevision: next.contentRevision,
          changedShotIds: [],
          changes: [],
          truncated: false,
          historyRecorded: false,
        };
    return next;
  });
  return { document, receipt: responseReceipt! };
}
export async function stepMovieHistory(
  dir: string,
  value: unknown,
  direction: "undo" | "redo",
): Promise<MovieEditResponse> {
  const request = object(value);
  only(request, ["expectedRevision"]);
  const document = await mutateMovie(
    dir,
    revision(request.expectedRevision),
    async (current) => {
      if (!current) throw new MovieError("Movie not found", 404);
      canEdit(current);
      let target;
      try {
        target = historyTarget(current, direction);
      } catch (error) {
        throw new MovieError(String((error as Error).message), 409);
      }
      const parsed = parseMovieInput(target);
      for (const asset of parsed.style.assets ?? [])
        await safeMovieAsset(dir, asset.path);
      await validateClips(
        dir,
        { ...current, ...parsed },
        new Set(parsed.shots.map((s) => s.id)),
      );
      return completeHistoryStep(
        current,
        applyMovieEdit(current, parsed, { history: false }),
        direction,
      );
    },
  );
  return { document, receipt: document.lastEdit! };
}
