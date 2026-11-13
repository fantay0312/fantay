import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  movieDuration,
  movieShotStarts,
  type MovieDocument,
  type MovieAction,
  type MovieRender,
  type MovieReviewNote,
} from "@open-design/contracts";
import { MovieError, mutateMovie, readMovie, safeMovieAsset } from "./store.js";

export async function renderSnapshot(
  dir: string,
  doc: MovieDocument,
  render: MovieRender,
): Promise<MovieDocument> {
  try {
    const file = await safeMovieAsset(
      dir,
      path.posix.join(
        path.posix.dirname(render.sourcePath),
        "movie-snapshot.json",
      ),
    );
    const snapshot = JSON.parse(await readFile(file, "utf8")) as MovieDocument;
    if (!Array.isArray(snapshot.shots))
      throw new MovieError("Invalid render snapshot");
    return snapshot;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      render.contentRevision === doc.contentRevision
    )
      return doc;
    throw error;
  }
}

export async function appendReviewNote(
  dir: string,
  doc: MovieDocument,
  action: Extract<MovieAction, { action: "add-note" }>,
): Promise<void> {
  const scope = action.scope ?? "time";
  if (!["time", "range", "film", "shot"].includes(scope))
    throw new MovieError("Invalid review scope");
  const render = action.renderId
    ? doc.renders.find((r) => r.id === action.renderId && r.status === "done")
    : undefined;
  if (action.renderId && !render)
    throw new MovieError("Choose a completed render");
  if (
    !render &&
    action.contentRevision !== undefined &&
    action.contentRevision !== doc.contentRevision
  )
    throw new MovieError(
      "The movie changed. Select the current preview again.",
      409,
    );
  const snapshot = render ? await renderSnapshot(dir, doc, render) : doc;
  const duration = render?.duration ?? movieDuration(snapshot);
  let time = action.time,
    endTime = action.endTime;
  if (scope === "film") {
    time = 0;
    endTime = undefined;
  }
  if (scope === "shot") {
    const index = snapshot.shots.findIndex((s) => s.id === action.shotId);
    if (index < 0) throw new MovieError("Choose a shot from this version");
    time = movieShotStarts(snapshot)[index]!;
    endTime = time + snapshot.shots[index]!.duration;
  }
  if (!Number.isFinite(time) || time < 0 || time > duration)
    throw new MovieError("Invalid review timestamp");
  if (
    scope === "range" &&
    (!Number.isFinite(endTime) || endTime! <= time || endTime! > duration)
  )
    throw new MovieError(
      "Review range must end after its start and stay inside this version",
    );
  if (
    typeof action.text !== "string" ||
    !action.text.trim() ||
    action.text.length > 3000
  )
    throw new MovieError("Review text is required (maximum 3000 characters)");
  doc.notes.push({
    id: randomUUID(),
    scope,
    time,
    text: action.text.trim(),
    resolved: false,
    contentRevision: render?.contentRevision ?? doc.contentRevision,
    createdAt: new Date().toISOString(),
    ...(render ? { renderId: render.id } : {}),
    ...(endTime === undefined ? {} : { endTime }),
    ...(scope === "shot"
      ? {
          shotId: action.shotId!,
          shotTitle: snapshot.shots.find((s) => s.id === action.shotId)!.title,
        }
      : {}),
  });
  doc.approvedRenderId = null;
  doc.delivery = null;
}

export async function submitReviewBatch(
  dir: string,
  value: unknown,
): Promise<MovieDocument> {
  const body = value as {
    requestId?: unknown;
    expectedRevision?: unknown;
    noteIds?: unknown;
    sourceRenderId?: unknown;
  };
  if (
    !body ||
    typeof body.requestId !== "string" ||
    !body.requestId ||
    body.requestId.length > 120 ||
    !Number.isSafeInteger(body.expectedRevision) ||
    !Array.isArray(body.noteIds) ||
    !body.noteIds.length ||
    body.noteIds.length > 100 ||
    body.noteIds.some((id) => typeof id !== "string") ||
    new Set(body.noteIds).size !== body.noteIds.length
  )
    throw new MovieError("Choose review notes and the current revision");
  const previous = await readMovie(dir);
  if (previous?.reviewBatch?.id === body.requestId) return previous;
  try {
    return await mutateMovie(dir, Number(body.expectedRevision), (doc) => {
      if (!doc) throw new MovieError("Movie not found", 404);
      if (
        ["preparing", "rendering"].includes(doc.production?.status ?? "") ||
        (doc.reviewBatch?.status === "submitted" &&
          doc.production?.status === "armed")
      )
        throw new MovieError("A revision is already being produced", 409);
      const notes = (body.noteIds as string[]).map((id) =>
        doc.notes.find((n) => n.id === id),
      );
      if (notes.some((n) => !n || n.resolved || n.addressedRenderId))
        throw new MovieError(
          "Choose pending notes that have not already produced a revision",
        );
      const sourceRenderId =
        typeof body.sourceRenderId === "string"
          ? body.sourceRenderId
          : undefined;
      if (
        sourceRenderId &&
        !doc.renders.some((r) => r.id === sourceRenderId && r.status === "done")
      )
        throw new MovieError("Source version not found");
      if (
        notes.some((n) =>
          sourceRenderId ? n!.renderId !== sourceRenderId : !!n!.renderId,
        )
      )
        throw new MovieError("Send notes from one source version at a time");
      const sourceContentRevision = sourceRenderId
        ? doc.renders.find((r) => r.id === sourceRenderId)!.contentRevision
        : (notes[0]!.contentRevision ?? doc.contentRevision);
      if (
        !sourceRenderId &&
        notes.some(
          (n) =>
            (n!.contentRevision ?? doc.contentRevision) !== sourceContentRevision,
        )
      )
        throw new MovieError("Send notes from one storyboard version at a time");
      const createdAt = new Date().toISOString(),
        productionId = randomUUID();
      doc.reviewBatch = {
        id: body.requestId as string,
        productionId,
        createdAt,
        sourceContentRevision,
        notes: structuredClone(notes as MovieReviewNote[]),
        status: "submitted",
        ...(sourceRenderId ? { sourceRenderId } : {}),
      };
      doc.production = {
        id: productionId,
        status: "armed",
        createdAt,
        baselineContentRevision: doc.contentRevision,
        reviewBatchId: body.requestId as string,
      };
      for (const note of notes)
        note!.submittedBatchId = body.requestId as string;
      return doc;
    });
  } catch (error) {
    const current = await readMovie(dir);
    if (current?.reviewBatch?.id === body.requestId) return current;
    throw error;
  }
}

export function markReviewRender(
  doc: MovieDocument,
  render: MovieRender,
  productionId: string | undefined,
): void {
  const batch = doc.reviewBatch;
  if (!batch || batch.productionId !== productionId) return;
  batch.renderId = render.id;
  if (
    render.status === "done" &&
    render.contentRevision === doc.contentRevision
  ) {
    batch.status = "ready";
    for (const snapshot of batch.notes) {
      const note = doc.notes.find((n) => n.id === snapshot.id);
      if (note && !note.resolved) note.addressedRenderId = render.id;
    }
  } else if (
    render.status === "failed" ||
    render.contentRevision !== doc.contentRevision
  ) {
    batch.status = "failed";
    batch.error = render.error ?? "The film changed during revision";
  } else batch.status = "rendering";
}
