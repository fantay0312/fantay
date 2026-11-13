import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createMovieDocument } from "@open-design/contracts";
import { editMovie, stepMovieHistory } from "../../src/movie/edits.js";
import { saveMovie, readMovie, mutateMovie } from "../../src/movie/store.js";
import { authorMovie } from "../../src/movie/author.js";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "movie-edits-"));
  const d = createMovieDocument("Edit test", "blank");
  d.shots = [
    {
      id: "first",
      title: "First",
      body: "Body",
      duration: 3,
      layout: "title",
      captions: [{ start: 0, end: 1, text: "Original" }],
    },
    { id: "second", title: "Second", body: "", duration: 3, layout: "title" },
  ];
  await saveMovie(dir, { document: d, expectedRevision: 0 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("commits a batch once and restores only content through persistent undo/redo", async () => {
  let d = (await readMovie(dir))!;
  const original = structuredClone(d.shots),
    id = d.shots[0]!.captions![0]!.id!;
  const edited = await editMovie(dir, {
    expectedRevision: d.revision,
    label: "Two local edits",
    operations: [
      {
        op: "update-caption",
        shotId: "first",
        captionId: id,
        changes: { text: "Revised" },
      },
      { op: "update-shot", shotId: "second", changes: { title: "New title" } },
    ],
  });
  d = edited.document;
  expect(d.editHistory?.undoCount).toBe(1);
  expect(edited.receipt.changes.map((c) => c.field)).toEqual(
    expect.arrayContaining(["caption.text", "shot.title"]),
  );
  expect(JSON.stringify(d)).not.toContain('"_editHistory"');
  expect(await readFile(path.join(dir, "movie-studio.json"), "utf8")).toContain(
    '"_editHistory"',
  );
  d = (await readMovie(dir))!;
  const revision = d.revision,
    content = d.contentRevision;
  d = (await stepMovieHistory(dir, { expectedRevision: d.revision }, "undo"))
    .document;
  expect(d.shots).toEqual(original);
  expect(d.revision).toBe(revision + 1);
  expect(d.contentRevision).toBe(content + 1);
  expect(d.editHistory?.redoCount).toBe(1);
  d = (await stepMovieHistory(dir, { expectedRevision: d.revision }, "redo"))
    .document;
  expect(d.shots[0]!.captions![0]!.text).toBe("Revised");
  expect(d.shots[1]!.title).toBe("New title");
  expect(d.editHistory?.undoCount).toBe(1);
});
it("rejects a bad batch or stale revision without partial edits", async () => {
  const d = (await readMovie(dir))!,
    id = d.shots[0]!.captions![0]!.id!;
  await expect(
    editMovie(dir, {
      expectedRevision: d.revision,
      operations: [
        {
          op: "update-shot",
          shotId: "first",
          changes: { title: "Bad partial" },
        },
        {
          op: "update-caption",
          shotId: "first",
          captionId: id,
          changes: { end: 9 },
        },
      ],
    }),
  ).rejects.toThrow();
  expect(await readMovie(dir)).toEqual(d);
  await expect(
    editMovie(dir, {
      expectedRevision: 0,
      operations: [
        { op: "update-shot", shotId: "first", changes: { title: "Stale" } },
      ],
    }),
  ).rejects.toThrow("another window");
  await expect(
    editMovie(dir, {
      expectedRevision: d.revision,
      operations: [
        {
          op: "update-shot",
          shotId: "first",
          changes: { production: { status: "armed" } },
        },
      ],
    }),
  ).rejects.toThrow("Unknown edit field");
});
it("includes normal saves and authors, skips no-ops and clears redo after a new edit", async () => {
  let d = (await readMovie(dir))!;
  d = await saveMovie(dir, {
    expectedRevision: d.revision,
    document: { ...d, title: "Saved" },
  });
  expect(d.editHistory?.undoCount).toBe(1);
  d = await saveMovie(dir, { expectedRevision: d.revision, document: d });
  expect(d.editHistory?.undoCount).toBe(1);
  d = (await stepMovieHistory(dir, { expectedRevision: d.revision }, "undo"))
    .document;
  d = await authorMovie(dir, {
    expectedRevision: d.revision,
    shots: { mode: "upsert", items: [{ ...d.shots[0]!, title: "Authored" }] },
  });
  expect(d.editHistory?.redoCount).toBe(0);
  expect(d.editHistory?.undoCount).toBe(1);
  expect((await readMovie(dir))?.editHistory?.undoCount).toBe(1);
});
it("does not resurrect approvals or erase notes, saved styles, renders and production", async () => {
  let d = (await readMovie(dir))!;
  d = await mutateMovie(dir, d.revision, (c) => {
    c!.storyboardApproved = c!.contentRevision;
    c!.samplesApproved = c!.contentRevision;
    c!.approvedRenderId = "old";
    c!.delivery = { renderId: "old", createdAt: "now", files: [] };
    c!.notes = [{ id: "note", time: 0, text: "Keep", resolved: true }];
    c!.savedStyles = [{ ...structuredClone(c!.style), id: "saved-style" }];
    c!.renders = [{ id: "old", status: "done", contentRevision: c!.contentRevision, createdAt: "now", sourcePath: "source.html", file: "movie.mp4" }];
    c!.reviewBatch = { id: "review", productionId: "grant", createdAt: "now", sourceContentRevision: c!.contentRevision, notes: structuredClone(c!.notes), status: "ready", renderId: "old" };
    c!.production = {
      id: "grant",
      status: "armed",
      baselineContentRevision: 1,
      createdAt: "now",
    };
    return c!;
  });
  const retained = { savedStyles: d.savedStyles, renders: d.renders, reviewBatch: d.reviewBatch, production: d.production, style: d.style };
  d = (
    await editMovie(dir, {
      expectedRevision: d.revision,
      operations: [
        { op: "update-shot", shotId: "first", changes: { title: "New" } },
      ],
    })
  ).document;
  d = await mutateMovie(dir, d.revision, (c) => {
    c!.notes[0]!.text = "New note";
    return c!;
  });
  d = (await stepMovieHistory(dir, { expectedRevision: d.revision }, "undo"))
    .document;
  expect(d.storyboardApproved).toBeNull();
  expect(d.samplesApproved).toBeNull();
  expect(d.approvedRenderId).toBeNull();
  expect(d.delivery).toBeNull();
  expect(d.notes[0]!.text).toBe("New note");
  expect(d.production?.id).toBe("grant");
  for (const [key, value] of Object.entries(retained))
    expect(d[key as keyof typeof retained]).toEqual(value);
  d = (await stepMovieHistory(dir, { expectedRevision: d.revision }, "redo")).document;
  expect(d.approvedRenderId).toBeNull();
  expect(d.delivery).toBeNull();
  expect(d.notes[0]!.text).toBe("New note");
  for (const [key, value] of Object.entries(retained))
    expect(d[key as keyof typeof retained]).toEqual(value);
});
it("serializes concurrent edits and rejects stale history without consuming a step", async () => {
  const d = (await readMovie(dir))!;
  const results = await Promise.allSettled(["A", "B"].map((title) => editMovie(dir, { expectedRevision: d.revision, operations: [{ op: "update-shot", shotId: "first", changes: { title } }] })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const latest = (await readMovie(dir))!;
  expect(latest.editHistory?.undoCount).toBe(1);
  await expect(stepMovieHistory(dir, { expectedRevision: d.revision }, "undo")).rejects.toThrow("another window");
  expect(await readMovie(dir)).toEqual(latest);
  const undone = (await stepMovieHistory(dir, { expectedRevision: latest.revision }, "undo")).document;
  const noop = (await editMovie(dir, { expectedRevision: undone.revision, operations: [{ op: "update-shot", shotId: "first", changes: { title: undone.shots[0]!.title } }] })).document;
  expect(noop.editHistory?.redoCount).toBe(1);
  await expect(stepMovieHistory(dir, { expectedRevision: undone.revision }, "redo")).rejects.toThrow("another window");
  expect(await readMovie(dir)).toEqual(noop);
});
it("refuses history after an untracked file change and during rendering", async () => {
  let d = (await readMovie(dir))!;
  d = (
    await editMovie(dir, {
      expectedRevision: d.revision,
      operations: [
        { op: "update-shot", shotId: "first", changes: { title: "Tracked" } },
      ],
    })
  ).document;
  const file = path.join(dir, "movie-studio.json"),
    raw = JSON.parse(await readFile(file, "utf8"));
  raw.title = "Changed outside";
  await writeFile(file, JSON.stringify(raw));
  d = (await readMovie(dir))!;
  expect(d.editHistory?.blocked).toBe(true);
  await expect(
    stepMovieHistory(dir, { expectedRevision: d.revision }, "undo"),
  ).rejects.toThrow("no longer matches");
  d = await mutateMovie(dir, d.revision, (c) => {
    c!.renders = [
      {
        id: "r",
        status: "running",
        contentRevision: c!.contentRevision,
        createdAt: "now",
        sourcePath: "index.html",
      },
    ];
    return c!;
  });
  await expect(
    editMovie(dir, {
      expectedRevision: d.revision,
      operations: [
        {
          op: "update-shot",
          shotId: "first",
          changes: { title: "During render" },
        },
      ],
    }),
  ).rejects.toThrow("finish");
});
it("bounds history size and validates clip edits against the real source", async () => {
  let d = (await readMovie(dir))!;
  for (let n = 0; n < 28; n++)
    d = (
      await editMovie(dir, {
        expectedRevision: d.revision,
        operations: [
          {
            op: "update-shot",
            shotId: "first",
            changes: { title: `Edit ${n}` },
          },
        ],
      })
    ).document;
  expect(d.editHistory?.undoCount).toBe(25);
  execFileSync(
    ffmpeg.path,
    [
      "-f",
      "lavfi",
      "-i",
      "color=black:s=64x64:r=10:d=2",
      "-c:v",
      "libx264",
      path.join(dir, "video.mp4"),
    ],
    { stdio: "ignore" },
  );
  d = await saveMovie(dir, {
    expectedRevision: d.revision,
    document: {
      ...d,
      style: { ...d.style, assets: [{ id: "video", path: "video.mp4" }] },
      shots: [
        {
          ...d.shots[0]!,
          duration: 1,
          clip: { assetId: "video", in: 0, rate: 1, volume: 0, fit: "cover" },
        },
      ],
    },
  });
  await expect(
    editMovie(dir, {
      expectedRevision: d.revision,
      operations: [{ op: "update-clip", shotId: "first", changes: { in: 2 } }],
    }),
  ).rejects.toThrow("beyond");
  const good = await editMovie(dir, {
    expectedRevision: d.revision,
    operations: [
      {
        op: "update-clip",
        shotId: "first",
        changes: { in: 0.5, fit: "contain" },
      },
    ],
  });
  expect(good.receipt.changes.map((c) => c.field)).toContain("clip.in");
  expect(good.document.shots[0]!.clip?.fit).toBe("contain");
});
