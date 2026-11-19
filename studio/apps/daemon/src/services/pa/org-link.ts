import type { PaEmotion, PaEntity, PaLorebook, PaOrgLinkStatus, PaStylePreset } from "@open-design/contracts";
import type { OrgDirectorySync, OrgLibraryItem, OrgLibrarySync } from "@open-design/contracts/org";
import { paSpritesSchema } from "@open-design/contracts/soul";
import { PaError, type PaStore } from "../../storage/personal-agent-store.js";
import type { PaImportCardInput, PaSoulService } from "../personal-agent-soul.js";

/** A library item of the organization server and the local record it became (collection `org_library`, id = the
 *  server's item id). */
export interface PaOrgLibraryRecord extends PaEntity {
  kind: OrgLibraryItem["kind"];
  localId: string;                       // agent id (character), world book id or style preset id
  version: number;                       // the server's library clock when this copy was taken
  audience: string[] | null;             // group ids the item is for; null for everyone
  assets: Record<string, string>;        // image role → sha256 of the image already imported
  retired: boolean;                      // no longer published for this daemon: the character is switched off
}
type Companion = PaOrgLinkStatus["companion"];
/** What survives a restart: how far the library was taken, and the organization's companion switches. */
type Cursor = PaEntity & { library: number; companion?: Companion };
const ALL_ON: Companion = { enabled: true, memory: true, personas: true };
type Part = PaOrgLinkStatus["directory"];

export interface PaOrgLinkDeps {
  url: URL;
  credential: () => string;
  refreshMs: number;
  store: PaStore;
  soul: PaSoulService;
  /** Replaces the member directory; returns how many members are now recognised. */
  applyDirectory(sync: OrgDirectorySync): number;
  setAgentEnabled(agentId: string, enabled: boolean): void;
  fetch?: typeof fetch;
  now?: () => number;
}

const describe = (error: unknown): string =>
  error instanceof PaError ? error.message : error instanceof Error && error.name === "TimeoutError" ? "连接企业服务器超时" : "无法连接企业服务器";

/** Follows one organization server: the member directory and the shared library are pulled from it on a timer, and
 *  what it says replaces what this daemon holds. Conversations, personas and memories are never sent anywhere. */
export class PaOrgLink {
  private readonly store: PaStore;
  private readonly fetcher: typeof fetch;
  private running: Promise<PaOrgLinkStatus> | null = null;
  private lastRun = 0;
  private directory: Part = { version: 0, syncedAt: null, count: 0, error: null };
  private library: Part = { version: 0, syncedAt: null, count: 0, error: null };
  private companion: Companion = ALL_ON;

  constructor(private readonly deps: PaOrgLinkDeps) {
    this.store = deps.store;
    this.fetcher = deps.fetch ?? fetch;
    const saved = this.store.get<Cursor>("settings", "org-link");
    this.library.version = saved?.library ?? 0;
    this.companion = saved?.companion ?? ALL_ON;
    this.library.count = this.records().filter(record => !record.retired).length;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private records(): PaOrgLibraryRecord[] { return this.store.list<PaOrgLibraryRecord>("org_library"); }
  status(): PaOrgLinkStatus {
    return { url: this.deps.url.origin, companion: { ...this.companion }, directory: { ...this.directory }, library: { ...this.library } };
  }
  /** The organization's companion switches (all on until a sync says otherwise). */
  policy(): Companion { return this.companion; }
  private remember(patch: Partial<Pick<Cursor, "library" | "companion">>): void {
    if (this.store.has("settings", "org-link")) this.store.update<Cursor>("settings", "org-link", patch);
    else this.store.create<Cursor>("settings", { library: this.library.version, ...patch }, "org-link");
  }
  /** Called from the service's maintenance timer: syncs when the refresh interval has passed. */
  tick(): void {
    if (this.running || this.now() - this.lastRun < this.deps.refreshMs) return;
    void this.sync().catch(() => undefined);
  }
  /** One pass over both parts. Each part reports its own failure; a failed part keeps what it had. */
  sync(): Promise<PaOrgLinkStatus> {
    this.running ??= (async () => {
      this.lastRun = this.now();
      try {
        try {
          const sync = await this.json<OrgDirectorySync>("/v1/sync/directory");
          const count = this.deps.applyDirectory(sync);
          const said = sync.policy?.companion;
          const companion: Companion = said && typeof said === "object"
            ? { enabled: said.enabled !== false, memory: said.memory !== false, personas: said.personas !== false } : ALL_ON;
          if (JSON.stringify(companion) !== JSON.stringify(this.companion)) this.remember({ companion });
          this.companion = companion;
          this.directory = { version: sync.version, syncedAt: this.now(), count, error: null };
        } catch (error) {
          this.directory = { ...this.directory, error: describe(error) };
        }
        try {
          const sync = await this.json<OrgLibrarySync>(`/v1/sync/library?since=${this.library.version}`);
          const failed = await this.applyLibrary(sync);
          // The cursor moves only when every item was taken: a failed one is asked for again next time.
          const version = failed.length ? this.library.version : sync.version;
          if (version !== this.library.version) this.remember({ library: version });
          this.library = {
            version, syncedAt: this.now(), count: this.records().filter(record => !record.retired).length,
            error: failed.length ? `有 ${failed.length} 个角色库条目未能导入：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}` : null,
          };
        } catch (error) {
          this.library = { ...this.library, error: describe(error) };
        }
        return this.status();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // ---- transport -------------------------------------------------------------------------------------------------
  private async request(path: string): Promise<Response> {
    const response = await this.fetcher(new URL(path, this.deps.url), {
      headers: { Authorization: `Bearer ${this.deps.credential()}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 || response.status === 403) throw new PaError("企业服务器拒绝了同步凭据", 502, "PA_ORG_LINK");
    if (!response.ok) throw new PaError(`企业服务器返回了错误（${response.status}）`, 502, "PA_ORG_LINK");
    return response;
  }
  private async json<T>(path: string): Promise<T> {
    const body = await (await this.request(path)).json() as T | null;
    if (!body || typeof body !== "object") throw new PaError("企业服务器返回了无法识别的内容", 502, "PA_ORG_LINK");
    return body;
  }
  private async image(item: OrgLibraryItem, assetId: string, mime: string): Promise<{ mime: string; data: string }> {
    const bytes = Buffer.from(await (await this.request(`/v1/library/${item.id}/assets/${assetId}`)).arrayBuffer());
    return { mime, data: bytes.toString("base64") };
  }

  // ---- library ---------------------------------------------------------------------------------------------------
  /** Applies one sync answer; returns the names of the items that could not be imported. */
  private async applyLibrary(sync: OrgLibrarySync): Promise<string[]> {
    const failed: string[] = [];
    for (const item of Array.isArray(sync.items) ? sync.items : []) {
      try {
        await this.applyItem(item);
      } catch {
        failed.push(String(item.name ?? item.id).slice(0, 40));
      }
    }
    const current = new Set(Array.isArray(sync.current) ? sync.current : []);
    for (const record of this.records()) if (!current.has(record.id) && !record.retired) this.retire(record);
    return failed;
  }
  private save(item: OrgLibraryItem, existing: PaOrgLibraryRecord | null, localId: string): void {
    const fields = {
      kind: item.kind, localId, version: item.version, retired: false,
      audience: item.audience.kind === "groups" ? [...item.audience.groupIds] : null,
      assets: Object.fromEntries(item.assets.map(asset => [asset.role, asset.sha256])),
    };
    if (existing) this.store.update<PaOrgLibraryRecord>("org_library", item.id, fields);
    else this.store.create<PaOrgLibraryRecord>("org_library", fields, item.id);
  }
  private async applyItem(item: OrgLibraryItem): Promise<void> {
    const existing = this.store.get<PaOrgLibraryRecord>("org_library", item.id);
    if (existing && existing.kind !== item.kind) throw new PaError("角色库条目的类型变了", 409, "PA_ORG_LINK");
    if (item.kind === "character") {
      const known = existing && this.store.has("agents", existing.localId) ? existing : null;
      const changed = (role: string, sha256: string) => known?.assets[role] !== sha256;
      const portraitMeta = item.assets.find(asset => asset.role === "portrait");
      const portrait = portraitMeta && changed("portrait", portraitMeta.sha256) ? await this.image(item, portraitMeta.id, portraitMeta.mime) : null;
      // Sprites are replaced as a set, so one changed image means taking all of them again.
      const spriteMeta = item.assets.filter(asset => asset.role.startsWith("sprite-"));
      const sprites: Record<string, string> = {};
      if (spriteMeta.some(asset => changed(asset.role, asset.sha256)))
        for (const asset of spriteMeta)
          sprites[asset.role.slice("sprite-".length)] = this.deps.soul.saveAsset(await this.image(item, asset.id, asset.mime)).id;
      // Only the eight moods a character can show; an image under any other role is not a sprite.
      const parsed = paSpritesSchema.safeParse(sprites);
      const spriteIds = Object.fromEntries(
        Object.entries(parsed.success ? parsed.data : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ) as Partial<Record<PaEmotion, string>>;
      const input: PaImportCardInput & { open: false } = {
        card: item.document, open: false,
        ...(known ? { agentId: known.localId } : {}),
        ...(portrait ? { portrait } : {}),
        ...(Object.keys(spriteIds).length ? { sprites: spriteIds } : {}),
      };
      const imported = this.deps.soul.importCard(input);
      this.save(item, existing, imported.agent.id);
      if (existing?.retired) this.deps.setAgentEnabled(imported.agent.id, true);
      return;
    }
    if (item.kind === "lorebook") {
      const known = existing && this.store.has("lorebooks", existing.localId) ? existing : null;
      const imported = this.deps.soul.importWorld({ world: item.document, name: item.name, ...(known ? { lorebookId: known.localId } : {}) });
      this.save(item, existing, imported.lorebook.id);
      return;
    }
    const current = existing ? this.store.get<PaStylePreset>("presets", existing.localId) : null;
    const saved = current
      ? this.deps.soul.savePreset(item.document, current.id, current.revision)
      : this.deps.soul.savePreset(item.document);
    this.save(item, existing, saved.id);
  }
  /** An item this daemon may no longer show. A character is switched off and kept, so the chats members had with it
   *  still read; a world book or a style is removed with the references to it. */
  private retire(record: PaOrgLibraryRecord): void {
    if (record.kind === "character") {
      if (this.store.has("agents", record.localId)) this.deps.setAgentEnabled(record.localId, false);
      this.store.update<PaOrgLibraryRecord>("org_library", record.id, { retired: true });
      return;
    }
    try {
      if (record.kind === "lorebook") {
        const book = this.store.get<PaLorebook>("lorebooks", record.localId);
        if (book) this.deps.soul.removeLorebook(book.id, book.revision);
      } else {
        const preset = this.store.get<PaStylePreset>("presets", record.localId);
        if (preset) this.deps.soul.removePreset(preset.id, preset.revision);
      }
    } finally {
      this.store.remove("org_library", record.id);
    }
  }
  /** Agents of synced characters that are for certain groups and that `groups` is not in. */
  hiddenAgents(groups: readonly string[]): Set<string> {
    const hidden = new Set<string>();
    for (const record of this.records())
      if (record.kind === "character" && record.audience && !record.audience.some(group => groups.includes(group))) hidden.add(record.localId);
    return hidden;
  }
  /** Whether the agent is one of the organization's synced characters (and so is edited on the server only). */
  manages(agentId: string): boolean {
    return this.records().some(record => record.kind === "character" && record.localId === agentId);
  }
}
