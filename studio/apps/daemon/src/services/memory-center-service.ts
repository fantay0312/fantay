// SPDX-License-Identifier: Apache-2.0
// Memory Center service: the layer between `/api/memory-center/*` (and `od memory`) and the memory engine that the
// Personal Agent service owns (`personalAgent.memory`). It adds what the engine does not know about: the names of
// scopes, the owner's Settings → 记忆 entries (listed read-only), the Personal Agent's own pending proposals, and
// the enterprise rules (every call is scoped to the signed-in member).

import {
  MEMORY_ITEM_STATUSES,
  PROFILE_MEMORY_ID,
  memoryScopeKey,
  type CopyMemoryItemRequest,
  type CreateMemoryItemRequest,
  type CreateMemoryItemResponse,
  type MemoryAgentPolicyView,
  type MemoryAutoMode,
  type MemoryChunkDetailResponse,
  type MemoryChunkListQuery,
  type MemoryChunkListResponse,
  type MemoryConflict,
  type MemoryConflictListResponse,
  type MemoryEngineResponse,
  type MemoryInboxResponse,
  type MemoryItem,
  type MemoryItemActionRequest,
  type MemoryItemHistoryResponse,
  type MemoryItemKind,
  type MemoryItemListQuery,
  type MemoryItemListResponse,
  type MemoryItemResponse,
  type MemoryMergeDraftResponse,
  type MemoryOverviewResponse,
  type MemoryPendingEntry,
  type MemoryRecallRequest,
  type MemoryRecallResponse,
  type MemoryReindexRequest,
  type MemoryReindexResponse,
  type MemoryScopeCounts,
  type MemoryScopeNode,
  type MemoryScopeRef,
  type MemoryTidyRequest,
  type MemoryTidyResponse,
  type MemoryType,
  type MemoryVia,
  type PaAutoMemoryMode,
  type PaConversation,
  type PaGroup,
  type PaMemoryCandidate,
  type PaPersona,
  type PaTask,
  type PersonalAgent,
  type ResolveMemoryConflictRequest,
  type ResolveMemoryConflictResponse,
  type ResolveMemoryPendingRequest,
  type ResolveMemoryPendingResponse,
  type UpdateAgentMemoryPolicyRequest,
  type UpdateAgentMemoryPolicyResponse,
  type UpdateMemoryEngineConfigRequest,
  type UpdateMemoryItemRequest,
  type UpdateMemoryItemResponse,
} from "@open-design/contracts";
import type { Statement } from "better-sqlite3";
import type { SqliteDb } from "../db.js";
import { listMemoryEntries, readMemoryConfig, readMemoryEntry, readMemoryIndex } from "../memory.js";
import { PaError } from "../storage/personal-agent-store.js";
import type { PaMember } from "./pa/config.js";
import {
  MemoryError,
  sweepDeletedStudioConversations,
  type MemoryEngineApi,
  type MemoryItemRow,
} from "./memory/index.js";
import { engineScopeOf, paKindOf, paScopeOf, type PaMemoryScope } from "./memory/pa-bridge.js";
import type { PersonalAgentService } from "./personal-agent-service.js";

export interface MemoryCenterDeps {
  personalAgent: PersonalAgentService;
  db: SqliteDb;
  runtimeDataDir: string;
}

/** Who is asking. `member` is set in enterprise mode only; every read and write is then limited to that member. */
export interface MemoryCaller {
  member?: PaMember | undefined;
}

export const MEMORY_STUDIO_PREFIX = "studio:";
export const MEMORY_PENDING_ITEM_PREFIX = "item:";
export const MEMORY_PENDING_PA_PREFIX = "pa:";

const OWNER = "owner";
const DEFAULT_ITEM_LIMIT = 100;
const DEFAULT_CHUNK_LIMIT = 50;
const INBOX_LIMIT = 200;
/** The navigator lists the newest conversations of a project; older ones stay reachable through the project. */
const CONVERSATIONS_PER_PROJECT = 200;
const COMMENT_ANCHOR_PREFIX = "comment-anchor-";

const STUDIO_SOURCE = "设置 · 记忆";
const STUDIO_KINDS: Record<MemoryType, MemoryItemKind> = {
  profile: "profile",
  user: "profile",
  rule: "rule",
  reference: "reference",
  feedback: "feedback",
  project: "fact",
};
const PA_AUTO_MODE: Record<MemoryAutoMode, PaAutoMemoryMode> = {
  off: "off",
  review: "candidate",
  auto: "explicit_auto",
};

function notFound(what: string, id: string): MemoryError {
  return new MemoryError("MEMORY_NOT_FOUND", `${what} ${id} was not found.`, 404);
}

function invalid(message: string): MemoryError {
  return new MemoryError("MEMORY_INVALID", message, 400);
}

function readOnly(): PaError {
  return new PaError("这条记忆来自“设置 → 记忆”，请在那里修改。", 409, "MEMORY_READ_ONLY");
}

function folded(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** A scope as a request carries it: the profile scope may leave its id out. */
type ScopeInput = { kind: MemoryScopeRef["kind"]; id?: string | undefined };

/** The scope a list query names: a kind with its id, or nothing. An id alone names nothing and is a mistake. */
function queryScope(query: { scopeKind?: MemoryScopeRef["kind"] | undefined; scopeId?: string | undefined }): MemoryScopeRef | undefined {
  if (!query.scopeKind) {
    if (query.scopeId) throw invalid("scopeId needs scopeKind.");
    return undefined;
  }
  return cleanScope({ kind: query.scopeKind, id: query.scopeId });
}

/** Non-profile scopes need an id; the profile scope never has one. */
function cleanScope(scope: ScopeInput): MemoryScopeRef {
  if (scope.kind === "profile") return { kind: "profile", id: "" };
  const id = scope.id?.trim() ?? "";
  if (!id) throw invalid(`A ${scope.kind} scope needs an id.`);
  return { kind: scope.kind, id };
}


function emptyCounts(): MemoryScopeCounts {
  return { active: 0, pending: 0, conflicts: 0, archived: 0, chunks: 0 };
}

/** `- [Name](id.md)` lines of MEMORY.md: an entry listed there is injected into prompts, one that was removed is off. */
function linkedStudioIds(indexBody: string): Set<string> {
  const ids = new Set<string>();
  for (const match of indexBody.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)) {
    const file = match[1]?.trim();
    if (file && file !== "MEMORY.md") ids.add(file.replace(/\.md$/i, ""));
  }
  return ids;
}

interface StudioEntry {
  id: string;
  name: string;
  description?: string;
  type: MemoryType;
  projectId?: string;
  source?: string;
  updatedAt: number;
  body: string;
}

interface ProjectRow {
  id: string;
  name: string;
  updated_at: number;
}
interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  updated_at: number;
}

export class MemoryCenterService {
  private sqlCache:
    | {
        projects: Statement<unknown[]>;
        conversations: Statement<unknown[]>;
        projectName: Statement<unknown[]>;
        conversationTitle: Statement<unknown[]>;
      }
    | null
    | undefined;

  constructor(private readonly deps: MemoryCenterDeps) {
    this.engine.setLabeler((scope) => this.labelOf(scope));
  }

  private get pa(): PersonalAgentService {
    return this.deps.personalAgent;
  }

  private get engine(): MemoryEngineApi {
    return this.pa.memory;
  }

  private get enterprise(): boolean {
    return this.pa.kernel?.mode === "enterprise";
  }

  /** The principal that owns what this caller writes; undefined in personal mode (the engine's `owner`). */
  private principalOf(caller: MemoryCaller): string | undefined {
    return caller.member?.id;
  }

  // ---- names ---------------------------------------------------------------------------------------------------------

  /** Daemon tables of projects and conversations. Absent in an enterprise tenant database. */
  private sql() {
    if (this.sqlCache === undefined) {
      try {
        const { db } = this.deps;
        this.sqlCache = {
          projects: db.prepare("SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC"),
          conversations: db.prepare(
            `SELECT id, project_id, title, updated_at FROM (
               SELECT id, project_id, title, updated_at,
                      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, rowid DESC) AS n
                 FROM conversations
                WHERE id NOT LIKE '${COMMENT_ANCHOR_PREFIX}%'
             ) WHERE n <= ?`,
          ),
          projectName: db.prepare("SELECT name FROM projects WHERE id = ?"),
          conversationTitle: db.prepare("SELECT title FROM conversations WHERE id = ?"),
        };
      } catch {
        this.sqlCache = null;
      }
    }
    return this.sqlCache;
  }

  private projectName(id: string): string | undefined {
    return (this.sql()?.projectName.get(id) as { name: string } | undefined)?.name;
  }

  private studioConversation(id: string): { title: string | null } | undefined {
    return this.sql()?.conversationTitle.get(id) as { title: string | null } | undefined;
  }

  private conversationTitle(id: string): string | undefined {
    const studio = this.studioConversation(id);
    if (studio) return studio.title?.trim() || undefined;
    return this.pa.store.get<PaConversation>("conversations", id)?.title;
  }

  private labelOf(scope: MemoryScopeRef): string | undefined {
    switch (scope.kind) {
      case "profile":
        return "个人画像";
      case "persona":
        return this.pa.store.get<PaPersona>("personas", scope.id)?.name;
      case "bot":
        return this.pa.store.get<PersonalAgent>("agents", scope.id)?.name;
      case "group":
        return this.pa.store.get<PaGroup>("groups", scope.id)?.name;
      case "project":
        return this.projectName(scope.id);
      case "conversation":
        return this.conversationTitle(scope.id);
    }
  }

  private scopeExists(scope: MemoryScopeRef): boolean {
    switch (scope.kind) {
      case "profile":
        return true;
      case "persona":
        return this.pa.store.has("personas", scope.id);
      case "bot":
        return this.pa.store.has("agents", scope.id);
      case "group":
        return this.pa.store.has("groups", scope.id);
      case "project":
        // An enterprise tenant database has no project table; its project ids come from the member's own tasks.
        return this.enterprise || this.projectName(scope.id) !== undefined;
      case "conversation":
        return this.studioConversation(scope.id) !== undefined || this.pa.store.has("conversations", scope.id);
    }
  }

  /** A scope a write may target: well formed, existing, and allowed by the organization's companion policy. */
  private writableScope(scope: ScopeInput): MemoryScopeRef {
    const clean = cleanScope(scope);
    if (!this.scopeExists(clean)) throw invalid(`The ${clean.kind} ${clean.id} does not exist.`);
    if (this.enterprise && clean.kind === "bot" && !this.pa.companionPolicy().memory) {
      throw new PaError("组织没有启用角色记忆", 403, "PA_POLICY");
    }
    return clean;
  }

  // ---- ownership ---------------------------------------------------------------------------------------------------

  private ownedRow(id: string, caller: MemoryCaller): MemoryItemRow {
    const row = this.engine.getRow(id);
    if (!row || (caller.member && row.principalId !== caller.member.id)) throw notFound("Memory", id);
    return row;
  }

  private ownedConflict(id: string, caller: MemoryCaller): MemoryConflict {
    const conflict = this.engine.getConflict(id);
    if (!conflict) throw notFound("Conflict", id);
    this.ownedRow(conflict.incoming.id, caller);
    return conflict;
  }

  private assertLedgerId(id: string): void {
    if (id.startsWith(MEMORY_STUDIO_PREFIX)) throw readOnly();
  }

  /** Engine changes that may alter what a running Personal Agent task read earlier. */
  private changed(items: ReadonlyArray<Pick<MemoryItem, "id">>): void {
    this.pa.memoryChanged(items.map((item) => item.id));
  }

  // ---- Settings → 记忆 entries (read only) --------------------------------------------------------------------------

  private studioItem(entry: StudioEntry, active: boolean): MemoryItem {
    const scope: MemoryScopeRef = entry.projectId
      ? { kind: "project", id: entry.projectId }
      : { kind: "profile", id: "" };
    return {
      id: `${MEMORY_STUDIO_PREFIX}${entry.id}`,
      scope,
      scopeLabel: this.labelOf(scope),
      kind: STUDIO_KINDS[entry.type] ?? "fact",
      status: active ? "active" : "archived",
      origin: entry.source === "llm" || entry.source === "heuristic" ? "llm_inferred" : "user_explicit",
      pinned: entry.id === PROFILE_MEMORY_ID || entry.type === "rule",
      dataClass: "standard",
      title: entry.name,
      content: entry.body.trim(),
      source: STUDIO_SOURCE,
      sourceRefs: [{ kind: "studio_memory", id: entry.id }],
      via: null,
      authorId: null,
      eventAt: null,
      dueAt: null,
      validFrom: null,
      validUntil: null,
      supersededBy: null,
      revision: 1,
      versionCount: 1,
      openConflictIds: [],
      redacted: false,
      backing: "studio",
      readOnly: true,
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
    };
  }

  /** Entries that are switched on in Settings (listed in MEMORY.md, or the profile) and belong to this scope. */
  private async studioItems(scope: MemoryScopeRef): Promise<MemoryItem[]> {
    if (this.enterprise || (scope.kind !== "profile" && scope.kind !== "project")) return [];
    const dir = this.deps.runtimeDataDir;
    const [summaries, indexBody] = await Promise.all([
      listMemoryEntries(dir, { includeAllProjects: true }) as Promise<Array<Omit<StudioEntry, "body">>>,
      readMemoryIndex(dir) as Promise<string>,
    ]);
    const linked = linkedStudioIds(indexBody);
    const inScope = summaries.filter(
      (entry) =>
        (entry.id === PROFILE_MEMORY_ID || linked.has(entry.id)) &&
        (scope.kind === "project" ? entry.projectId === scope.id : !entry.projectId),
    );
    const items: MemoryItem[] = [];
    for (const summary of inScope) {
      const entry = (await readMemoryEntry(dir, summary.id)) as StudioEntry | null;
      if (entry?.body.trim()) items.push(this.studioItem(entry, true));
    }
    return items;
  }

  private async studioItemById(id: string): Promise<MemoryItem> {
    if (this.enterprise) throw notFound("Memory", id);
    const dir = this.deps.runtimeDataDir;
    const slug = id.slice(MEMORY_STUDIO_PREFIX.length);
    const entry = (await readMemoryEntry(dir, slug)) as StudioEntry | null;
    if (!entry) throw notFound("Memory", id);
    const linked = linkedStudioIds((await readMemoryIndex(dir)) as string);
    return this.studioItem(entry, entry.id === PROFILE_MEMORY_ID || linked.has(entry.id));
  }

  // ---- overview ------------------------------------------------------------------------------------------------------

  /** Pending Personal Agent memory candidates this caller may see, with the scope each would be saved into. */
  private pendingCandidates(caller: MemoryCaller): Array<{ candidate: PaMemoryCandidate; task: PaTask | null; scope: MemoryScopeRef }> {
    const out: Array<{ candidate: PaMemoryCandidate; task: PaTask | null; scope: MemoryScopeRef }> = [];
    for (const candidate of this.pa.store.list<PaMemoryCandidate>("memory_candidates")) {
      if (candidate.status !== "pending") continue;
      const task = this.pa.store.get<PaTask>("tasks", candidate.taskId);
      if (caller.member && !(task && this.pa.kernel?.policy.owns(caller.member, task))) continue;
      const kind: PaMemoryScope = candidate.targetScope ?? (task?.kind === "chat" || !task?.projectId ? "agent" : "project");
      const scopeId =
        candidate.targetScopeId !== undefined
          ? candidate.targetScopeId
          : kind === "project"
            ? (task?.projectId ?? null)
            : kind === "private"
              ? null
              : (candidate.agentId ?? task?.participantIds[0] ?? null);
      if (kind === "private" || scopeId) out.push({ candidate, task, scope: engineScopeOf(kind, scopeId) });
    }
    return out;
  }

  private countsFor(caller: MemoryCaller): Map<string, MemoryScopeCounts> {
    const counts = this.engine.scopeCounts(this.principalOf(caller));
    for (const { scope } of this.pendingCandidates(caller)) {
      const key = memoryScopeKey(scope);
      const entry = counts.get(key) ?? emptyCounts();
      entry.pending += 1;
      counts.set(key, entry);
    }
    return counts;
  }

  /** Windows readable by the scope. The engine counts them across members, so an enterprise member's are counted here. */
  private chunkCount(scope: MemoryScopeRef, counts: MemoryScopeCounts, caller: MemoryCaller): number {
    if (!caller.member) return counts.chunks;
    return this.engine.listChunks({ scope, principalId: caller.member.id, limit: 1 }).total;
  }

  private node(
    scope: MemoryScopeRef,
    label: string,
    countsByKey: Map<string, MemoryScopeCounts>,
    caller: MemoryCaller,
    extra: Partial<MemoryScopeNode> = {},
  ): MemoryScopeNode {
    const counts = { ...(countsByKey.get(memoryScopeKey(scope)) ?? emptyCounts()) };
    counts.chunks = this.chunkCount(scope, counts, caller);
    return { scope, label, counts, ...extra };
  }

  private policyView(agent: PersonalAgent, engineMode: MemoryAutoMode): MemoryAgentPolicyView {
    const policy = agent.memoryPolicy;
    return {
      profileMount: policy?.profileMount,
      autoMemoryMode: policy?.autoMemoryMode,
      effectiveProfileMount: this.pa.memoryAccessFor({ surface: "pa", agentId: agent.id }).profileMount ?? "none",
      effectiveAutoMemoryMode: policy?.autoMemoryMode ?? PA_AUTO_MODE[engineMode],
    };
  }

  private botNode(
    agent: PersonalAgent,
    countsByKey: Map<string, MemoryScopeCounts>,
    caller: MemoryCaller,
    engineMode: MemoryAutoMode,
  ): MemoryScopeNode {
    return this.node({ kind: "bot", id: agent.id }, agent.name, countsByKey, caller, {
      avatar: agent.avatar,
      policy: this.policyView(agent, engineMode),
      isCharacter: this.pa.store.has("characters", agent.id),
      updatedAt: agent.updatedAt,
    });
  }

  private projectNodes(countsByKey: Map<string, MemoryScopeCounts>, caller: MemoryCaller): MemoryScopeNode[] {
    const sql = this.sql();
    if (!sql || this.enterprise) return [];
    const children = new Map<string, MemoryScopeNode[]>();
    for (const row of sql.conversations.all(CONVERSATIONS_PER_PROJECT) as ConversationRow[]) {
      const node = this.node(
        { kind: "conversation", id: row.id },
        row.title?.trim() || "未命名对话",
        countsByKey,
        caller,
        { updatedAt: row.updated_at },
      );
      const list = children.get(row.project_id);
      if (list) list.push(node);
      else children.set(row.project_id, [node]);
    }
    return (sql.projects.all() as ProjectRow[]).map((row) =>
      this.node({ kind: "project", id: row.id }, row.name, countsByKey, caller, {
        children: children.get(row.id) ?? [],
        updatedAt: row.updated_at,
      }),
    );
  }

  async overview(caller: MemoryCaller): Promise<MemoryOverviewResponse> {
    // Windows of project conversations deleted since they were read are dropped before anything is counted or
    // listed. Project conversations live in the daemon database; a tenant database holds none.
    if (this.pa.store.db === this.deps.db) {
      try {
        sweepDeletedStudioConversations(this.engine.chunkSink, this.deps.db);
      } catch (error) {
        console.warn("[memory] sweeping deleted conversations failed", error);
      }
    }
    const countsByKey = this.countsFor(caller);
    const engineConfig = this.engine.config();
    const hidden = caller.member && caller.member.role !== "admin" ? this.pa.hiddenAgents(caller.member.groups) : null;

    const agents = this.pa.store.list<PersonalAgent>("agents").filter((agent) => !hidden?.has(agent.id));
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    const groups = this.pa.store
      .list<PaGroup>("groups")
      .filter((group) => !hidden || !group.memberIds.some((id) => hidden.has(id)));
    // A persona belongs to the member who wrote it; in personal mode to nobody in particular.
    const personas = this.pa.store
      .list<PaPersona>("personas")
      .filter((persona) => (persona.principalId ?? null) === (caller.member?.id ?? null));

    let items = 0;
    let chunks = 0;
    let conflicts = 0;
    let pending = 0;
    for (const [key, counts] of countsByKey) {
      items += counts.active;
      conflicts += counts.conflicts;
      pending += counts.pending;
      if (key.startsWith("conversation:")) chunks += counts.chunks;
    }
    // The engine counts windows and indexed documents across members; a member is told only about their own.
    const status = this.engine.status();
    if (caller.member) {
      chunks = this.engine.listChunks({ principalId: caller.member.id, limit: 1 }).total;
      status.documents = items + chunks;
    }

    return {
      enabled: ((await readMemoryConfig(this.deps.runtimeDataDir)) as { enabled: boolean }).enabled,
      mode: this.pa.kernel?.mode ?? "personal",
      profile: this.node({ kind: "profile", id: "" }, "个人画像", countsByKey, caller),
      personas: personas.map((persona) =>
        this.node({ kind: "persona", id: persona.id }, persona.name, countsByKey, caller, {
          ...(persona.description.trim() ? { sublabel: persona.description.trim() } : {}),
          isDefault: persona.isDefault,
          updatedAt: persona.updatedAt,
        }),
      ),
      bots: agents.map((agent) => this.botNode(agent, countsByKey, caller, engineConfig.autoMemory)),
      groups: groups.map((group) =>
        this.node({ kind: "group", id: group.id }, group.name, countsByKey, caller, {
          members: group.memberIds.map((id) => ({ id, name: names.get(id) ?? id })),
          updatedAt: group.updatedAt,
        }),
      ),
      projects: this.projectNodes(countsByKey, caller),
      inbox: { conflicts, pending },
      totals: { items, chunks },
      engine: status,
    };
  }

  // ---- items ---------------------------------------------------------------------------------------------------------

  async listItems(query: MemoryItemListQuery, caller: MemoryCaller): Promise<MemoryItemListResponse> {
    const scope = queryScope(query);
    const text = query.query?.trim() || undefined;
    const limit = query.limit ?? DEFAULT_ITEM_LIMIT;
    const offset = query.offset ?? 0;
    const ledger = this.engine.listItems({
      scope,
      statuses: query.status === "all" ? [...MEMORY_ITEM_STATUSES] : [query.status ?? "active"],
      kind: query.kind,
      pinned: query.pinned,
      viaGroup: query.viaGroup,
      text,
      principalId: this.principalOf(caller),
      includeLocalOnly: true,
      limit,
      offset,
    });

    const withStudio =
      scope !== undefined &&
      query.includeStudio !== false &&
      (query.status === undefined || query.status === "active") &&
      query.viaGroup !== true;
    if (!withStudio) return ledger;

    const needle = text ? folded(text) : null;
    const studio = (await this.studioItems(scope)).filter(
      (item) =>
        (query.kind === undefined || item.kind === query.kind) &&
        (query.pinned === undefined || item.pinned === query.pinned) &&
        (needle === null || folded(`${item.title}\n${item.content}`).includes(needle)),
    );
    // Ledger memories come first; Settings entries fill what is left of the page and continue on the next one.
    const items = [...ledger.items];
    const room = limit - items.length;
    if (room > 0) {
      const start = Math.max(0, offset - ledger.total);
      items.push(...studio.slice(start, start + room));
    }
    return { items, total: ledger.total + studio.length };
  }

  async getItem(id: string, caller: MemoryCaller): Promise<MemoryItemResponse> {
    if (id.startsWith(MEMORY_STUDIO_PREFIX)) return { item: await this.studioItemById(id) };
    this.ownedRow(id, caller);
    return { item: this.engine.getItem(id)! };
  }

  async history(id: string, caller: MemoryCaller): Promise<MemoryItemHistoryResponse> {
    if (id.startsWith(MEMORY_STUDIO_PREFIX)) {
      const item = await this.studioItemById(id);
      return {
        item,
        versions: [
          { version: 1, title: item.title, content: item.content, actor: OWNER, note: "", createdAt: item.updatedAt },
        ],
        events: [],
        links: [],
        related: [],
        conflicts: [],
      };
    }
    this.ownedRow(id, caller);
    return this.engine.history(id);
  }

  createItem(input: CreateMemoryItemRequest, caller: MemoryCaller): CreateMemoryItemResponse {
    const principalId = this.principalOf(caller);
    return this.engine.remember({
      scope: this.writableScope(input.scope),
      content: input.content,
      title: input.title,
      kind: input.kind,
      pinned: input.pinned,
      dataClass: input.dataClass,
      origin: input.origin,
      source: input.source,
      sourceRefs: input.sourceRefs,
      via: input.via,
      eventAt: input.eventAt,
      dueAt: input.dueAt,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      ...(principalId ? { principalId } : {}),
      actor: OWNER,
    });
  }

  updateItem(id: string, patch: UpdateMemoryItemRequest, caller: MemoryCaller): UpdateMemoryItemResponse {
    this.assertLedgerId(id);
    this.ownedRow(id, caller);
    const result = this.engine.revise(id, { ...patch, actor: OWNER });
    this.changed([result.item]);
    return result;
  }

  itemAction(id: string, request: MemoryItemActionRequest, caller: MemoryCaller): MemoryItemResponse {
    this.assertLedgerId(id);
    this.ownedRow(id, caller);
    let item: MemoryItem;
    switch (request.action) {
      case "archive":
        item = this.engine.archive(id, OWNER, request.revision);
        break;
      case "restore":
        item = this.engine.restore(id, OWNER, request.revision);
        break;
      case "redact":
        if (request.confirm !== true) throw invalid("Redacting clears the text for good. Send confirm: true to do it.");
        item = this.engine.redact(id, OWNER);
        break;
    }
    this.changed([item]);
    return { item };
  }

  async copyItem(id: string, request: CopyMemoryItemRequest, caller: MemoryCaller): Promise<CreateMemoryItemResponse> {
    const scope = this.writableScope(request.scope);
    if (!id.startsWith(MEMORY_STUDIO_PREFIX)) {
      this.ownedRow(id, caller);
      return this.engine.copy(id, scope, OWNER, request.title);
    }
    const source = await this.studioItemById(id);
    return this.engine.remember({
      scope,
      content: source.content,
      title: request.title ?? source.title,
      kind: source.kind,
      origin: source.origin,
      source: `复制自 ${STUDIO_SOURCE}`,
      sourceRefs: source.sourceRefs,
      actor: OWNER,
    });
  }

  // ---- inbox: disagreements and proposals ------------------------------------------------------------------------

  private pendingEntryOfItem(item: MemoryItem): MemoryPendingEntry {
    return {
      id: `${MEMORY_PENDING_ITEM_PREFIX}${item.id}`,
      source: "item",
      scope: item.scope,
      scopeLabel: item.scopeLabel,
      kind: item.kind,
      content: item.content,
      sourceLabel: item.source,
      via: item.via,
      revision: item.revision,
      createdAt: item.createdAt,
    };
  }

  private pendingEntryOfCandidate(
    candidate: PaMemoryCandidate,
    task: PaTask | null,
    scope: MemoryScopeRef,
  ): MemoryPendingEntry {
    const agent = candidate.agentId ? this.pa.store.get<PersonalAgent>("agents", candidate.agentId) : null;
    const conversation = candidate.conversationId
      ? this.pa.store.get<PaConversation>("conversations", candidate.conversationId)
      : null;
    const group = conversation?.groupId ? this.pa.store.get<PaGroup>("groups", conversation.groupId) : null;
    const via: MemoryVia | null =
      conversation?.groupId && group
        ? {
            groupId: group.id,
            groupName: group.name,
            conversationId: conversation.id,
            conversationTitle: conversation.title,
          }
        : null;
    const goal = task?.goal.trim().slice(0, 40);
    return {
      id: `${MEMORY_PENDING_PA_PREFIX}${candidate.id}`,
      source: "pa_candidate",
      scope,
      scopeLabel: this.labelOf(scope),
      kind: candidate.kind ?? "fact",
      content: candidate.content,
      sourceLabel: task && task.kind !== "chat" && goal ? `任务 · ${goal}` : `对话 · ${agent?.name ?? "助手"}`,
      via,
      revision: candidate.revision,
      createdAt: candidate.createdAt,
    };
  }

  inbox(caller: MemoryCaller): MemoryInboxResponse {
    const principalId = this.principalOf(caller);
    const proposals = this.engine.listItems({
      statuses: ["pending"],
      principalId,
      includeLocalOnly: true,
      order: "created_desc",
      limit: INBOX_LIMIT,
    });
    const pending = [
      ...proposals.items.map((item) => this.pendingEntryOfItem(item)),
      ...this.pendingCandidates(caller).map(({ candidate, task, scope }) =>
        this.pendingEntryOfCandidate(candidate, task, scope),
      ),
    ].sort((a, b) => b.createdAt - a.createdAt);
    return {
      conflicts: this.engine.listConflicts({ status: "open", principalId, limit: INBOX_LIMIT }),
      pending,
    };
  }

  async resolvePending(
    entryId: string,
    request: ResolveMemoryPendingRequest,
    caller: MemoryCaller,
  ): Promise<ResolveMemoryPendingResponse> {
    if (entryId.startsWith(MEMORY_PENDING_ITEM_PREFIX)) {
      return this.resolveProposal(entryId, entryId.slice(MEMORY_PENDING_ITEM_PREFIX.length), request, caller);
    }
    if (entryId.startsWith(MEMORY_PENDING_PA_PREFIX)) {
      return this.resolveCandidate(entryId, entryId.slice(MEMORY_PENDING_PA_PREFIX.length), request, caller);
    }
    throw invalid(`A proposal id starts with "${MEMORY_PENDING_ITEM_PREFIX}" or "${MEMORY_PENDING_PA_PREFIX}".`);
  }

  private resolveProposal(
    entryId: string,
    id: string,
    request: ResolveMemoryPendingRequest,
    caller: MemoryCaller,
  ): ResolveMemoryPendingResponse {
    this.ownedRow(id, caller);
    if (!request.accept) {
      const item = this.engine.reject(id, OWNER, request.revision);
      this.changed([item]);
      return { entryId, accepted: false, item: null, conflicts: [] };
    }
    const result = this.engine.accept(
      id,
      OWNER,
      {
        content: request.content,
        kind: request.kind,
        scope: request.scope ? this.writableScope(request.scope) : undefined,
      },
      request.revision,
    );
    this.changed([result.item]);
    return { entryId, accepted: true, item: result.item, conflicts: result.conflicts };
  }

  private resolveCandidate(
    entryId: string,
    id: string,
    request: ResolveMemoryPendingRequest,
    caller: MemoryCaller,
  ): ResolveMemoryPendingResponse {
    const candidate = this.pa.store.get<PaMemoryCandidate>("memory_candidates", id);
    const task = candidate ? this.pa.store.get<PaTask>("tasks", candidate.taskId) : null;
    if (!candidate || (caller.member && !(task && this.pa.kernel?.policy.owns(caller.member, task)))) {
      throw new PaError("记录不存在", 404, "PA_NOT_FOUND");
    }
    const target = request.scope ? paScopeOf(this.writableScope(request.scope)) : null;
    if (request.scope && !target) {
      throw invalid("A proposal from a task can only be accepted into the profile, a bot, a group or a project.");
    }
    const resolved = this.pa.resolveMemoryCandidate(id, request.revision ?? candidate.revision, request.accept, {
      ...(target ? { scope: target.scope, scopeId: target.scopeId } : {}),
      ...(request.content ? { content: request.content } : {}),
      ...(request.kind ? { kind: paKindOf(request.kind) } : {}),
    });
    const item = request.accept && resolved.memoryId ? this.engine.getItem(resolved.memoryId) : null;
    const conflicts = (item?.openConflictIds ?? []).flatMap((conflictId) => this.engine.getConflict(conflictId) ?? []);
    return { entryId, accepted: request.accept, item, conflicts };
  }

  // ---- conflicts -----------------------------------------------------------------------------------------------------

  listConflicts(query: { status?: "open" | "resolved" | undefined }, caller: MemoryCaller): MemoryConflictListResponse {
    const conflicts = this.engine.listConflicts({
      status: query.status,
      principalId: this.principalOf(caller),
      limit: INBOX_LIMIT,
    });
    return { conflicts, total: conflicts.length };
  }

  getConflict(id: string, caller: MemoryCaller): { conflict: MemoryConflict } {
    return { conflict: this.ownedConflict(id, caller) };
  }

  resolveConflict(
    id: string,
    request: ResolveMemoryConflictRequest,
    caller: MemoryCaller,
  ): ResolveMemoryConflictResponse {
    this.ownedConflict(id, caller);
    const result = this.engine.resolveConflict(id, {
      resolution: request.resolution,
      mergedContent: request.mergedContent,
      mergedTitle: request.mergedTitle,
      actor: OWNER,
    });
    this.changed(result.items);
    return result;
  }

  mergeDraft(id: string, caller: MemoryCaller): Promise<MemoryMergeDraftResponse> {
    this.ownedConflict(id, caller);
    return this.engine.mergeDraft(id);
  }

  // ---- recall and raw windows ------------------------------------------------------------------------------------

  /** The Memory Center's own recalls are inspections: they are never written to the recall log. */
  async recall(request: MemoryRecallRequest, caller: MemoryCaller): Promise<MemoryRecallResponse> {
    const principalId = this.principalOf(caller);
    const common = {
      query: request.query,
      limit: request.limit,
      budgetChars: request.budgetChars,
      includeChunks: request.includeChunks,
      ...(principalId ? { principalId } : {}),
    };
    const { context } = request;
    // A project conversation reads the owner profile only while Settings → 记忆 keeps it on; the inspection says
    // what the real run would read.
    const ownerProfile =
      context?.surface === "studio"
        ? ((await readMemoryConfig(this.deps.runtimeDataDir)) as { profileEnabled?: boolean }).profileEnabled !== false
        : undefined;
    const result = context
      ? await this.engine.recall({
          ...common,
          access: {
            ...this.pa.memoryAccessFor({
              surface: context.surface,
              ...(ownerProfile === undefined ? {} : { ownerProfile }),
              ...(context.projectId ? { projectId: context.projectId } : {}),
              ...(context.conversationId ? { conversationId: context.conversationId } : {}),
              ...(context.agentId ? { agentId: context.agentId } : {}),
              ...(context.groupId ? { groupId: context.groupId } : {}),
            }),
            ...(principalId ? { principalId } : {}),
          },
        })
      : await this.engine.recall({ ...common, scopes: (request.scopes ?? []).map(cleanScope) });
    const { itemRefs: _itemRefs, ...response } = result;
    return response;
  }

  listChunks(query: MemoryChunkListQuery, caller: MemoryCaller): MemoryChunkListResponse {
    const scope = queryScope(query);
    return this.engine.listChunks({
      scope,
      conversationId: query.conversationId,
      principalId: this.principalOf(caller),
      limit: query.limit ?? DEFAULT_CHUNK_LIMIT,
      offset: query.offset,
    });
  }

  getChunk(id: string, caller: MemoryCaller): MemoryChunkDetailResponse {
    const found = this.engine.getChunk(id);
    // A conversation belongs to one member, so having windows in it is what makes its windows the member's.
    const visible =
      found !== null &&
      (!caller.member ||
        this.engine.listChunks({ conversationId: found.chunk.conversationId, principalId: caller.member.id, limit: 1 })
          .total > 0);
    if (!found || !visible) throw notFound("Conversation window", id);
    return found;
  }

  // ---- engine ----------------------------------------------------------------------------------------------------

  getEngine(): MemoryEngineResponse {
    return { config: this.engine.config(), status: this.engine.status() };
  }

  updateEngine(patch: UpdateMemoryEngineConfigRequest): MemoryEngineResponse {
    this.engine.updateConfig(patch);
    return this.getEngine();
  }

  async modelAction(id: string, action: "download" | "cancel"): Promise<MemoryEngineResponse> {
    await this.engine.localModelAction(id, action);
    return this.getEngine();
  }

  async reindex(request: MemoryReindexRequest): Promise<MemoryReindexResponse> {
    const { documents, durationMs } = await this.engine.reindex({ vectors: request.vectors });
    return { ok: true, documents, durationMs };
  }

  tidy(request: MemoryTidyRequest): Promise<MemoryTidyResponse> {
    return this.engine.tidy(request.scope ? cleanScope(request.scope) : undefined);
  }

  // ---- bot policy ----------------------------------------------------------------------------------------------------

  updateAgentPolicy(
    agentId: string,
    request: UpdateAgentMemoryPolicyRequest,
    caller: MemoryCaller,
  ): UpdateAgentMemoryPolicyResponse {
    const existing = this.pa.store.require<PersonalAgent>("agents", agentId);
    const memoryPolicy = {
      ...(existing.memoryPolicy ?? {}),
      ...(request.profileMount !== undefined ? { profileMount: request.profileMount } : {}),
      ...(request.autoMemoryMode !== undefined ? { autoMemoryMode: request.autoMemoryMode } : {}),
    };
    const agent = this.pa.updateAgent(
      agentId,
      {
        name: existing.name,
        role: existing.role,
        avatar: existing.avatar,
        enabled: existing.enabled,
        tools: existing.tools,
        model: existing.model,
        memoryPolicy,
      },
      request.revision ?? existing.revision,
    );
    return {
      agent,
      node: this.botNode(agent, this.countsFor(caller), caller, this.engine.config().autoMemory),
    };
  }
}
