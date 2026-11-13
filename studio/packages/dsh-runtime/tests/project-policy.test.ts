import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installProjectToolPolicy,
  projectPathAllowed,
  projectToolDenial,
} from "../src/project-policy.js";
const dirs: string[] = [];
const dir = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fantay-policy-"));
  dirs.push(root);
  return root;
};
afterEach(() => {
  for (const root of dirs.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("Project-scoped Harness tools", () => {
  it("publishes every structural edit field to the model, including source-only insertion", () => {
    const root = dir(); writeFileSync(path.join(root, 'movie-studio.json'), '{}');
    const definitions = new Map<string, any>();
    installProjectToolPolicy({ tools: { guard: () => {}, register: (d: any) => definitions.set(d.name, d) }, on: () => {} }, root,
      { OD_DSH_TOOL_POLICY: 'project', OD_DAEMON_URL: 'http://127.0.0.1:7456', OD_PROJECT_ID: 'fixed' }, vi.fn());
    const schema = definitions.get('fantay_movie_edit').parameters.properties.operations.items;
    expect(schema.properties.op.enum).toEqual(expect.arrayContaining(['split-clip', 'trim-clip', 'move-shot', 'remove-shot', 'insert-clip']));
    for (const field of ['at', 'start', 'end', 'index', 'assetId', 'in', 'duration', 'newShotId']) expect(schema.properties[field]).toBeDefined();
    expect(schema.required).not.toContain('shotId');
  });
  it("forwards localized edits and history to the fixed project with compact receipts", async () => {
    const root = dir();
    writeFileSync(path.join(root, "movie-studio.json"), "{}");
    const definitions = new Map<string, any>(),
      receipt = {
        changedShotIds: ["shot"],
        changes: [{ field: "caption.text", before: "Old", after: "New" }],
      };
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          document: {
            revision: 8,
            contentRevision: 4,
            editHistory: { undoCount: 1, redoCount: 0 },
          },
          receipt,
        }),
      });
    installProjectToolPolicy(
      {
        tools: {
          guard: () => {},
          register: (d: any) => definitions.set(d.name, d),
        },
        on: () => {},
      },
      root,
      {
        OD_DSH_TOOL_POLICY: "project",
        OD_DAEMON_URL: "http://127.0.0.1:7456",
        OD_PROJECT_ID: "fixed",
      },
      fetcher,
    );
    const args = {
      expectedRevision: 7,
      operations: [
        {
          op: "update-caption",
          shotId: "shot",
          captionId: "c",
          changes: { text: "New" },
        },
      ],
    };
    const result = JSON.parse(
      await definitions.get("fantay_movie_edit").execute(args, {}),
    );
    expect(result.receipt).toEqual(receipt);
    expect(result.document).toBeUndefined();
    expect(fetcher.mock.calls[0]![0]).toContain("/fixed/movie/edits");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(args);
    await definitions
      .get("fantay_movie_history")
      .execute({ expectedRevision: 8, direction: "undo" }, {});
    expect(fetcher.mock.calls[1]![0]).toContain("/fixed/movie/history/undo");
    expect(
      projectToolDenial(
        root,
        { name: "read", arguments: { file_path: "movie-studio.json" } },
        true,
      ),
    ).toContain("fantay_movie_get");
  });
  it("routes original authoring and its guide to the fixed project without granting shell execution", async () => {
    const root = dir();
    writeFileSync(path.join(root, "movie-studio.json"), "{}");
    const definitions = new Map<string, any>();
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        document: {
          revision: 3,
          contentRevision: 2,
          style: { id: "ai-test", name: "Original" },
          shots: [
            {
              id: "a",
              title: "Action",
              direction: "Parts assemble",
              duration: 4,
              visual: { layers: [{}] },
            },
          ],
        },
      }),
    });
    installProjectToolPolicy(
      {
        tools: {
          guard: () => {},
          register: (d: any) => definitions.set(d.name, d),
        },
        on: () => {},
      },
      root,
      {
        OD_DSH_TOOL_POLICY: "project",
        OD_DAEMON_URL: "http://127.0.0.1:7456",
        OD_PROJECT_ID: "fixed-film",
      },
      fetcher,
    );
    const args = {
      expectedRevision: 2,
      shots: { mode: "replace", items: [{ id: "a" }] },
    };
    const result = JSON.parse(
      await definitions.get("fantay_movie_author").execute(args, {}),
    );
    expect(result.revision).toBe(3);
    expect(result.shots[0].layers).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7456/api/projects/fixed-film/movie/author",
      expect.objectContaining({ method: "POST", body: JSON.stringify(args) }),
    );
    await definitions.get("fantay_movie_guide").execute({}, {});
    expect(fetcher.mock.calls.at(-1)![0]).toContain(
      "/fixed-film/movie/authoring-guide",
    );
    expect(
      projectToolDenial(root, { name: "bash", arguments: {} }, true),
    ).toBeTruthy();
  });
  it("updates story text without replacing animation data or accepting approval fields", async () => {
    const root = dir();
    writeFileSync(path.join(root, "movie-studio.json"), "{}");
    const definitions = new Map<string, any>();
    const document = {
      revision: 5,
      contentRevision: 2,
      shots: [
        {
          id: "seed",
          title: "Old",
          body: "",
          duration: 4,
          visual: { layers: [{ keyframes: [{ at: 0 }, { at: 1 }] }] },
        },
      ],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ document }) });
    installProjectToolPolicy(
      {
        tools: {
          guard: () => {},
          register: (d: any) => definitions.set(d.name, d),
        },
        on: () => {},
      },
      root,
      {
        OD_DSH_TOOL_POLICY: "project",
        OD_DAEMON_URL: "http://127.0.0.1:7456",
        OD_PROJECT_ID: "film",
      },
      fetcher,
    );
    await definitions
      .get("fantay_movie_update_story")
      .execute(
        { expectedRevision: 5, shots: [{ id: "seed", title: "New story" }] },
        {},
      );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toContain("/film/movie/edits");
    const saved = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(saved).toEqual({ expectedRevision: 5, label: "Update story", operations: [{ op: "update-shot", shotId: "seed", changes: { title: "New story" } }] });
    await expect(
      definitions.get("fantay_movie_update_story").execute(
        {
          expectedRevision: 5,
          shots: [{ id: "seed", approvedRenderId: "fake" }],
        },
        {},
      ),
    ).rejects.toThrow("Only unique");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("allows local files but denies secrets, traversal, URLs, symlinks, shell and unknown tools", () => {
    const root = dir(),
      outside = dir();
    writeFileSync(path.join(outside, "private.txt"), "private");
    symlinkSync(outside, path.join(root, "escape"));
    expect(projectPathAllowed(root, "notes.txt")).toBe(true);
    writeFileSync(path.join(root, ".env"), "secret");
    symlinkSync(path.join(root, ".env"), path.join(root, "public.txt"));
    symlinkSync(
      path.join(root, "movie-studio.json"),
      path.join(root, "draft.json"),
    );
    expect(projectPathAllowed(root, "public.txt")).toBe(false);
    expect(projectPathAllowed(root, "draft.json")).toBe(false);
    for (const target of [
      "../private.txt",
      root + "-other/file",
      "escape/private.txt",
      ".env",
      "https://example.test/a",
      "~/.ssh/id_rsa",
    ])
      expect(projectPathAllowed(root, target)).toBe(false);
    for (const name of ["bash", "run_code", "web_fetch", "task"])
      expect(
        projectToolDenial(
          root,
          { name, arguments: { command: "anything" } },
          true,
        ),
      ).toBeTruthy();
    expect(
      projectToolDenial(
        root,
        { name: "write", arguments: { file_path: "movie-studio.json" } },
        true,
      ),
    ).toContain("fantay_movie_save");
    for (const file_path of [
      "motion-source/preview/samples/frame.png",
      "movie-exports/delivery.zip",
      "movie-test.mp4",
    ])
      expect(
        projectToolDenial(
          root,
          { name: "write", arguments: { file_path } },
          true,
        ),
      ).toContain("managed by the workbench");
  });
  it("fixes the movie target and refuses approval escalation", async () => {
    const root = dir();
    writeFileSync(path.join(root, "movie-studio.json"), "{}");
    const definitions = new Map<string, any>();
    const guard = vi.fn();
    const on = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ document: { revision: 2 } }),
    });
    installProjectToolPolicy(
      {
        tools: { guard, register: (d: any) => definitions.set(d.name, d) },
        on,
      },
      root,
      {
        OD_DSH_TOOL_POLICY: "project",
        OD_DAEMON_URL: "http://127.0.0.1:7456",
        OD_PROJECT_ID: "fixed-project",
      },
      fetcher,
    );
    expect(on.mock.calls[0]?.[1]()).toBe("rejected");
    expect(
      guard.mock.calls[0]?.[0]({ name: "bash", arguments: {} }),
    ).toBeTruthy();
    await definitions.get("fantay_movie_save").execute(
      {
        document: '{"title":"A"}',
        expected_revision: 1,
        projectId: "other",
        daemonUrl: "https://other.test",
      },
      {},
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7456/api/projects/fixed-project/movie",
      expect.objectContaining({
        method: "PUT",
        redirect: "error",
        body: JSON.stringify({ document: { title: "A" }, expectedRevision: 1 }),
      }),
    );
    expect(definitions.has("render")).toBe(false);
  });
  it("fails closed on a Harness version without the mandatory guard", () => {
    expect(() =>
      installProjectToolPolicy({}, dir(), { OD_DSH_TOOL_POLICY: "project" }),
    ).toThrow("refusing unrestricted");
  });
  it("does not treat an unknown policy as permission to bypass checks", () => {
    expect(() =>
      installProjectToolPolicy({}, dir(), { OD_DSH_TOOL_POLICY: "off" }),
    ).toThrow("refusing unrestricted");
  });
  it("enforces read-only mode by denying file writes, mutating movie tools, and jianying tools", () => {
    const root = dir();
    writeFileSync(path.join(root, "movie-studio.json"), "{}");
    writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
    const definitions = new Map<string, any>();
    const guard = vi.fn();
    const on = vi.fn();
    const promptNote = installProjectToolPolicy(
      {
        tools: { guard, register: (d: any) => definitions.set(d.name, d) },
        on,
      },
      root,
      {
        OD_DSH_TOOL_POLICY: "read-only",
        OD_DAEMON_URL: "http://127.0.0.1:7456",
        OD_PROJECT_ID: "fixed-project",
      },
    );
    expect(promptNote).toContain("read-only mode");
    expect(definitions.has("fantay_movie_get")).toBe(true);
    expect(definitions.has("fantay_movie_save")).toBe(false);
    expect(definitions.has("fantay_movie_edit")).toBe(false);
    expect(definitions.has("fantay_jianying_status")).toBe(false);
    const guardFn = guard.mock.calls[0]?.[0];
    expect(guardFn({ name: "read", arguments: { file_path: "index.html" } })).toBeUndefined();
    expect(guardFn({ name: "write", arguments: { file_path: "index.html" } })).toContain("Read-only permission");
    expect(guardFn({ name: "edit", arguments: { file_path: "index.html" } })).toContain("Read-only permission");
    expect(guardFn({ name: "fantay_movie_save", arguments: {} })).toContain("Read-only permission");
    expect(guardFn({ name: "fantay_jianying_status", arguments: {} })).toBeTruthy();
  });
  it("enforces workspace-write mode by allowing in-project edits while blocking jianying and external paths", () => {
    const root = dir();
    writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
    const definitions = new Map<string, any>();
    const guard = vi.fn();
    const on = vi.fn();
    installProjectToolPolicy(
      {
        tools: { guard, register: (d: any) => definitions.set(d.name, d) },
        on,
      },
      root,
      { OD_DSH_TOOL_POLICY: "workspace-write" },
    );
    expect(definitions.has("fantay_jianying_status")).toBe(false);
    const guardFn = guard.mock.calls[0]?.[0];
    expect(guardFn({ name: "write", arguments: { file_path: "index.html" } })).toBeUndefined();
    expect(guardFn({ name: "edit", arguments: { file_path: "index.html" } })).toBeUndefined();
    expect(guardFn({ name: "write", arguments: { file_path: "../outside.html" } })).toContain("current project");
    expect(guardFn({ name: "fantay_jianying_status", arguments: {} })).toBeTruthy();
    expect(guardFn({ name: "bash", arguments: {} })).toBeTruthy();
  });
});
