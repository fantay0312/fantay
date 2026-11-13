import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  createMovieDocument,
  MOVIE_STYLES,
  type MovieAction,
  type MovieDocument,
  movieEditingSkill,
  isHtmlRenderer,
} from "@open-design/contracts";
import { resolveDaemonUrl } from "../daemon-url.js";
import { movieWorkspaceUrl } from "./movie-links.js";
import { agentMovieSource } from "./audio-peaks.js";

export async function movieHttp(
  base: string,
  projectId: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ document: MovieDocument }> {
  const response = await fetch(
    `${base}/api/projects/${encodeURIComponent(projectId)}/movie${body && typeof body === "object" && "action" in body ? "/actions" : ""}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const result = (await response.json()) as {
    document: MovieDocument;
    error?: { message?: string } | string;
  };
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : (result.error?.message ?? `HTTP ${response.status}`),
    );
  return result;
}
export async function importMovieVideo(
  base: string,
  projectId: string,
  assetId: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(
    `${base}/api/library/assets/${encodeURIComponent(assetId)}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ projectId, dir: "video-sources" }),
    },
  );
  const applied = (await response.json()) as { relPath?: string };
  if (!response.ok || !applied.relPath)
    throw new Error("Could not copy the library video");
  const current = (await movieHttp(base, projectId, "GET", undefined, headers))
    .document;
  const linked = await fetch(
    `${base}/api/projects/${encodeURIComponent(projectId)}/movie/sources`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        assetId,
        path: applied.relPath,
        expectedRevision: current.revision,
      }),
    },
  );
  const result = (await linked.json()) as Record<string, unknown>;
  if (!linked.ok) throw new Error(JSON.stringify(result));
  return result;
}
const USAGE = `od movie <command> --project <id> [--json]

Commands:
  integration                         Inspect local preview capabilities and MCP configuration
  styles                              List built-in styles
  skill                               Export the current edit as a reusable SKILL.md recipe
  create --name <title>                Create a movie project
  get                                 Read the current document and revision
  save --file <JSON|->                 Save a document using its revision
  author --file <JSON|->               Author original scenes with revision checks
  guide                               Read the original-animation language
  render-preview                      Render a draft without approving or delivering; --file <path|-> sets export format, dimensions and frameRate
  import-generated --run <id> --asset <id> --session-file <path>  Import an owned TokenToSea result
  edit --file <JSON|->                 Apply a localized edit batch and return its changes
  undo | redo                         Restore one content edit (never approvals)
  sources                             Inspect imported footage and representative frames
  import-video --asset <id>            Copy a library video into this film
  upload-video --file <MP4|MOV|WebM>    Upload a local video to the library and import it
  upload-media --file <path>          Import local video, audio or an image into the editor
  initialize                          Import a former native timeline in place, preserving its original
  transcribe --asset <id> [--language zh] Transcribe source speech locally
  approve-storyboard | approve-samples Confirm the current edit
  save-style | render | approve-review | deliver
  wait                                Wait up to 25 seconds for the current render
  authorize-auto | produce | wait-auto Enable one-pass production, start it, or wait
  add-note --text <text> --time <sec> [--render <id>]
  review-assets --render <id>          Generate version-specific timeline media
  review-submit --notes <id,id> [--render <id>] [--request-id <id>]
  feedback-prompt --notes <id,id>     Prepare live feedback for any agent (no render or approval)
  add-note supports --scope time|range|film|shot, --end-time, --shot, --draft
  resolve-note --note <id>
  open                                Return the film's workspace URL
  mcp                                 Run the desktop MCP bridge over stdio

Options: --html-renderer electron|framevelo (render/render-preview), --daemon-url <url>, --web-url <url>, --workspace <id>,
--workspace-member <id>, --prompt-file <path|->, --mode library|remix|personal|blank,
--style <id>. All changes use the same revision-checked HTTP API as the UI.
`;

export async function resolveMovieWebUrl(
  base: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit.replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/mcp/install-info`, {
      signal: AbortSignal.timeout(3000),
    });
    const info = (await response.json()) as { webBaseUrl?: string | null };
    if (response.ok && info.webBaseUrl)
      return info.webBaseUrl.replace(/\/$/, "");
  } catch {
    /* Preserve the standalone daemon's own browser surface as fallback. */
  }
  return base;
}

export async function waitForMovieRender(
  base: string,
  projectId: string,
  headers: Record<string, string> = {},
) {
  const deadline = Date.now() + 25_000;
  let snapshot = await movieHttp(base, projectId, "GET", undefined, headers);
  while (
    snapshot.document.renders.at(-1)?.status === "running" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    snapshot = await movieHttp(base, projectId, "GET", undefined, headers);
  }
  return snapshot;
}
export async function runMovie(args: string[]): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        draft: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        ...Object.fromEntries(
          [
            "project",
            "name",
            "file",
            "daemon-url",
            "web-url",
            "workspace",
            "workspace-member",
            "prompt-file",
            "mode",
            "style",
            "text",
            "time",
            "render",
            "note",
            "scope",
            "end-time",
            "shot",
            "content-revision",
            "notes",
            "request-id",
            "asset",
            "run",
            "session-file",
            "language",
            "tool",
            "html-renderer",
          ].map((key) => [key, { type: "string" as const }]),
        ),
      },
    });
    const command = positionals[0];
    if (values.help || !command) {
      process.stdout.write(USAGE);
      return;
    }
    const flags = values as Record<string, string | boolean | undefined>;
    if (flags['html-renderer'] !== undefined && (!['render', 'render-preview'].includes(command) || !isHtmlRenderer(flags['html-renderer']))) {
      throw new Error('--html-renderer requires render/render-preview and must be electron or framevelo');
    }
    const base = await resolveDaemonUrl({
      flagUrl: (flags["daemon-url"] as string) ?? null,
    });
    const web = await resolveMovieWebUrl(
      base,
      flags["web-url"] as string | undefined,
    );
    const headers: Record<string, string> = {};
    if (flags.workspace) headers["x-od-workspace-id"] = String(flags.workspace);
    if (flags["workspace-member"])
      headers["x-od-workspace-member-id"] = String(flags["workspace-member"]);
    const readInput = async (file: string) => {
      if (file !== "-") return readFile(file, "utf8");
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    };
    let result: unknown;
    let projectId =
      (flags.project as string) || process.env.OD_PROJECT_ID || "";
    if (command === "integration") {
      const response = await fetch(`${base}/api/movie/integration?include=capabilities`, { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Integration status failed: HTTP ${response.status}`);
      result = await response.json();
    } else if (command === "styles") result = { styles: MOVIE_STYLES };
    else if (command === "mcp") {
      const { startMovieMcp } = await import("./movie-mcp.js");
      await startMovieMcp(base, web, headers);
      return;
    } else if (command === "create") {
      const name = String(flags.name || "Untitled movie");
      const mode = String(flags.mode ?? "library");
      if (!["library", "remix", "personal", "blank"].includes(mode))
        throw new Error("Invalid start mode");
      const brief = flags["prompt-file"]
        ? await readInput(String(flags["prompt-file"]))
        : "";
      const response = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          id: randomUUID(),
          name,
          skillId: "fantay-movie",
          designSystemId: "fantay",
          metadata: {
            kind: "video",
            intent: "motion-design",
            videoModel: "hyperframes-html",
          },
        }),
      });
      const created = (await response.json()) as {
        project: { id: string };
        conversationId: string;
        error?: { message?: string } | string;
      };
      if (!response.ok)
        throw new Error(
          typeof created.error === "string"
            ? created.error
            : (created.error?.message ?? `HTTP ${response.status}`),
        );
      projectId = created.project.id;
      const doc = createMovieDocument(
        name,
        mode as MovieDocument["startMode"],
        MOVIE_STYLES.find((s) => s.id === flags.style),
      );
      doc.brief = brief;
      result = {
        ...created,
        ...(await movieHttp(
          base,
          projectId,
          "PUT",
          { expectedRevision: 0, document: doc },
          headers,
        )),
        url: movieWorkspaceUrl(web, projectId),
      };
    } else {
      if (!projectId) throw new Error("--project or OD_PROJECT_ID is required");
      if (command === "open")
        result = {
          projectId,
          url: movieWorkspaceUrl(web, projectId),
        };
      else if (["native-open","native-status","native-tools","native-call"].includes(command)) {
        const suffix=command==='native-status'?'/native':command==='native-open'?'/native/open':'/native/call';
        const args=command==='native-call'?JSON.parse(await readInput(String(flags.file??'-'))):{};
        const response=await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/movie${suffix}`,{method:command==='native-status'?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(command==='native-status'?{}:{body:JSON.stringify(command==='native-tools'?{tool:'tools/list'}:command==='native-call'?{tool:flags.tool,arguments:args}:{})})});
        result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));
      }
      else if (command === "get")
        result = await movieHttp(base, projectId, "GET", undefined, headers);
      else if (command === 'initialize') {
        const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/movie/editor/initialize`, { method: 'POST', headers });
        result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
      }
      else if (command === 'upload-media') {
        const file = String(flags.file ?? ''), bytes = await readFile(file);
        if (bytes.length > 256 * 1024 * 1024) throw new Error('Choose media under 256 MiB');
        const doc = (await movieHttp(base, projectId, 'GET', undefined, headers)).document;
        const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/movie/editor/media?revision=${doc.revision}&filename=${encodeURIComponent(file.split(/[\\/]/).pop() ?? 'media')}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
        result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
      }
      else if (command === "edit" || command === "undo" || command === "redo") {
        const body =
          command === "edit"
            ? JSON.parse(await readInput(String(flags.file ?? "-")))
            : {
                expectedRevision: (
                  await movieHttp(base, projectId, "GET", undefined, headers)
                ).document.revision,
              };
        const response = await fetch(
          `${base}/api/projects/${encodeURIComponent(projectId)}/movie/${command === "edit" ? "edits" : `history/${command}`}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
          },
        );
        result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
      } else if (command === "wait")
        result = await waitForMovieRender(base, projectId, headers);
      else if (command === "upload-video") {
        const file = String(flags.file ?? "");
        if (!/\.(mp4|webm|mov)$/i.test(file))
          throw new Error("Choose MP4, MOV or WebM");
        const bytes = await readFile(file);
        if (bytes.length > 256 * 1024 * 1024)
          throw new Error("Video exceeds 256 MiB");
        const response = await fetch(
          `${base}/api/library/videos?filename=${encodeURIComponent(file.split(/[\\/]/).at(-1)!)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", ...headers },
            body: bytes,
          },
        );
        const uploaded = (await response.json()) as { asset?: { id: string } };
        if (!response.ok || !uploaded.asset)
          throw new Error("Video upload failed");
        result = await importMovieVideo(
          base,
          projectId,
          uploaded.asset.id,
          headers,
        );
      } else if (command === "import-video")
        result = await importMovieVideo(
          base,
          projectId,
          String(flags.asset ?? ""),
          headers,
        );
      else if (command === "skill") {
        const current = (await movieHttp(base, projectId, "GET", undefined, headers)).document;
        result = { filename: "SKILL.md", content: movieEditingSkill(current) };
      }
      else if (command === "import-generated") {
        const current = (await movieHttp(base, projectId, "GET", undefined, headers)).document;
        const session = (await readFile(String(flags["session-file"] ?? ""), "utf8")).trim();
        if (!/^[\w-]{43}$/.test(session)) throw new Error("Provide a local file containing the TokenToSea session ID");
        const response = await fetch(`${base}/api/tokentosea/movie/import`, {
          method: "POST", headers: { ...headers, "Content-Type": "application/json", Cookie: `fantay_identity=${session}`, Origin: web },
          body: JSON.stringify({ projectId, runId: flags.run, assetId: flags.asset, expectedRevision: current.revision }),
        });
        result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
      }
      else if (command === "sources" || command === "transcribe") {
        const response = await fetch(
          `${base}/api/projects/${encodeURIComponent(projectId)}/movie/${command}`,
          {
            method: command === "sources" ? "GET" : "POST",
            headers: { "Content-Type": "application/json", ...headers },
            ...(command === "transcribe"
              ? {
                  body: JSON.stringify({
                    assetId: flags.asset,
                    language: flags.language ?? "auto",
                  }),
                }
              : {}),
          },
        );
        const payload = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new Error(JSON.stringify(payload));
        // Same HTTP route as the timeline; the printed copy carries a pooled waveform.
        result = command === "transcribe"
          ? agentMovieSource(payload)
          : Array.isArray(payload.sources)
            ? { ...payload, sources: payload.sources.map(agentMovieSource) }
            : payload;
      } else if (command === "review-assets" || command === "review-submit" || command === "feedback-prompt") {
        const current = (
          await movieHttp(base, projectId, "GET", undefined, headers)
        ).document;
        const renderId = String(
          flags.render ?? current.renders.at(-1)?.id ?? "",
        );
        const response = await fetch(
          `${base}/api/projects/${encodeURIComponent(projectId)}/movie/${command}${command === "review-assets" ? `?renderId=${encodeURIComponent(renderId)}` : ""}`,
          {
            method: command === "review-assets" ? "GET" : "POST",
            headers: { "Content-Type": "application/json", ...headers },
            ...(command !== "review-assets"
              ? {
                  body: JSON.stringify({
                    requestId: String(flags["request-id"] ?? randomUUID()),
                    expectedRevision: current.revision,
                    noteIds: String(flags.notes ?? "")
                      .split(",")
                      .filter(Boolean),
                    ...(flags.render ? { sourceRenderId: renderId } : {}),
                  }),
                }
              : {}),
          },
        );
        result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
      } else if (["authorize-auto", "produce", "wait-auto"].includes(command)) {
        const current = (
          await movieHttp(base, projectId, "GET", undefined, headers)
        ).document;
        const suffix =
          command === "authorize-auto"
            ? "authorize"
            : command === "produce"
              ? "start"
              : "wait";
        const response = await fetch(
          `${base}/api/projects/${encodeURIComponent(projectId)}/movie/production/${suffix}`,
          {
            method: command === "wait-auto" ? "GET" : "POST",
            headers: { "Content-Type": "application/json", ...headers },
            ...(command === "wait-auto"
              ? {}
              : {
                  body: JSON.stringify({
                    expectedRevision: current.revision,
                    enabled: command === "authorize-auto",
                  }),
                }),
          },
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(payload));
        result = payload;
      } else if (command === "author" || command === "guide") {
        if (command === "author" && !flags.file)
          throw new Error("--file is required");
        const body =
          command === "author"
            ? JSON.parse(await readInput(String(flags.file)))
            : undefined;
        const response = await fetch(
          `${base}/api/projects/${encodeURIComponent(projectId)}/movie/${command === "guide" ? "authoring-guide" : "author"}`,
          {
            method: command === "guide" ? "GET" : "POST",
            headers: { "Content-Type": "application/json", ...headers },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
        result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
      } else if (command === "save") {
        if (!flags.file) throw new Error("--file is required");
        const input = JSON.parse(await readInput(String(flags.file)));
        const doc = input.document ?? input;
        result = await movieHttp(
          base,
          projectId,
          "PUT",
          { expectedRevision: doc.revision, document: doc },
          headers,
        );
      } else {
        const current = (
          await movieHttp(base, projectId, "GET", undefined, headers)
        ).document;
        let action: MovieAction;
        if (command === "add-note")
          action = {
            action: command,
            ...(!flags.draft && flags.scope !== "shot"
              ? {
                  renderId: String(
                    flags.render || current.renders.at(-1)?.id || "",
                  ),
                }
              : flags.render
                ? { renderId: String(flags.render) }
                : {}),
            ...(flags.scope
              ? {
                  scope: String(flags.scope) as
                    | "time"
                    | "range"
                    | "film"
                    | "shot",
                }
              : {}),
            ...(flags["end-time"]
              ? { endTime: Number(flags["end-time"]) }
              : {}),
            ...(flags.shot ? { shotId: String(flags.shot) } : {}),
            contentRevision: current.contentRevision,
            time: Number(flags.time || 0),
            text: String(flags.text || ""),
          };
        else if (command === "resolve-note")
          action = {
            action: command,
            noteId: String(flags.note || ""),
            ...(flags.render ? { renderId: String(flags.render) } : {}),
          };
        else if (
          [
            "approve-storyboard",
            "approve-samples",
            "save-style",
            "render",
            "render-preview",
            "approve-review",
            "deliver",
          ].includes(command)
        )
          action = { action: command, ...(flags['html-renderer'] ? { htmlRenderer: flags['html-renderer'] } : {}),
            ...(['render', 'render-preview'].includes(command) && flags.file ? { exportOptions: JSON.parse(await readInput(String(flags.file))) } : {}) } as MovieAction;
        else throw new Error(`Unknown command: ${command}`);
        result = await movieHttp(
          base,
          projectId,
          "POST",
          { ...action, expectedRevision: current.revision },
          headers,
        );
      }
    }
    if (
      result &&
      typeof result === "object" &&
      "document" in result &&
      projectId
    ) {
      const document = (result as { document: MovieDocument }).document;
      const links: Record<string, string> = {
        url: movieWorkspaceUrl(web, projectId),
      };
      const render = [...document.renders]
        .reverse()
        .find((render) => render.status === "done" && render.file);
      if (render?.file)
        links.videoUrl = `${web}/api/projects/${encodeURIComponent(projectId)}/raw/${encodeURIComponent(render.file)}`;
      if (document.delivery)
        links.deliveryUrl = `${web}/api/projects/${encodeURIComponent(projectId)}/movie/delivery`;
      result = { ...result, ...links };
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "MOVIE_ERROR", message: error instanceof Error ? error.message : String(error) } })}\n`,
    );
    process.exitCode = 1;
  }
}
