// SPDX-License-Identifier: Apache-2.0
// `od memory <topic>`: the Memory Center on the command line. Every topic calls `/api/memory-center/*` (the same
// endpoints the Memory Center page uses), prints a short summary or, with `--json`, the response itself, and takes
// long text through `--prompt-file <path|->`. A usage or network error throws; the caller prints the message on
// stderr and exits 1.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  parseMemoryScopeKey,
  type CreateMemoryItemResponse,
  type MemoryChunk,
  type MemoryChunkDetailResponse,
  type MemoryChunkListResponse,
  type MemoryConflict,
  type MemoryConflictListResponse,
  type MemoryEngineResponse,
  type MemoryInboxResponse,
  type MemoryItem,
  type MemoryItemHistoryResponse,
  type MemoryItemListResponse,
  type MemoryItemResponse,
  type MemoryMergeDraftResponse,
  type MemoryOverviewResponse,
  type MemoryRecallResponse,
  type MemoryReindexResponse,
  type MemoryScopeNode,
  type MemoryScopeRef,
  type MemoryTidyResponse,
  type ResolveMemoryConflictResponse,
  type ResolveMemoryPendingResponse,
  type UpdateAgentMemoryPolicyResponse,
  type UpdateMemoryItemResponse,
} from "@open-design/contracts";
import { resolveDaemonUrl } from "../daemon-url.js";
import { readPrivatePaFile, trustedPaUrl } from "./pa/config.js";

/** Old topic names keep working; each prints one line saying what it now does. */
const RENAMED: Record<string, { topic: string; note: string }> = {
  delete: {
    topic: "archive",
    note: 'od memory delete is now "od memory archive": memories are archived and can be restored, never deleted.',
  },
  promote: {
    topic: "copy",
    note: 'od memory promote is now "od memory copy": it copies the memory into another scope and leaves the original.',
  },
  candidate: {
    topic: "pending",
    note: 'od memory candidate is now "od memory pending pa:<id> --accept|--reject".',
  },
  search: { topic: "recall", note: 'od memory search is now "od memory recall".' },
  readback: { topic: "chunk", note: 'od memory readback is now "od memory chunk <id>".' },
  ledger: { topic: "engine", note: 'od memory ledger is now "od memory engine show".' },
};

const CURRENT_TOPICS = [
  "overview",
  "list",
  "get",
  "history",
  "create",
  "update",
  "archive",
  "restore",
  "redact",
  "copy",
  "inbox",
  "pending",
  "conflict",
  "recall",
  "chunks",
  "chunk",
  "engine",
  "reindex",
  "tidy",
  "policy",
];

export const MEMORY_CENTER_CLI_TOPICS = new Set([...CURRENT_TOPICS, ...Object.keys(RENAMED)]);

const OLD_DOMAIN_KIND: Record<string, MemoryScopeRef["kind"]> = {
  private: "profile",
  agent: "bot",
  group: "group",
  project: "project",
};

type Body = Record<string, unknown>;
type Values = ReturnType<typeof parse>["values"];

interface Plan {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body?: Body;
  print: (payload: never, out: (line: string) => void) => void;
}

function parse(args: string[]) {
  const string = { type: "string" } as const;
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean" },
        h: { type: "boolean" },
        "daemon-url": string,
        "access-token-file": string,
        file: string,
        "prompt-file": string,
        prompt: string,
        content: string,
        query: string,
        // scopes
        scope: { type: "string", multiple: true },
        profile: { type: "boolean" },
        persona: string,
        bot: string,
        agent: string,
        group: string,
        project: string,
        conversation: string,
        surface: string,
        // old names for the same scopes
        domain: string,
        "scope-id": string,
        "target-domain": string,
        "target-scope-id": string,
        "archive-source": { type: "boolean" },
        "ref-id": string,
        "ref-kind": string,
        // item fields
        kind: string,
        title: string,
        status: string,
        pinned: { type: "boolean" },
        unpinned: { type: "boolean" },
        "via-group": { type: "boolean" },
        "no-studio": { type: "boolean" },
        "data-class": string,
        source: string,
        due: string,
        "clear-due": { type: "boolean" },
        "valid-from": string,
        "valid-until": string,
        "event-at": string,
        note: string,
        revision: string,
        confirm: { type: "boolean" },
        limit: string,
        offset: string,
        // pending and conflicts
        accept: { type: "boolean" },
        reject: { type: "boolean" },
        dismiss: { type: "boolean" },
        resolution: string,
        "merged-file": string,
        "merged-title": string,
        // recall
        "budget-chars": string,
        "no-chunks": { type: "boolean" },
        // engine
        vectors: { type: "boolean" },
        "auto-memory": string,
        "embedding-provider": string,
        "embedding-url": string,
        "embedding-model": string,
        "embedding-dimensions": string,
        "reranker-provider": string,
        "reranker-url": string,
        "reranker-model": string,
        "judge-provider": string,
        "judge-url": string,
        "judge-model": string,
        "recall-max-hits": string,
        "recall-budget": string,
        "recall-min-score": string,
        // bot policy
        "profile-mount": string,
        "auto-memory-mode": string,
      },
    });
  } catch (error) {
    throw new Error(error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error));
  }
}

async function readInput(path: string): Promise<string> {
  if (path !== "-") return await readFile(path, "utf8");
  return await new Promise<string>((resolve, reject) => {
    let collected = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      collected += chunk;
    });
    process.stdin.on("end", () => resolve(collected));
    process.stdin.on("error", reject);
  });
}

function compact(fields: Body): Body {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function integer(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new Error(`--${name} needs a whole number, got "${value}".`);
  return Number(value);
}

function decimal(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed)) throw new Error(`--${name} needs a number, got "${value}".`);
  return parsed;
}

/** `2026-11-21` (local day, from its start or to its end) or milliseconds since the epoch (not seconds). */
function moment(name: string, value: string | undefined, edge: "start" | "end"): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d{12,}$/.test(value)) return Number(value);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!day) throw new Error(`--${name} needs a date like 2026-11-21 or milliseconds, got "${value}".`);
  const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
  return edge === "start"
    ? new Date(year, month - 1, date).getTime()
    : new Date(year, month - 1, date, 23, 59, 59, 999).getTime();
}

function scopeOfText(value: string): MemoryScopeRef {
  const parsed = value === "profile" ? { kind: "profile" as const, id: "" } : parseMemoryScopeKey(value);
  if (!parsed) {
    throw new Error(
      `Invalid scope "${value}". Use kind:id, for example bot:<id>, group:<id>, project:<id>, conversation:<id>, persona:<id> or profile.`,
    );
  }
  return parsed;
}

/** Every scope the flags name: `--scope kind:id` (repeatable) and the shortcuts for each kind. */
function scopesOf(values: Values, skip: ReadonlyArray<"conversation" | "project" | "bot" | "group"> = []): MemoryScopeRef[] {
  const scopes = (values.scope ?? []).map(scopeOfText);
  if (values.profile) scopes.push({ kind: "profile", id: "" });
  if (values.persona) scopes.push({ kind: "persona", id: values.persona });
  const bot = values.bot ?? values.agent;
  if (bot && !skip.includes("bot")) scopes.push({ kind: "bot", id: bot });
  if (values.group && !skip.includes("group")) scopes.push({ kind: "group", id: values.group });
  if (values.project && !skip.includes("project")) scopes.push({ kind: "project", id: values.project });
  if (values.conversation && !skip.includes("conversation")) scopes.push({ kind: "conversation", id: values.conversation });
  const oldKind = values.domain ? OLD_DOMAIN_KIND[values.domain] : undefined;
  if (values.domain && !oldKind) throw new Error(`Unknown --domain "${values.domain}".`);
  if (oldKind) scopes.push({ kind: oldKind, id: oldKind === "profile" ? "" : (values["scope-id"] ?? "") });
  return scopes;
}

function oneScope(values: Values, required: boolean, usage: string, skip?: Parameters<typeof scopesOf>[1]): MemoryScopeRef | undefined {
  const scopes = scopesOf(values, skip);
  if (scopes.length > 1) throw new Error(`Name one scope. ${usage}`);
  if (scopes.length === 0 && required) throw new Error(`Name the scope. ${usage}`);
  return scopes[0];
}

function scopeQuery(scope: MemoryScopeRef | undefined): Record<string, string> {
  return scope ? { scopeKind: scope.kind, scopeId: scope.id } : {};
}

function withQuery(path: string, fields: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) query.set(key, value);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

// ---- plain-language output ------------------------------------------------------------------------------------

const firstLine = (text: string, max = 100): string => {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const stamp = (ms: number): string => new Date(ms).toLocaleString("sv-SE").slice(0, 16);
const scopeText = (scope: MemoryScopeRef, label?: string): string => `${scope.kind}${scope.id ? `:${scope.id}` : ""}${label ? ` ${label}` : ""}`;

function itemLine(item: MemoryItem): string {
  const marks = [
    item.status !== "active" ? item.status : "",
    item.pinned ? "pinned" : "",
    item.openConflictIds.length > 0 ? "disagrees" : "",
    item.backing === "studio" ? "settings" : "",
  ].filter(Boolean);
  const text = item.redacted ? "(cleared)" : firstLine(item.title || item.content);
  return `${item.id}\t[${scopeText(item.scope, item.scopeLabel)}]\t${item.kind}\t${marks.join(",") || "-"}\t${text}`;
}

function conflictLine(conflict: MemoryConflict): string {
  const hint = conflict.suggestion ? ` (hint: ${conflict.suggestion})` : "";
  return `${conflict.id}\t${conflict.status}\t[${scopeText(conflict.scope, conflict.scopeLabel)}]\t${firstLine(conflict.existing.content, 60)}  |  ${firstLine(conflict.incoming.content, 60)}${hint}`;
}

function chunkLine(chunk: MemoryChunk): string {
  return `${chunk.id}\t${chunk.conversationTitle ?? chunk.conversationId}\t${stamp(chunk.startAt)}–${stamp(chunk.endAt)}\t${chunk.speakers.join(",")}\t${firstLine(chunk.content, 80)}`;
}

function nodeLine(node: MemoryScopeNode, indent = ""): string {
  const c = node.counts;
  return `${indent}${scopeText(node.scope, node.label)}\tmemories ${c.active}, to confirm ${c.pending}, disagreements ${c.conflicts}, archived ${c.archived}, windows ${c.chunks}`;
}

function printOverview(overview: MemoryOverviewResponse, out: (line: string) => void): void {
  out(
    `memories: ${overview.totals.items}, conversation windows: ${overview.totals.chunks}, to confirm: ${overview.inbox.pending}, disagreements: ${overview.inbox.conflicts}, search level: ${overview.engine.level}${overview.enabled ? "" : " (Settings → 记忆 is off)"}`,
  );
  for (const node of [overview.profile, ...overview.personas, ...overview.bots, ...overview.groups]) out(nodeLine(node));
  for (const project of overview.projects) {
    out(nodeLine(project));
    for (const child of project.children ?? []) {
      const c = child.counts;
      if (c.active + c.pending + c.conflicts + c.archived + c.chunks > 0) out(nodeLine(child, "  "));
    }
  }
}

function printItem(item: MemoryItem, out: (line: string) => void): void {
  out(itemLine(item));
  out(`source: ${item.source || "-"}   revision: ${item.revision}   versions: ${item.versionCount}   recorded: ${stamp(item.createdAt)}`);
  out("");
  out(item.redacted ? "(the text was cleared)" : item.content);
}

function printEngine({ config, status }: MemoryEngineResponse, out: (line: string) => void): void {
  const provider = (state: { provider: string; model: string; ready: boolean; error: string | null }) =>
    `${state.provider}${state.model ? ` ${state.model}` : ""} ${state.ready ? "ready" : "not ready"}${state.error ? ` (${state.error})` : ""}`;
  out(`search level: ${status.level}   documents: ${status.documents}`);
  out(`embedding: ${provider(status.embedding)}   indexed ${status.embedding.indexed}, waiting ${status.embedding.waiting}`);
  out(`reranker: ${provider(status.reranker)}`);
  out(`judge: ${provider(status.judge)}`);
  out(`auto memory: ${config.autoMemory}   recall: up to ${config.recall.maxHits} hits, ${config.recall.budgetChars} chars, min score ${config.recall.minScore}`);
  if (status.recallLatencyMs) out(`recall latency: p50 ${status.recallLatencyMs.p50} ms, p95 ${status.recallLatencyMs.p95} ms (${status.recallLatencyMs.samples} recalls)`);
  for (const model of status.localModels) {
    out(`local model ${model.id}: ${model.name}, ${model.state}${model.state === "downloading" ? ` ${Math.round(model.progress * 100)}%` : ""}${model.error ? ` (${model.error})` : ""}`);
  }
}

// ---- one plan per topic ----------------------------------------------------------------------------------------

interface Input {
  values: Values;
  /** What follows the topic on the command line. */
  args: string[];
  /** Text from `--prompt-file`, `--content` or `--prompt`. */
  text: string | undefined;
  /** JSON from `--file`, which replaces the body built from flags. */
  file: Body | undefined;
  /** The topic as typed (an old name stays visible here) and the topic it runs as. */
  typed: string;
  topic: string;
}

function needId(input: Input, usage: string): string {
  const id = input.args[0];
  if (!id) throw new Error(`Usage: ${usage}`);
  return id;
}

function itemPath(id: string, tail = ""): string {
  return `/items/${encodeURIComponent(id)}${tail}`;
}

function planOf(input: Input): Plan {
  const { values, text, file, topic, typed } = input;
  const revision = integer("revision", values.revision);

  switch (topic) {
    case "overview":
      return { method: "GET", path: "/overview", print: printOverview };

    case "list": {
      const query = values.query ?? text;
      const pinned = values.pinned ? "true" : values.unpinned ? "false" : undefined;
      return {
        method: "GET",
        path: withQuery("/items", {
          ...scopeQuery(oneScope(values, false, "Usage: od memory list [--scope kind:id]")),
          status: values.status,
          kind: values.kind,
          pinned,
          viaGroup: values["via-group"] ? "true" : undefined,
          query: query?.trim() || undefined,
          includeStudio: values["no-studio"] ? "false" : undefined,
          limit: values.limit,
          offset: values.offset,
        }),
        print: (payload: MemoryItemListResponse, out) => {
          out(`# total=${payload.total}`);
          for (const item of payload.items) out(itemLine(item));
        },
      };
    }

    case "get": {
      const id = needId(input, "od memory get <id> [--json]");
      return { method: "GET", path: itemPath(id), print: (payload: MemoryItemResponse, out) => printItem(payload.item, out) };
    }

    case "history": {
      const id = needId(input, "od memory history <id> [--json]");
      return {
        method: "GET",
        path: itemPath(id, "/history"),
        print: (payload: MemoryItemHistoryResponse, out) => {
          out(itemLine(payload.item));
          for (const version of payload.versions) {
            out(`v${version.version}\t${stamp(version.createdAt)}\t${version.actor}\t${version.note || "-"}\t${firstLine(version.content)}`);
          }
          for (const event of payload.events) out(`#${event.seq}\t${stamp(event.at)}\t${event.actor}\t${event.type}`);
        },
      };
    }

    case "create": {
      const scope = oneScope(values, !file, "Usage: od memory create --scope kind:id (--prompt-file <path|-> | --content <text>) [--kind …] [--json]");
      const content = text?.trim();
      if (!file && !content) throw new Error("Give the memory text with --prompt-file <path|-> or --content <text>.");
      return {
        method: "POST",
        path: "/items",
        body:
          file ??
          compact({
            scope,
            content,
            title: values.title,
            kind: values.kind,
            pinned: values.pinned ? true : undefined,
            dataClass: values["data-class"],
            source: values.source,
            dueAt: moment("due", values.due, "end"),
            validFrom: moment("valid-from", values["valid-from"], "start"),
            validUntil: moment("valid-until", values["valid-until"], "end"),
            eventAt: moment("event-at", values["event-at"], "start"),
          }),
        print: (payload: CreateMemoryItemResponse, out) => {
          out(`${payload.created ? "saved" : "already remembered"}\t${payload.item.id}`);
          for (const conflict of payload.conflicts) out(`disagrees with an existing memory: ${conflict.id}`);
        },
      };
    }

    case "update": {
      const id = needId(input, "od memory update <id> [--prompt-file <path|->] [--title …] [--kind …] [--pinned|--unpinned] [--json]");
      const body =
        file ??
        compact({
          content: text?.trim() || undefined,
          title: values.title,
          kind: values.kind,
          pinned: values.pinned ? true : values.unpinned ? false : undefined,
          dueAt: values["clear-due"] ? null : moment("due", values.due, "end"),
          validFrom: moment("valid-from", values["valid-from"], "start"),
          validUntil: moment("valid-until", values["valid-until"], "end"),
          note: values.note,
          revision,
        });
      if (Object.keys(body).length === 0) throw new Error("Nothing to change. Pass new text, --title, --kind, --pinned, --due …");
      return {
        method: "PATCH",
        path: itemPath(id),
        body,
        print: (payload: UpdateMemoryItemResponse, out) => {
          out(`updated\t${payload.item.id}\tversions ${payload.item.versionCount}`);
          for (const conflict of payload.conflicts) out(`disagrees with an existing memory: ${conflict.id}`);
        },
      };
    }

    case "archive":
    case "restore":
    case "redact": {
      const id = needId(input, `od memory ${topic} <id>${topic === "redact" ? " --confirm" : ""} [--json]`);
      if (topic === "redact" && !values.confirm) {
        throw new Error("Redacting clears the text for good and cannot be undone. Add --confirm to do it.");
      }
      return {
        method: "POST",
        path: itemPath(id, "/action"),
        body: compact({ action: topic, revision, confirm: topic === "redact" ? true : undefined }),
        print: (payload: MemoryItemResponse, out) => out(`${topic}d\t${payload.item.id}\t${payload.item.status}`),
      };
    }

    case "copy": {
      const id = needId(input, "od memory copy <id> --scope kind:id [--title …] [--json]");
      if (values["archive-source"]) throw new Error("--archive-source is gone. Run od memory archive <id> to archive the original.");
      const scope =
        file === undefined
          ? (values["target-domain"]
              ? oldTarget(values)
              : oneScope(values, true, "Usage: od memory copy <id> --scope kind:id"))
          : undefined;
      return {
        method: "POST",
        path: itemPath(id, "/copy"),
        body: file ?? compact({ scope, title: values.title }),
        print: (payload: CreateMemoryItemResponse, out) => {
          out(`${payload.created ? "copied" : "already remembered"}\t${payload.item.id}`);
          for (const conflict of payload.conflicts) out(`disagrees with an existing memory: ${conflict.id}`);
        },
      };
    }

    case "inbox":
      return {
        method: "GET",
        path: "/inbox",
        print: (payload: MemoryInboxResponse, out) => {
          out(`# disagreements: ${payload.conflicts.length}, to confirm: ${payload.pending.length}`);
          for (const conflict of payload.conflicts) out(`disagreement\t${conflictLine(conflict)}`);
          for (const entry of payload.pending) {
            out(`to confirm\t${entry.id}\t[${scopeText(entry.scope, entry.scopeLabel)}]\t${entry.kind}\t${firstLine(entry.content)}`);
          }
        },
      };

    case "pending": {
      const given = needId(input, "od memory pending <item:id|pa:id> (--accept | --reject) [--prompt-file <path|->] [--json]");
      // The old `candidate <id>` named Personal Agent candidates by their bare id.
      const entry = typed === "candidate" && !/^(item|pa):/.test(given) ? `pa:${given}` : given;
      const accepting = values.accept === true;
      const rejecting = values.reject === true || values.dismiss === true;
      if (!file && accepting === rejecting) throw new Error("Say what to do with it: --accept or --reject (not both).");
      const accept = file ? undefined : accepting;
      const scope = oneScope(values, false, "Usage: od memory pending <id> --accept [--scope kind:id]");
      return {
        method: "POST",
        path: `/pending/${encodeURIComponent(entry)}/resolve`,
        body: file ?? compact({ accept, revision, content: text?.trim() || undefined, scope, kind: values.kind }),
        print: (payload: ResolveMemoryPendingResponse, out) => {
          out(`${payload.accepted ? "remembered" : "not remembered"}\t${payload.entryId}${payload.item ? `\t${payload.item.id}` : ""}`);
          for (const conflict of payload.conflicts) out(`disagrees with an existing memory: ${conflict.id}`);
        },
      };
    }

    case "conflict":
      return conflictPlan(input);

    case "recall":
      return recallPlan(input);

    case "chunks":
      if (input.args[0]) return chunkPlan(input);
      return {
        method: "GET",
        path: withQuery("/chunks", {
          ...scopeQuery(oneScope(values, false, "Usage: od memory chunks [--scope kind:id] [--conversation <id>]", ["conversation"])),
          conversationId: values.conversation,
          limit: values.limit,
          offset: values.offset,
        }),
        print: (payload: MemoryChunkListResponse, out) => {
          out(`# total=${payload.total}`);
          for (const chunk of payload.chunks) out(chunkLine(chunk));
        },
      };

    case "chunk":
      return chunkPlan(input);

    case "engine":
      return enginePlan(input);

    case "reindex":
      if (scopesOf(values).length > 0) throw new Error("od memory reindex rebuilds the whole search index and takes no scope.");
      return {
        method: "POST",
        path: "/engine/reindex",
        body: file ?? compact({ vectors: values.vectors ? true : undefined }),
        print: (payload: MemoryReindexResponse, out) => out(`rebuilt the search index: ${payload.documents} documents in ${payload.durationMs} ms`),
      };

    case "tidy": {
      const scope = oneScope(values, false, "Usage: od memory tidy [--scope kind:id]");
      return {
        method: "POST",
        path: "/engine/tidy",
        body: file ?? compact({ scope }),
        print: (payload: MemoryTidyResponse, out) =>
          out(`looked at ${payload.scannedItems} memories: ${payload.conflictsOpened} new disagreements, ${payload.itemsProposed} newly learned (${payload.durationMs} ms)`),
      };
    }

    case "policy": {
      const id = needId(input, "od memory policy <botId> [--profile-mount owner_profile|persona_only|none] [--auto-memory-mode off|candidate|explicit_auto] [--json]");
      const body = file ?? compact({ profileMount: values["profile-mount"], autoMemoryMode: values["auto-memory-mode"], revision });
      if (Object.keys(body).length === 0) throw new Error("Nothing to change. Pass --profile-mount or --auto-memory-mode.");
      return {
        method: "PATCH",
        path: `/agents/${encodeURIComponent(id)}/policy`,
        body,
        print: (payload: UpdateAgentMemoryPolicyResponse, out) => {
          const policy = payload.node.policy;
          out(`${payload.node.label}\tprofile mount: ${policy?.effectiveProfileMount}\tauto memory: ${policy?.effectiveAutoMemoryMode}`);
        },
      };
    }

    default:
      throw new Error(`Unknown topic: od memory ${topic}`);
  }
}

/** The old `promote --target-domain project|private [--target-scope-id <id>]`. */
function oldTarget(values: Values): MemoryScopeRef {
  const kind = OLD_DOMAIN_KIND[values["target-domain"] ?? ""];
  if (!kind) throw new Error(`Unknown --target-domain "${values["target-domain"]}".`);
  return { kind, id: kind === "profile" ? "" : (values["target-scope-id"] ?? "") };
}

function conflictPlan(input: Input): Plan {
  const { values, args, text, file } = input;
  const verb = args[0] ?? "list";
  const id = args[1];
  const usage = "od memory conflict list [--status open|resolved] | get <id> | draft <id> | resolve <id> --resolution keep_new|keep_old|merge|keep_both [--merged-file <path|->]";
  switch (verb) {
    case "list":
      return {
        method: "GET",
        path: withQuery("/conflicts", { status: values.status }),
        print: (payload: MemoryConflictListResponse, out) => {
          out(`# total=${payload.total}`);
          for (const conflict of payload.conflicts) out(conflictLine(conflict));
        },
      };
    case "get":
      if (!id) throw new Error(`Usage: ${usage}`);
      return {
        method: "GET",
        path: `/conflicts/${encodeURIComponent(id)}`,
        print: (payload: { conflict: MemoryConflict }, out) => {
          const { conflict } = payload;
          out(`${conflict.id}\t${conflict.status}\t${conflict.kind}\t${conflict.reason}`);
          out(`existing (${stamp(conflict.existing.createdAt)}): ${conflict.existing.content}`);
          out(`incoming (${stamp(conflict.incoming.createdAt)}): ${conflict.incoming.content}`);
          if (conflict.suggestion) out(`hint: ${conflict.suggestion}`);
        },
      };
    case "draft":
      if (!id) throw new Error(`Usage: ${usage}`);
      return {
        method: "POST",
        path: `/conflicts/${encodeURIComponent(id)}/merge-draft`,
        body: {},
        print: (payload: MemoryMergeDraftResponse, out) => out(payload.content),
      };
    case "resolve": {
      if (!id) throw new Error(`Usage: ${usage}`);
      if (!file && !values.resolution) throw new Error("Choose --resolution keep_new, keep_old, merge or keep_both.");
      return {
        method: "POST",
        path: `/conflicts/${encodeURIComponent(id)}/resolve`,
        body: file ?? compact({ resolution: values.resolution, mergedContent: text?.trim() || undefined, mergedTitle: values["merged-title"] }),
        print: (payload: ResolveMemoryConflictResponse, out) => {
          out(`${payload.conflict.resolution}\t${payload.conflict.id}\tnothing was deleted`);
          for (const item of payload.items) out(itemLine(item));
        },
      };
    }
    default:
      throw new Error(`Usage: ${usage}`);
  }
}

function recallPlan(input: Input): Plan {
  const { values, args, text, file, typed } = input;
  const query = (values.query ?? text ?? args.join(" ")).trim();
  if (!query && !file) {
    throw new Error(
      "Usage: od memory recall (--query <text> | --prompt-file <path|->) (--scope kind:id … | --surface studio|pa [--agent <id>] [--group <id>] [--project <id>] [--conversation <id>])",
    );
  }
  // The old `search --agent …` recalled as that bot, so the surface is implied there.
  const implied = values.agent || values.bot || values.group ? "pa" : values.project || values.conversation ? "studio" : undefined;
  const surface = values.surface ?? (typed === "search" ? implied : undefined);
  const limits = compact({
    limit: integer("limit", values.limit),
    budgetChars: integer("budget-chars", values["budget-chars"]),
    includeChunks: values["no-chunks"] ? false : undefined,
  });
  let body: Body;
  if (file) {
    body = file;
  } else if (surface) {
    if (surface !== "studio" && surface !== "pa") throw new Error('--surface is "studio" or "pa".');
    body = {
      query,
      context: compact({
        surface,
        projectId: values.project,
        conversationId: values.conversation,
        agentId: values.bot ?? values.agent,
        groupId: values.group,
      }),
      ...limits,
    };
  } else {
    const scopes = scopesOf(values);
    if (scopes.length === 0) {
      throw new Error("Say where to look: --scope kind:id (repeatable), or --surface studio|pa with --agent/--group/--project/--conversation.");
    }
    body = { query, scopes, ...limits };
  }
  return {
    method: "POST",
    path: "/recall",
    body,
    print: (payload: MemoryRecallResponse, out) => {
      out(`level ${payload.level}, ${payload.hits.length} hits, ${payload.usedChars}/${payload.budgetChars} chars, ${payload.latencyMs.total} ms`);
      for (const item of payload.standing) out(`always\t${itemLine(item)}`);
      for (const hit of payload.hits) {
        out(`${hit.score.toFixed(2)}\t${hit.docKind}\t${hit.id}\t[${scopeText(hit.scope, hit.scopeLabel)}]\t${hit.why.join("/")}${hit.inConflict ? "\tdisagrees" : ""}\t${firstLine(hit.content, 80)}`);
      }
      if (payload.promptBlock) {
        out("--- what the model would receive ---");
        out(payload.promptBlock);
      }
    },
  };
}

function chunkPlan(input: Input): Plan {
  const id = input.args[0] ?? input.values["ref-id"];
  if (!id) throw new Error("Usage: od memory chunk <id> [--json]");
  return {
    method: "GET",
    path: `/chunks/${encodeURIComponent(id)}`,
    print: (payload: MemoryChunkDetailResponse, out) => {
      out(chunkLine(payload.chunk));
      out("");
      out(payload.chunk.content);
      for (const neighbor of payload.neighbors) out(`neighbor\t${chunkLine(neighbor)}`);
    },
  };
}

function enginePlan(input: Input): Plan {
  const { values, args, file, typed } = input;
  const verb = typed === "ledger" ? "show" : (args[0] ?? "show");
  const usage = "od memory engine show | set [--auto-memory off|review|auto] [--embedding-provider off|local|ollama|openai_compatible] … | model <id> download|cancel";
  if (verb === "show") return { method: "GET", path: "/engine", print: printEngine };
  if (verb === "model") {
    const [, id, action] = args;
    if (!id || (action !== "download" && action !== "cancel")) throw new Error(`Usage: ${usage}`);
    return { method: "POST", path: `/engine/models/${encodeURIComponent(id)}`, body: { action }, print: printEngine };
  }
  if (verb !== "set") throw new Error(`Usage: ${usage}`);
  const group = (fields: Body): Body | undefined => {
    const set = compact(fields);
    return Object.keys(set).length > 0 ? set : undefined;
  };
  const body =
    file ??
    compact({
      autoMemory: values["auto-memory"],
      embedding: group({
        provider: values["embedding-provider"],
        baseUrl: values["embedding-url"],
        model: values["embedding-model"],
        dimensions: integer("embedding-dimensions", values["embedding-dimensions"]),
      }),
      reranker: group({ provider: values["reranker-provider"], url: values["reranker-url"], model: values["reranker-model"] }),
      judge: group({ provider: values["judge-provider"], apiUrl: values["judge-url"], model: values["judge-model"] }),
      recall: group({
        maxHits: integer("recall-max-hits", values["recall-max-hits"]),
        budgetChars: integer("recall-budget", values["recall-budget"]),
        minScore: decimal("recall-min-score", values["recall-min-score"]),
      }),
    });
  if (Object.keys(body).length === 0) throw new Error(`Nothing to change. API keys go in a JSON file: --file <path|-> with {"embedding":{"apiKey":"…"}}. Usage: ${usage}`);
  return { method: "PUT", path: "/engine", body, print: printEngine };
}

// ---- running ------------------------------------------------------------------------------------------------------

async function call(base: string, token: string | null, plan: Plan): Promise<unknown> {
  const url = `${base}/api/memory-center${plan.path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: plan.method,
      redirect: "error",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {}),
    });
  } catch (error) {
    const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    throw new Error(`Cannot reach the Fantay daemon at ${base}: ${cause}. Start the app, or pass --daemon-url.`);
  }
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const failure = (payload ?? {}) as { code?: string; message?: string; error?: { code?: string; message?: string } };
    const message = failure.error?.message ?? failure.message ?? `HTTP ${response.status}`;
    const code = failure.error?.code ?? failure.code;
    throw new Error(code ? `${message} (${code})` : message);
  }
  return payload;
}

export async function runMemoryCenterCli(
  args: string[],
  io: { stdout?: (line: string) => void; stderr?: (line: string) => void } = {},
): Promise<void> {
  const out = io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { values, positionals } = parse(args);

  const typed = positionals[0] ?? "overview";
  const renamed = RENAMED[typed];
  if (renamed) err(renamed.note);
  const topic = renamed?.topic ?? typed;
  if (!CURRENT_TOPICS.includes(topic)) throw new Error(`Unknown topic: od memory ${typed}`);

  const stdinFlags = [values.file, values["prompt-file"], values["merged-file"]].filter((value) => value === "-");
  if (stdinFlags.length > 1) throw new Error("Only one flag may read from stdin (-).");
  const file = values.file ? (JSON.parse(await readInput(values.file)) as Body) : undefined;
  const textPath = values["prompt-file"] ?? values["merged-file"];
  const text = textPath ? await readInput(textPath) : (values.content ?? values.prompt);

  const plan = planOf({ values, args: positionals.slice(1), text, file, typed, topic });

  const base = (await resolveDaemonUrl({ flagUrl: values["daemon-url"] ?? null })).replace(/\/$/, "");
  const tokenFile = values["access-token-file"] ?? process.env.OD_PA_ACCESS_TOKEN_FILE;
  const token = tokenFile ? readPrivatePaFile(tokenFile, 4096).trim() : null;
  if (token) trustedPaUrl(base);

  const payload = await call(base, token, plan);
  if (values.json) out(JSON.stringify(payload, null, 2));
  else plan.print(payload as never, out);
}
