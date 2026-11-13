import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { createMovieDocument, movieAssistPrompt } from "@open-design/contracts";
import {
  saveMovie,
  readMovie,
  mutateMovie,
  applyMovieAction,
} from "../../src/movie/store.js";
import { submitReviewBatch, markReviewRender } from "../../src/movie/review.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "review-notes-"));
  await saveMovie(root, {
    document: createMovieDocument("Review", "blank"),
    expectedRevision: 0,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function rendered() {
  let d = (await readMovie(root))!;
  d = await saveMovie(root, {
    expectedRevision: d.revision,
    document: {
      ...d,
      shots: [
        {
          id: "shot-a",
          title: "Before",
          body: "",
          duration: 4,
          layout: "title",
        },
      ],
    },
  });
  return mutateMovie(root, d.revision, (c) => ({
    ...c!,
    renders: [
      {
        id: "v1",
        contentRevision: c!.contentRevision,
        status: "done",
        duration: 4,
        sourcePath: "motion-source/v1/index.html",
        file: "v1.mp4",
        createdAt: new Date().toISOString(),
      },
    ],
  }));
}
describe("Versioned feedback", () => {
  it("anchors live timestamps and ranges before export and respects absolute shot placement", async () => {
    const initial = (await readMovie(root))!;
    let d = await saveMovie(root, { expectedRevision: initial.revision, document: {
      ...initial, shots: [{ id: 'live', title: 'Live scene', body: '', duration: 3, layout: 'title', placement: { start: 4, track: 1 } }],
    } });
    for (const target of [{ scope: 'time' as const, time: 5 }, { scope: 'range' as const, time: 4, endTime: 6 }, { scope: 'shot' as const, time: 0, shotId: 'live' }]) {
      d = await applyMovieAction(root, d.revision, { action: 'add-note', ...target, contentRevision: d.contentRevision, text: 'Adjust the entrance' });
    }
    expect(d.renders).toEqual([]);
    expect(d.production).toBeUndefined();
    expect(d.notes.map(n => [n.scope, n.time, n.endTime])).toEqual([['time', 5, undefined], ['range', 4, 6], ['shot', 4, 7]]);
    expect(d.notes.every(n => n.contentRevision === d.contentRevision && !n.renderId)).toBe(true);
    await expect(applyMovieAction(root, d.revision, { action: 'add-note', scope: 'time', time: 5, contentRevision: 0, text: 'Stale' })).rejects.toThrow('changed');
    await expect(applyMovieAction(root, d.revision, { action: 'add-note', scope: 'range', time: 6, endTime: 8, text: 'Outside' })).rejects.toThrow('range');
  });
  it("accepts shot notes before rendering and rejects stale or unknown targets", async () => {
    let d = (await readMovie(root))!;
    d = await saveMovie(root, {
      expectedRevision: d.revision,
      document: {
        ...d,
        shots: [
          { id: "shot-a", title: "A", body: "", duration: 2, layout: "title" },
        ],
      },
    });
    d = await applyMovieAction(root, d.revision, {
      action: "add-note",
      scope: "shot",
      shotId: "shot-a",
      contentRevision: d.contentRevision,
      time: 0,
      text: "Change this shot",
    });
    expect(d.notes[0]).toMatchObject({
      scope: "shot",
      shotId: "shot-a",
      contentRevision: d.contentRevision,
      resolved: false,
    });
    await expect(
      applyMovieAction(root, d.revision, {
        action: "add-note",
        scope: "shot",
        shotId: "missing",
        time: 0,
        text: "Invalid",
      }),
    ).rejects.toThrow("Choose a shot");
    await expect(
      applyMovieAction(root, d.revision, {
        action: "add-note",
        scope: "film",
        contentRevision: 0,
        time: 0,
        text: "Stale",
      }),
    ).rejects.toThrow("changed");
  });
  it("binds ranges to the selected historical render duration", async () => {
    let d = await rendered();
    await mkdir(path.join(root, "motion-source/v1"), { recursive: true });
    await writeFile(
      path.join(root, "motion-source/v1/movie-snapshot.json"),
      JSON.stringify(d),
    );
    d = await saveMovie(root, {
      expectedRevision: d.revision,
      document: { ...d, shots: [{ ...d.shots[0]!, duration: 8 }] },
    });
    await expect(
      applyMovieAction(root, d.revision, {
        action: "add-note",
        scope: "range",
        renderId: "v1",
        time: 3,
        endTime: 6,
        text: "Too late",
      }),
    ).rejects.toThrow("range");
    d = await applyMovieAction(root, d.revision, {
      action: "add-note",
      scope: "range",
      renderId: "v1",
      time: 1,
      endTime: 3,
      text: "Hold this range",
    });
    expect(d.notes[0]).toMatchObject({
      renderId: "v1",
      time: 1,
      endTime: 3,
      contentRevision: d.renders[0]!.contentRevision,
    });
    d = await submitReviewBatch(root, {
      expectedRevision: d.revision,
      requestId: "historical-batch",
      noteIds: [d.notes[0]!.id],
      sourceRenderId: "v1",
    });
    expect(d.reviewBatch!.sourceContentRevision).toBe(
      d.renders[0]!.contentRevision,
    );
    expect(d.production!.baselineContentRevision).toBe(d.contentRevision);
    expect(d.reviewBatch!.sourceContentRevision).not.toBe(d.contentRevision);
  });
  it("freezes an idempotent batch, prioritizes revise for blank projects, and waits for human confirmation", async () => {
    let d = await rendered();
    d = await applyMovieAction(root, d.revision, {
      action: "add-note",
      scope: "range",
      renderId: "v1",
      time: 1,
      endTime: 2,
      text: "Replace caption",
    });
    const id = d.notes[0]!.id;
    d = await submitReviewBatch(root, {
      expectedRevision: d.revision,
      requestId: "batch",
      noteIds: [id],
      sourceRenderId: "v1",
    });
    const again = await submitReviewBatch(root, {
      expectedRevision: 0,
      requestId: "batch",
      noteIds: [id],
      sourceRenderId: "v1",
    });
    expect(again.production?.id).toBe(d.production?.id);
    expect(movieAssistPrompt(d, "revise")).toContain("Replace caption");
    expect(movieAssistPrompt(d, "revise")).not.toContain("独立导演");
    d = await applyMovieAction(root, d.revision, {
      action: "add-note",
      renderId: "v1",
      time: 2,
      text: "Later note",
    });
    expect(d.reviewBatch!.notes).toHaveLength(1);
    d = await saveMovie(root, {
      expectedRevision: d.revision,
      document: { ...d, shots: [{ ...d.shots[0]!, title: "After" }] },
    });
    d = await mutateMovie(root, d.revision, (c) => {
      const r = {
        ...c!.renders[0]!,
        id: "v2",
        contentRevision: c!.contentRevision,
      };
      c!.renders.push(r);
      markReviewRender(c!, r, c!.production!.id);
      return c!;
    });
    expect(d.notes[0]).toMatchObject({
      addressedRenderId: "v2",
      resolved: false,
    });
    expect(d.notes[1]!.addressedRenderId).toBeUndefined();
    await expect(
      applyMovieAction(root, d.revision, {
        action: "resolve-note",
        noteId: id,
        renderId: "v1",
      }),
    ).rejects.toThrow("version");
    d = await applyMovieAction(root, d.revision, {
      action: "resolve-note",
      noteId: id,
      renderId: "v2",
    });
    expect(d.notes[0]).toMatchObject({
      resolved: true,
      resolvedInRenderId: "v2",
    });
    expect(d.approvedRenderId).toBeNull();
  });
  it("does not resolve notes for failed or stale renders", async () => {
    let d = await rendered();
    d = await applyMovieAction(root, d.revision, {
      action: "add-note",
      renderId: "v1",
      time: 1,
      text: "Change",
    });
    d = await submitReviewBatch(root, {
      expectedRevision: d.revision,
      requestId: "batch",
      noteIds: [d.notes[0]!.id],
      sourceRenderId: "v1",
    });
    const r = { ...d.renders[0]!, id: "failed", status: "failed" as const };
    markReviewRender(d, r, d.production!.id);
    expect(d.reviewBatch!.status).toBe("failed");
    expect(d.notes[0]!.addressedRenderId).toBeUndefined();
  });
});
