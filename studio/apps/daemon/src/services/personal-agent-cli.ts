import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveDaemonUrl } from "../daemon-url.js";
import { callPaDevice, readPaDeviceRequest } from "./personal-agent-device-cli.js";
import { readPrivatePaFile, trustedPaUrl } from "./pa/config.js";

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
      name: { type: "string" },
      "request-id": { type: "string" },
      'project-id': { type: 'string' },
      'local-only': { type: 'boolean' },
      'criterion': { type: 'string', multiple: true },
      'cost-limit': { type: 'string' },
      revision: { type: "string" },
      offset: { type: 'string' }, limit: { type: 'string' }, query: { type: 'string' },
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
  amend <task> --prompt-file <path|-> --revision <number>
  cancel <task> | resume <task> | events <task>
  reconcile <task> [--file <JSON|->]     Query evidence, or confirm stopped with revision/note
  memory-create | memory-update <id> | memory-delete <id>
  memory-history <id> | memory-candidate-resolve <id> --file <JSON|->
  control | control-update --file <JSON|->
  channels | local-feishu-apps | channel-create | channel-update <id>
  channel-feishu <id> --file <JSON|->     Write-only credentials or localAppId
  channel-connect <id> | channel-disconnect <id> | channel-pair <id>
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
  provision-token --file <new path>
Create/update commands accept --file <JSON|->. Updates require revision in JSON.
Enterprise access reads --access-token-file or OD_PA_ACCESS_TOKEN_FILE.
All commands support --daemon-url <url>; submit supports --request-id for deduplication.
Use --device <SSH alias> with status, task, submit, resume or cancel to access the same task host.`);
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
  const payload = values.file ? JSON.parse(await read(values.file)) : undefined;
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
    control: ['GET', '/control'], 'control-update': ['PATCH', '/control'],
    projects: ['GET', '/projects'],
    channels: ['GET', '/channels'], 'local-feishu-apps': ['GET', '/channels/local-feishu-apps'],
    'channel-create': ['POST', '/channels'], 'channel-update': ['PATCH', '/channels/:id'],
    'channel-feishu': ['POST', '/channels/:id/feishu'], 'channel-connect': ['POST', '/channels/:id/connect'],
    'channel-disconnect': ['POST', '/channels/:id/disconnect'], 'channel-pair': ['POST', '/channels/:id/pair'],
    'channel-login': ['POST', '/channels/:id/login'], 'channel-login-status': ['GET', '/channels/:id/login'],
    'channel-login-pin': ['POST', '/channels/:id/login/pin'], 'inbox-approve': ['POST', '/channels/inbox/:id/approve'],
    'outbox-resolve': ['POST', '/channels/outbox/:id/resolve'],
  };
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
    body = {
      requestId: values["request-id"] ?? randomUUID(),
      conversationId: values.conversation,
      goal: prompt,
      targetAgentIds: values.target?.split(",") ?? [],
      kind: values.project ? "project" : "discussion",
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
  console.log(JSON.stringify(result, null, values.json ? 0 : 2));
}
