import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveDaemonUrl } from "../daemon-url.js";
import { callPaDevice, readPaDeviceRequest } from "./personal-agent-device-cli.js";
import { readPrivatePaFile, trustedPaUrl } from "./pa/config.js";
import { basename } from "node:path";
import { inflateRawSync } from "node:zlib";

/** `od pa …` as the command line runs it: a refusal or a bad argument prints its message on stderr (with --json, as
 *  `{ ok: false, error: { message } }`) and sets exit code 1, instead of a stack trace. */
export async function runPersonalAgentCommand(args: string[]): Promise<void> {
  try {
    await runPersonalAgent(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(args.includes("--json") ? `${JSON.stringify({ ok: false, error: { message } })}\n` : `${message}\n`);
    process.exitCode = 1;
  }
}

export async function runPersonalAgent(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean" },
      "daemon-url": { type: "string" },
      device: { type: "string" },
      remote: { type: "boolean" },
      "script-file": { type: "string" },
      "generate-script": { type: "boolean" },
      "gateway-model": { type: "string" },
      "access-token-file": { type: "string" },
      controller: { type: "string" },
      "worker-token-file": { type: "string" },
      "worker-sandbox-file": { type: "string" },
      file: { type: "string" },
      "prompt-file": { type: "string" },
      prompt: { type: "string" },
      conversation: { type: "string" },
      target: { type: "string" },
      project: { type: "boolean" },
      team: { type: "boolean" },
      name: { type: "string" },
      "request-id": { type: "string" },
      'project-id': { type: 'string' },
      'local-only': { type: 'boolean' },
      'criterion': { type: 'string', multiple: true },
      'cost-limit': { type: 'string' },
      revision: { type: "string" },
      card: { type: "string" }, portrait: { type: "string" }, agent: { type: "string" },
      notation: { type: "string" }, label: { type: "string" }, dc: { type: "string" }, deck: { type: "string" },
      action: { type: "string" }, message: { type: "string" }, greeting: { type: "string" },
      directive: { type: "string" }, png: { type: "string" },
      out: { type: "string" }, follow: { type: "boolean" }, model: { type: "string" },
      voice: { type: "string" }, language: { type: "string" }, charx: { type: "string" },
      forget: { type: "boolean" }, quarantine: { type: "boolean" }, "no-respond": { type: "boolean" },
      offset: { type: 'string' }, limit: { type: 'string' }, query: { type: 'string' },
      domain: { type: 'string' }, 'scope-id': { type: 'string' },
      'target-domain': { type: 'string' }, 'target-scope-id': { type: 'string' },
      'budget-bytes': { type: 'string' },
    },
  });
  const [command = "status", id] = positionals;
  if (values.help || command === "help") {
    console.log(`od pa <command> [id] --json
  status | task <id> | models | node | audit
  agent-create | agent-update <id> | agent-clone <id>
  group-create | group-update <id>
  conversation-create --file <JSON|->
  projects
  submit --conversation <id> --prompt-file <path|-> [--target <id,id>] [--project --name <name>] [--project-id <id>] [--local-only] [--criterion <text>] [--cost-limit <USD>]
  submit --conversation <id> --team --prompt-file <path|->
  amend <task> --prompt-file <path|-> --revision <number>
  task-answer <task> --file <JSON|->     Answer the current view or question card
  cancel <task> | resume <task> | events <task>
  reconcile <task> [--file <JSON|->]     Query evidence, or confirm stopped with revision/note
  memory-create | memory-update <id> | memory-delete <id> | memory-list
  memory-history <id> | memory-candidate-resolve <id> --file <JSON|->
  memory-promote <id> --target-domain project|private [--target-scope-id <id>]
  memory-search --query <text> | --prompt-file <path|-> | memory-reindex | memory-ledger
  control | control-update --file <JSON|->
  routine-save [id] --file <JSON|->     Daily routine; "soul": {"kind":"reachout"} lets a character speak first
  routine-run <id> --revision N | routine-remove <id> --revision N
  channels | local-feishu-apps | channel-create | channel-update <id>
  channel-bind-chat <id> --file <JSON|->
  channel-remove <id>
  channel-feishu <id> --file <JSON|->     Write-only credentials or localAppId
  channel-im <id> --file <JSON|->         Write-only credentials for the channel's platform
  channel-connect <id> | channel-disconnect <id> | channel-pair <id>
  channel-feishu-create <id> | channel-feishu-status <id> | channel-feishu-cancel <id>
  channel-login <id> | channel-login-status <id> | channel-login-pin <id> --file <JSON|->
  inbox-approve <id> --file <JSON|-> | outbox-resolve <id> --file <JSON|->
  output <attempt> [--offset N --limit N --query text]
  artifact-download <id> [--json]
  artifact-merge <task> --file <JSON|->
  submit ... [--script-file <path|-> | --generate-script] [--remote] [--gateway-model <approved-id>]
  submit ... --remote                 Dispatch inference to an eligible Ollama worker
  migrate <task> --file <JSON|->      Move an active lease with workerId and revision
  worker --controller <origin> --worker-token-file <path> [--worker-sandbox-file <path>]
  mode | audit-verify --file <JSON|-> | revoke --file <JSON|->
  org-status | org-sync               Organization server this daemon follows: last sync, sync now
  provision-token --file <new path>
Create/update commands accept --file <JSON|->. Updates require revision in JSON.
Enterprise access reads --access-token-file or OD_PA_ACCESS_TOKEN_FILE.
All commands support --daemon-url <url>; submit supports --request-id for deduplication.
Use --device <SSH alias> with status, task, submit, resume or cancel to access the same task host.
Soul (companion chats, characters and world books; local daemon only):
  soul
  starter-install <id>
  chat <conversation> --prompt <text> | --prompt-file <path|-> [--target <id,id>]
  regenerate <message> --conversation <id>
  continue <conversation> [--agent <id>] [--directive reachout]
  roll <conversation> --notation d20+2 [--label <text>] [--dc N] [--no-respond]
  draw <conversation> --deck <id> [--no-respond]
  event <conversation> --action draw|accept|skip|stop [--no-respond]
  preview <conversation> [--prompt <draft>] [--agent <id>]
  branch <conversation> --message <id>
  variant <root> --message <id> | --greeting N
  trace <message>
  reveal <message>
  message-edit <message> --file <JSON|->
  message-delete <message> --revision N [--forget]
  character-save <agent> --file <JSON|->
  character-remove <agent> --revision N [--forget]
  character-import --card <card.json|card.png|card.charx> [--portrait <image>] [--agent <id> [--revision N]]
  character-export <agent> [--quarantine] [--png <out.png> | --charx <out.charx>]
                                          --charx packs the card with its portrait and sprites
  chat-settings <conversation> --file <JSON|->
  chat-state --file <JSON|->
  live <conversation> [--follow]          The running reply's text so far; --follow streams it until the turn ends
  speech-status | speech-voices --model <id>
  speech-list <conversation>
  speak <message> [--out <file>]          Read a reply aloud with its character's voice (generated once, then cached)
  speech-preview --model <id> [--voice <id>] [--language <zh|en|ja>] [--prompt <text>] [--out <file>]
                                          Hear a voice before saving it: reads a short line (a sample when no text)
  asset-upload --file <image>             PNG, JPEG or WebP; prints { id } for portraitAssetId or sprites
  lorebook <id>
  lorebook-export <id>
  lorebook-test --file <JSON|->
  lorebook-import --file <world.json> [--name <name>] [--agent <id>]
  lorebook-save | persona-save | preset-save [id] --file <JSON|->
  lorebook-remove | persona-remove | preset-remove <id> --revision N`);
    return;
  }
  if (command === "provision-token") {
    if (!values.file || values.file === "-") throw new Error("A new private token file is required");
    const token = randomBytes(32).toString("base64url");
    await writeFile(values.file, `${token}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ tokenSha256: createHash("sha256").update(token).digest("hex") }));
    return;
  }
  if (command === "worker") {
    if (!values.controller || !values["worker-token-file"]) throw new Error("A controller and worker token file are required");
    const { runPaWorker } = await import("./pa/worker.js");
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runPaWorker({
        controller: values.controller, tokenFile: values["worker-token-file"], signal: abort.signal,
        dataDir: process.env.OD_DATA_DIR ?? process.cwd(),
        ...(values["worker-sandbox-file"] ? { sandboxConfig: values["worker-sandbox-file"] } : {}),
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  if ([values.file, values["prompt-file"], values["script-file"]].filter(value => value === "-").length > 1)
    throw new Error("Only one input can read stdin");
  const read = async (file: string) =>
    file === "-"
      ? await new Promise<string>((resolve, reject) => {
          let text = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => (text += chunk));
          process.stdin.on("end", () => resolve(text));
          process.stdin.on("error", reject);
        })
      : readFile(file, "utf8");
  // asset-upload's --file is an image, read as bytes below.
  const payload = values.file && command !== "asset-upload" ? JSON.parse(await read(values.file)) : undefined;
  const prompt = values["prompt-file"]
    ? await read(values["prompt-file"])
    : values.prompt;
  const script = values["script-file"] ? await read(values["script-file"]) : undefined;
  if (command === "device-rpc") {
    const request = await readPaDeviceRequest();
    const base = new URL(await resolveDaemonUrl({ flagUrl: null }));
    if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash)
      throw new Error("The PA device host requires a loopback Fantay daemon");
    const result = await fetch(`${base.origin}/api/pa/device${request.endpoint}`, {
      method: request.method,
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    console.log(await result.text());
    return;
  }
  let method = "GET",
    endpoint = "",
    body: unknown;
  /** Requests that must run before the main one (CHARX sprites are saved as assets first). */
  let prepare: ((call: PaCliCall) => Promise<void>) | undefined;
  const routes: Record<string, [string, string]> = {
    "agent-create": ["POST", "/agents"],
    "agent-update": ["PATCH", "/agents/:id"],
    "agent-clone": ["POST", "/agents/:id/clone"],
    "group-create": ["POST", "/groups"],
    "group-update": ["PATCH", "/groups/:id"],
    "conversation-create": ["POST", "/conversations"],
    "memory-create": ["POST", "/memories"],
    "memory-update": ["PATCH", "/memories/:id"],
    "memory-delete": ["DELETE", "/memories/:id"],
    "memory-history": ["GET", "/memories/:id/history"],
    "memory-candidate-resolve": ["POST", "/memory-candidates/:id/resolve"],
    cancel: ["POST", "/tasks/:id/cancel"],
    resume: ["POST", "/tasks/:id/resume"],
    reconcile: ['POST', '/tasks/:id/reconcile'],
    events: ["GET", "/tasks/:id/events"],
    task: ["GET", "/tasks/:id"],
    "artifact-download": ["GET", "/artifacts/:id/download"],
    "artifact-merge": ["POST", "/tasks/:id/merge"],
    migrate: ["POST", "/tasks/:id/migrate"],
    "audit-verify": ["POST", "/audit/verify"],
    revoke: ["POST", "/enterprise/revoke"],
    "org-status": ["GET", "/enterprise/org"], "org-sync": ["POST", "/enterprise/org/sync"],
    control: ['GET', '/control'], 'control-update': ['PATCH', '/control'],
    projects: ['GET', '/projects'],
    channels: ['GET', '/channels'], 'local-feishu-apps': ['GET', '/channels/local-feishu-apps'],
    'channel-create': ['POST', '/channels'], 'channel-update': ['PATCH', '/channels/:id'],
    'channel-bind-chat': ['POST', '/channels/:id/bindings'],
    'channel-remove': ['DELETE', '/channels/:id'],
    'channel-feishu': ['POST', '/channels/:id/feishu'], 'channel-connect': ['POST', '/channels/:id/connect'],
    'channel-im': ['POST', '/channels/:id/im'],
    'channel-feishu-create': ['POST', '/channels/:id/feishu-registration'],
    'channel-feishu-status': ['GET', '/channels/:id/feishu-registration'],
    'channel-feishu-cancel': ['DELETE', '/channels/:id/feishu-registration'],
    'channel-disconnect': ['POST', '/channels/:id/disconnect'], 'channel-pair': ['POST', '/channels/:id/pair'],
    'channel-login': ['POST', '/channels/:id/login'], 'channel-login-status': ['GET', '/channels/:id/login'],
    'channel-login-pin': ['POST', '/channels/:id/login/pin'], 'inbox-approve': ['POST', '/channels/inbox/:id/approve'],
    'outbox-resolve': ['POST', '/channels/outbox/:id/resolve'],
    'task-answer': ['POST', '/tasks/:id/answer'],
    soul: ["GET", "/soul"],
    "character-save": ["PUT", "/soul/characters/:id"],
    "starter-install": ["POST", "/soul/starters/:id/install"],
    lorebook: ["GET", "/soul/lorebooks/:id"],
    "lorebook-export": ["GET", "/soul/lorebooks/:id/export"],
    "lorebook-test": ["POST", "/soul/lorebooks/test"],
    "chat-settings": ["PUT", "/soul/chats/:id"],
    "chat-state": ["POST", "/soul/chat/state"],
    "message-edit": ["PATCH", "/soul/messages/:id"],
    reveal: ["POST", "/soul/messages/:id/reveal"],
    trace: ["GET", "/soul/trace/:id"],
    "speech-status": ["GET", "/soul/speech/status"],
  };
  const soulTable = new Set(["soul", "character-save", "starter-install", "lorebook", "lorebook-export", "lorebook-test",
    "chat-settings", "chat-state", "message-edit", "reveal", "trace", "speech-status"]);
  const soulCommands = new Set(["chat", "regenerate", "continue", "roll", "draw", "event", "preview", "branch", "variant",
    "message-delete", "character-remove", "lorebook-remove", "persona-remove", "preset-remove", "lorebook-save",
    "persona-save", "preset-save", "lorebook-import", "character-import", "character-export",
    "live", "speech-voices", "speech-list", "speak", "speech-preview", "asset-upload"]);
  if (values.device && (soulTable.has(command) || soulCommands.has(command)))
    throw new Error("Soul commands need the local Fantay daemon");
  if (
    command === "memory-list" ||
    command === "memory-promote" ||
    command === "memory-search" ||
    command === "memory-reindex" ||
    command === "memory-ledger"
  ) {
    const { runMemoryCenterCli } = await import("./memory-center-cli.js");
    const mappedSub = command.slice("memory-".length);
    const forwarded = [mappedSub, ...args.slice(1)];
    await runMemoryCenterCli(forwarded);
    return;
  }
  if (routes[command]) {
    [method, endpoint] = routes[command]!;
    if (endpoint.includes(":id") && !id) throw new Error("An id is required");
    endpoint = endpoint.replace(":id", encodeURIComponent(id ?? ""));
    body = payload;
  } else if (command === 'output' && id) {
    endpoint = `/attempts/${encodeURIComponent(id)}/output?${new URLSearchParams({ offset: values.offset ?? '0', limit: values.limit ?? '16000', q: values.query ?? '' })}`;
  } else if (command === "models" || command === "node" || command === "audit" || command === "mode")
    endpoint = `/${command}`;
  else if (command === "submit") {
    method = "POST";
    endpoint = "/tasks";
    if (values["cost-limit"] !== undefined && !/^\d+(?:\.\d{1,6})?$/.test(values["cost-limit"]))
      throw new Error("Enter the cost limit in USD");
    if (values.team && values.project) throw new Error("Choose either --team or --project");
    body = {
      requestId: values["request-id"] ?? randomUUID(),
      conversationId: values.conversation,
      goal: prompt,
      targetAgentIds: values.target?.split(",") ?? [],
      kind: values.team ? "team" : values.project ? "project" : "discussion",
      projectName: values.name,
      ...(values["local-only"] ? { dataClass: "local_only" } : {}),
      ...(values.remote || script !== undefined || values["generate-script"] || values["gateway-model"] ? { execution: {
        target: values.remote ? "worker" : "local", ...(script !== undefined ? { script } : {}),
        ...(values["generate-script"] ? { generateScript: true } : {}),
        ...(values["gateway-model"] ? { gatewayModel: values["gateway-model"] } : {}),
      } } : {}),
      ...(values.criterion ? { completionCriteria: values.criterion } : {}),
      ...(values["cost-limit"] !== undefined ? { budget: { maxCostUsd: Number(values["cost-limit"]) } } : {}),
      ...(values['project-id'] ? { projectId: values['project-id'] } : {}),
    };
  } else if (command === "amend" && id) {
    method = "POST";
    endpoint = `/tasks/${encodeURIComponent(id)}/amend`;
    body = { content: prompt, revision: Number(values.revision) };
  } else if (command === "routine-save") {
    if (payload === undefined) throw new Error("--file is required");
    method = id ? "PATCH" : "POST";
    endpoint = id ? `/routines/${encodeURIComponent(id)}` : "/routines";
    body = payload;
  } else if (command === "routine-run" || command === "routine-remove") {
    if (!id) throw new Error("An id is required");
    const revision = payload?.revision ?? Number(values.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("--revision must be a positive integer");
    method = command === "routine-run" ? "POST" : "DELETE";
    endpoint = `/routines/${encodeURIComponent(id)}${command === "routine-run" ? "/run" : ""}`;
    body = { revision };
  } else if (soulCommands.has(command)) {
    const need = (value: string | undefined, label: string): string => {
      if (!value) throw new Error(`${label} is required`);
      return value;
    };
    const target = () => encodeURIComponent(need(id, "An id"));
    const revisionValue = () => {
      const value = Number(need(values.revision, "--revision"));
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("--revision must be a positive integer");
      return value;
    };
    const requestId = values["request-id"] ?? randomUUID();
    const respond = !values["no-respond"];
    const collection = command.startsWith("lorebook") ? "lorebooks" : command.startsWith("persona") ? "personas" : "presets";
    method = "POST";
    if (command === "chat") {
      endpoint = "/tasks";
      body = { requestId, conversationId: need(id, "A conversation id"), goal: need(prompt, "--prompt or --prompt-file"), kind: "chat",
        targetAgentIds: values.target?.split(",").filter(Boolean) ?? [] };
    } else if (command === "regenerate") {
      endpoint = "/soul/chat/regenerate";
      body = { conversationId: need(values.conversation, "--conversation"), messageId: need(id, "A message id"), requestId };
    } else if (command === "continue") {
      endpoint = "/soul/chat/continue";
      body = { conversationId: need(id, "A conversation id"), requestId,
        ...(values.agent ? { agentId: values.agent } : {}), ...(values.directive ? { directive: values.directive } : {}) };
    } else if (command === "roll") {
      endpoint = "/soul/chat/roll";
      body = { conversationId: need(id, "A conversation id"), notation: need(values.notation, "--notation"),
        ...(values.label ? { label: values.label } : {}), ...(values.dc ? { dc: Number(values.dc) } : {}), respond, requestId };
    } else if (command === "draw") {
      endpoint = "/soul/chat/draw";
      body = { conversationId: need(id, "A conversation id"), deckId: need(values.deck, "--deck"), respond, requestId };
    } else if (command === "event") {
      endpoint = "/soul/chat/event";
      body = { conversationId: need(id, "A conversation id"), action: need(values.action, "--action"), respond, requestId };
    } else if (command === "preview") {
      endpoint = "/soul/chat/preview";
      body = { conversationId: need(id, "A conversation id"),
        ...(prompt !== undefined ? { draft: prompt } : {}), ...(values.agent ? { agentId: values.agent } : {}) };
    } else if (command === "branch") {
      endpoint = `/soul/conversations/${target()}/branch`;
      body = { messageId: need(values.message, "--message") };
    } else if (command === "variant") {
      endpoint = `/soul/messages/${target()}/variant`;
      if (values.message) body = { messageId: values.message };
      else if (values.greeting !== undefined) body = { greetingIndex: Number(values.greeting) };
      else throw new Error("--message or --greeting is required");
    } else if (command === "message-delete") {
      method = "DELETE";
      endpoint = `/soul/messages/${target()}`;
      body = { revision: revisionValue(), forget: Boolean(values.forget) };
    } else if (command === "character-remove") {
      method = "DELETE";
      endpoint = `/soul/characters/${target()}`;
      body = { revision: revisionValue(), forgetMemories: Boolean(values.forget) };
    } else if (command.endsWith("-remove")) {
      method = "DELETE";
      endpoint = `/soul/${collection}/${target()}`;
      body = { revision: revisionValue() };
    } else if (command.endsWith("-save")) {
      if (payload === undefined) throw new Error("--file is required");
      method = id ? "PATCH" : "POST";
      endpoint = id ? `/soul/${collection}/${encodeURIComponent(id)}` : `/soul/${collection}`;
      body = payload;
    } else if (command === "lorebook-import") {
      if (payload === undefined) throw new Error("--file is required");
      endpoint = "/soul/lorebooks/import";
      body = { world: payload, ...(values.name ? { name: values.name } : {}),
        ...(values.file && values.file !== "-" ? { fileName: basename(values.file) } : {}),
        ...(values.agent ? { agentId: values.agent } : {}) };
    } else if (command === "character-import") {
      const kit = await import("@open-design/contracts/soul");
      const cardPath = need(values.card, "--card");
      const bytes = new Uint8Array(await readFile(cardPath));
      const isPng = imageMime(bytes) === "image/png";
      let card: unknown;
      let archive: Extract<Awaited<ReturnType<typeof kit.readCharx>>, { ok: true }> | null = null;
      if (isPng) {
        const extracted = kit.extractCardJson(bytes);
        if (!extracted.ok) throw new Error(`The PNG holds no readable character card (${extracted.error})`);
        card = extracted.json;
      } else if (kit.isZipLike(bytes)) {
        // CHARX: only card.json and the images the card plans are inflated; the daemon parses the card again.
        const charx = await kit.readCharx(bytes, (data, max) => inflateRawSync(data, { maxOutputLength: max + 1 }),
          { fileName: basename(cardPath), now: Date.now() });
        if (!charx.ok) throw new Error(`The CHARX file cannot be read (${charx.error})`);
        card = charx.card;
        archive = charx;
        for (const item of charx.report)
          if (item.action === "skipped") console.error(`Not imported from the archive: ${item.path} (${item.reason ?? "skipped"})`);
      } else {
        const text = new TextDecoder().decode(bytes);
        card = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      }
      let portrait: { mime: string; data: string } | undefined;
      if (values.portrait) {
        const image = new Uint8Array(await readFile(values.portrait));
        const mime = imageMime(image);
        if (!mime) throw new Error("The portrait must be a PNG, JPEG or WebP image");
        portrait = { mime, data: kit.bytesToBase64(image) };
      } else if (isPng) {
        const stripped = kit.stripPngMetadata(bytes);
        if (stripped.length <= kit.SOUL_LIMITS.assetBytes) portrait = { mime: "image/png", data: kit.bytesToBase64(stripped) };
        else console.error("The card image is larger than the portrait limit; importing without a portrait.");
      } else if (archive) {
        const icon = archive.assets.find(asset => asset.role === "portrait");
        if (icon && icon.data.length <= kit.SOUL_LIMITS.assetBytes) portrait = { mime: icon.mime, data: kit.bytesToBase64(icon.data) };
        else if (icon) console.error(`The portrait ${icon.path} is larger than the image limit; importing without a portrait.`);
      }
      endpoint = "/soul/characters/import";
      body = { card, fileName: basename(cardPath), ...(portrait ? { portrait } : {}), ...(values.agent ? { agentId: values.agent } : {}),
        ...(values.agent && values.revision ? { revision: revisionValue() } : {}) };
      const sprites = archive?.assets.filter(asset => asset.role === "sprite" && asset.emotion) ?? [];
      if (sprites.length) prepare = async (call) => {
        // The CLI does not re-encode images: a sprite over the asset limit is skipped, a refused one is reported.
        const saved: Partial<Record<(typeof kit.PA_EMOTIONS)[number], string>> = {};
        for (const sprite of sprites) {
          if (sprite.data.length > kit.SOUL_LIMITS.assetBytes) {
            console.error(`Sprite ${sprite.path} (${sprite.emotion}) is larger than the image limit; skipped.`);
            continue;
          }
          try {
            const asset = await call("POST", "/soul/assets", { mime: sprite.mime, data: kit.bytesToBase64(sprite.data) }) as { id: string };
            saved[sprite.emotion!] = asset.id;
          } catch (error) {
            console.error(`Sprite ${sprite.path} (${sprite.emotion}) was not saved: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (Object.keys(saved).length) body = { ...(body as Record<string, unknown>), sprites: saved };
      };
    } else if (command === "live") {
      method = "GET";
      endpoint = `/soul/live?${new URLSearchParams({ conversationId: need(id, "A conversation id") })}`;
    } else if (command === "speech-voices") {
      method = "GET";
      endpoint = `/soul/speech/voices?${new URLSearchParams({ model: need(values.model, "--model") })}`;
    } else if (command === "speech-list") {
      method = "GET";
      endpoint = `/soul/speech?${new URLSearchParams({ conversationId: need(id, "A conversation id") })}`;
    } else if (command === "speak") {
      endpoint = "/soul/speech";
      body = { messageId: need(id, "A message id") };
    } else if (command === "speech-preview") {
      endpoint = "/soul/speech/preview";
      body = {
        model: need(values.model, "--model"),
        ...(values.voice ? { voice: values.voice } : {}),
        ...(values.language ? { language: values.language } : {}),
        ...(values.prompt ? { text: values.prompt } : {}),
      };
    } else if (command === "asset-upload") {
      const kit = await import("@open-design/contracts/soul");
      const file = need(values.file, "--file");
      if (file === "-") throw new Error("--file must name an image file");
      const image = new Uint8Array(await readFile(file));
      const mime = imageMime(image);
      if (!mime) throw new Error("The image must be a PNG, JPEG or WebP file");
      if (image.length > kit.SOUL_LIMITS.assetBytes) throw new Error(`The image is larger than ${kit.SOUL_LIMITS.assetBytes} bytes`);
      endpoint = "/soul/assets";
      body = { mime, data: kit.bytesToBase64(image) };
    } else {
      method = "GET";
      endpoint = `/soul/characters/${target()}/export${values.quarantine ? "?quarantine=1" : ""}`;
    }
  } else if (command !== "status")
    throw new Error(`Unknown PA command: ${command}`);
  if (values.device) {
    if (values["daemon-url"]) throw new Error("Use one PA host option");
    const result = await callPaDevice(values.device, { method, endpoint, ...(body === undefined ? {} : { body }) }) as { error?: { message?: string } };
    if (result.error) throw new Error(result.error.message ?? "PA device request failed");
    console.log(JSON.stringify(result, null, values.json ? 0 : 2));
    return;
  }
  const base = await resolveDaemonUrl({ flagUrl: values["daemon-url"] ?? null });
  const tokenFile = values["access-token-file"] ?? process.env.OD_PA_ACCESS_TOKEN_FILE;
  const token = tokenFile ? readPrivatePaFile(tokenFile, 4096).trim() : null;
  if (token) trustedPaUrl(base);
  const paApi = `${base.replace(/\/$/, "")}/api/pa`;
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const call: PaCliCall = async (verb, route, payloadBody) => {
    const answer = await fetch(`${paApi}${route}`, {
      method: verb, redirect: "error", headers: { "Content-Type": "application/json", ...auth },
      ...(payloadBody === undefined ? {} : { body: JSON.stringify(payloadBody) }),
    });
    const parsed = (await answer.json()) as { error?: { message?: string } };
    if (!answer.ok) throw new Error(parsed.error?.message ?? `HTTP ${answer.status}`);
    return parsed;
  };
  if (prepare) await prepare(call);
  const response = await fetch(`${base.replace(/\/$/, "")}/api/pa${endpoint}`, {
    method,
    redirect: "error",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (command === "artifact-download" && response.ok) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (values.json) console.log(JSON.stringify({ encoding: "base64", bytes: bytes.length, content: bytes.toString("base64") }));
    else process.stdout.write(bytes);
    return;
  }
  const result = (await response.json()) as { error?: { message?: string } };
  if (!response.ok)
    throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  if ((command === "speak" || command === "speech-preview") && values.out) {
    const item = result as { id?: string; cached?: boolean };
    const audio = await fetch(`${paApi}/soul/speech/${encodeURIComponent(String(item.id ?? ""))}`, { redirect: "error", headers: auth });
    if (!audio.ok) {
      const failure = (await audio.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(failure.error?.message ?? `HTTP ${audio.status}`);
    }
    const bytes = Buffer.from(await audio.arrayBuffer());
    await writeFile(values.out, bytes);
    console.log(JSON.stringify({ written: values.out, bytes: bytes.length, cached: item.cached === true }, null, values.json ? 0 : 2));
    return;
  }
  if (command === "live" && values.follow) {
    // Polls like the app does (250 ms); prints what was appended, or a new line and the whole text when the text
    // changed in another way (a restarted message or the next speaker). Ends after two reads with no running reply.
    type LiveRead = { live: { attemptId: string; seq: number; text?: string; unchanged?: true } | null };
    let current = result as LiveRead;
    let shown = "", attempt = "", idle = 0;
    let known: { attemptId: string; seq: number } | null = null;
    for (;;) {
      const live = current.live;
      if (!live) {
        idle += 1;
        known = null;
        if (idle >= 2) break;
      } else {
        idle = 0;
        if (!live.unchanged && typeof live.text === "string") {
          if (values.json) console.log(JSON.stringify(current));
          else if (live.attemptId === attempt && live.text.startsWith(shown)) process.stdout.write(live.text.slice(shown.length));
          else process.stdout.write(`${shown ? "\n" : ""}${live.text}`);
          shown = live.text;
          attempt = live.attemptId;
        }
        known = { attemptId: live.attemptId, seq: live.seq };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      const query = new URLSearchParams({ conversationId: id ?? "", ...(known ? { attempt: known.attemptId, seq: String(known.seq) } : {}) });
      current = await call("GET", `/soul/live?${query}`) as LiveRead;
    }
    if (!values.json && shown) process.stdout.write("\n");
    return;
  }
  if (command === "character-export" && values.charx) {
    // CHARX: the card with the stored portrait and sprites, bytes as stored. A picture that cannot be read is left out.
    const kit = await import("@open-design/contracts/soul");
    const snapshot = await call("GET", "/soul") as { characters?: Array<{ id: string; portraitAssetId?: string | null; sprites?: Record<string, string> }> };
    const character = snapshot.characters?.find(item => item.id === id);
    const stored = async (assetId: string | null | undefined): Promise<Uint8Array | null> => {
      if (!assetId) return null;
      const asset = await fetch(`${paApi}/soul/assets/${encodeURIComponent(assetId)}`, { redirect: "error", headers: auth });
      return asset.ok ? new Uint8Array(await asset.arrayBuffer()) : null;
    };
    const sprites: Partial<Record<(typeof kit.PA_EMOTIONS)[number], Uint8Array | null>> = {};
    for (const emotion of kit.PA_EMOTIONS) sprites[emotion] = await stored(character?.sprites?.[emotion]);
    const portrait = await stored(character?.portraitAssetId);
    const written = kit.buildCharx({ card: result as Record<string, unknown>, portrait, sprites });
    await writeFile(values.charx, written);
    console.log(JSON.stringify({
      written: values.charx, bytes: written.length, portrait: portrait !== null,
      sprites: kit.PA_EMOTIONS.filter(emotion => sprites[emotion]),
    }, null, values.json ? 0 : 2));
    return;
  }
  if (command === "character-export" && values.png) {
    const kit = await import("@open-design/contracts/soul");
    const api = `${base.replace(/\/$/, "")}/api/pa`;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const snapshot = await (await fetch(`${api}/soul`, { redirect: "error", ...(headers ? { headers } : {}) })).json() as
      { characters?: Array<{ id: string; portraitAssetId?: string | null }> };
    const assetId = snapshot.characters?.find(item => item.id === id)?.portraitAssetId ?? null;
    let image: Uint8Array = kit.PA_PLACEHOLDER_PNG;
    let source: "asset" | "placeholder" = "placeholder";
    if (assetId?.endsWith(".png")) {
      const asset = await fetch(`${api}/soul/assets/${encodeURIComponent(assetId)}`, { redirect: "error", ...(headers ? { headers } : {}) });
      if (asset.ok) {
        image = new Uint8Array(await asset.arrayBuffer());
        source = "asset";
      }
    }
    const written = kit.embedCard(image, result as Record<string, unknown>);
    await writeFile(values.png, written);
    console.log(JSON.stringify({ written: values.png, bytes: written.length, portrait: source }, null, values.json ? 0 : 2));
    return;
  }
  console.log(JSON.stringify(result, null, values.json ? 0 : 2));
}

/** One JSON request to the local PA API; a non-2xx answer throws its error message. */
type PaCliCall = (method: string, route: string, body?: unknown) => Promise<unknown>;

/** PNG, JPEG or WebP by magic bytes; null for anything else. */
function imageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((char, index) => at(from + index) === char.charCodeAt(0));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte)) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}
