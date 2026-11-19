import { createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PaAttempt, PaEntity, PaModel, PaPrincipal, PaTask } from "@open-design/contracts";
import type { SqliteDb } from "../../db.js";
import type { PaModelRuntime } from "../../runtimes/personal-agent.js";
import { PaError, PaStore } from "../../storage/personal-agent-store.js";
import { paDigest, redactPaCredentials } from "../personal-agent-gateway.js";
import { createPaManagedCredentials, type PaCredentialDriver } from "./credentials.js";
import { PaDistributedScheduler, type WorkerWork } from "./distributed.js";
import { loadPaConfig, paMemberSchema, readPrivatePaFile, trustedPaUrl, type PaConfig, type PaMember, type PaQuota, type PaWorkerIdentity } from "./config.js";
import { PaOciSandbox } from "./sandbox.js";

type EnterprisePrincipal = Extract<PaPrincipal, { kind: "enterprise" }>;
type Revocation = PaEntity & { throughVersion: number };
type Reservation = PaEntity & { day: string; group: string; role: PaMember["role"]; reserved: PaQuota };
type StoredDirectory = PaEntity & { version: number; members: PaMember[] };

/** The members this daemon recognises. A static configuration never changes it; an organization server replaces it. */
export interface PaDirectoryDriver {
  members(): readonly PaMember[];
  version(): number;
  /** Takes the server's list for `tenantId`. Entries that do not parse are dropped; a member whose group has no
   *  quota is budgeted under `default`. Returns how many members are now recognised. */
  replace(tenantId: string, version: number, entries: readonly unknown[]): number;
}

export interface PaIdentityDriver {
  member(header: string | undefined): PaMember | null;
  /** The member with this id while the grant is current: not expired, not revoked. */
  memberById(id: string): PaMember | null;
  worker(header: string | undefined): PaWorkerIdentity | null;
  principal(member: PaMember): EnterprisePrincipal;
  valid(task: PaTask): boolean;
  revoke(kind: "member" | "worker", id: string): void;
}
export interface PaPolicyDriver {
  admits(task: PaTask, model: PaModel, work: WorkerWork | null): void;
  reserve(task: PaTask, attempt: PaAttempt, work: WorkerWork | null, remainingMs: number, delegated?: { kind: "plan" | "broker"; model: PaModel }): void;
  owns(member: PaMember, task: PaTask): boolean;
}
export interface PaIsolationDriver {
  execute(script: string, timeoutMs: number, signal: AbortSignal): Promise<string>;
}
export interface PaStorageDriver {
  db: SqliteDb;
  dataDir: string;
  projectsDir: string;
  privateProjects: boolean;
  close(): void;
}
export interface PaSchedulerDriver {
  distributed: PaDistributedScheduler | null;
}
export interface PaKernel {
  readonly mode: PaConfig["mode"];
  readonly tenantId?: string;
  readonly store: PaStore;
  readonly identity: PaIdentityDriver;
  readonly policy: PaPolicyDriver;
  readonly credentials: PaCredentialDriver;
  readonly isolation: PaIsolationDriver | null;
  readonly storage: PaStorageDriver;
  readonly scheduler: PaSchedulerDriver;
  readonly managedModels: readonly PaModel[];
  readonly directory: PaDirectoryDriver;
  /** The organization server this daemon follows, when one is configured. */
  readonly org: { url: URL; refreshMs: number; credential(): string } | null;
  audit(): { valid: boolean; entries: number; head: string | null; checkpoint?: { tenantId: string; entries: number; head: string | null; signature: string } };
  verifyCheckpoint(checkpoint: { tenantId: string; entries: number; head: string | null; signature: string }): boolean;
}

const unauthorized = () => new PaError("原任务委托已过期、撤销或超出权限", 403, "PA_DELEGATION_DENIED");

function tenantStorage(config: PaConfig, dataDir: string, projectsDir: string, db: SqliteDb): PaStorageDriver {
  if (!config.enterprise) return { db, dataDir, projectsDir, privateProjects: false, close() {} };
  const root = path.join(dataDir, "pa", "tenants", paDigest(config.enterprise.tenantId));
  for (const dir of [path.join(dataDir, "pa"), path.join(dataDir, "pa", "tenants"), root]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new PaError("PA 租户存储位置无效", 503, "PA_CONFIG");
  }
  chmodSync(root, 0o700);
  const file = path.join(root, "state.sqlite");
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new PaError("PA 租户数据库位置无效", 503, "PA_CONFIG");
  const database = new Database(file);
  chmodSync(file, 0o600);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  return {
    db: database, dataDir: root, projectsDir: path.join(root, "projects"), privateProjects: true,
    close() { if (database.open) database.close(); },
  };
}

export function createPaKernel(input: {
  configPath?: string; db: SqliteDb; dataDir: string; projectsDir: string; localRuntime: PaModelRuntime;
}): PaKernel {
  const config = loadPaConfig(input.configPath);
  const enterprise = config.enterprise;
  const storage = tenantStorage(config, input.dataDir, input.projectsDir, input.db);
  const store = new PaStore(storage.db);
  const isRevoked = (kind: "member" | "worker", id: string, version: number) =>
    (store.get<Revocation>("revocations", `${kind}:${id}`)?.throughVersion ?? -1) >= version;
  // The last directory an organization server sent survives a restart, so members keep working while it is away.
  const synced = enterprise?.orgServer ? store.get<StoredDirectory>("settings", "org-directory") : null;
  let members: PaMember[] = synced?.members ?? enterprise?.members ?? [];
  let directoryVersion = synced?.version ?? 0;
  const directory: PaDirectoryDriver = {
    members: () => members,
    version: () => directoryVersion,
    replace(tenantId, version, entries) {
      if (!enterprise?.orgServer) throw new PaError("此部署没有连接企业服务器", 409, "PA_CONFIG");
      if (tenantId !== enterprise.tenantId) throw new PaError("企业服务器的组织编号与本机配置不一致", 409, "PA_CONFIG");
      const seen = new Set<string>();
      const next = entries.flatMap(entry => {
        const parsed = paMemberSchema.safeParse(entry);
        if (!parsed.success || seen.has(parsed.data.id)) return [];
        seen.add(parsed.data.id);
        return [{ ...parsed.data, group: enterprise.budgets.groups[parsed.data.group] ? parsed.data.group : "default" }];
      });
      if (version !== directoryVersion || JSON.stringify(next) !== JSON.stringify(members)) {
        if (store.has("settings", "org-directory")) store.update<StoredDirectory>("settings", "org-directory", { version, members: next });
        else store.create<StoredDirectory>("settings", { version, members: next }, "org-directory");
      }
      members = next;
      directoryVersion = version;
      return next.length;
    },
  };
  const findIdentity = <T extends { id: string; tokenSha256: string; expiresAt: number }>(
    header: string | undefined, identities: readonly T[], valid: (item: T) => boolean,
  ): T | null => {
    const bearer = /^Bearer ([a-zA-Z0-9_-]{32,256})$/i.exec(header ?? "")?.[1];
    if (!bearer) return null;
    const digest = Buffer.from(paDigest(bearer), "hex");
    return identities.find(item => timingSafeEqual(digest, Buffer.from(item.tokenSha256, "hex")) &&
      item.expiresAt > Date.now() && valid(item)) ?? null;
  };
  const identity: PaIdentityDriver = {
    member: header => findIdentity(header, members, item => !isRevoked("member", item.id, item.grantVersion)),
    memberById: id => members.find(item => item.id === id && item.expiresAt > Date.now() &&
      !isRevoked("member", item.id, item.grantVersion)) ?? null,
    worker: header => findIdentity(header, config.workers, item => !isRevoked("worker", item.id, item.expiresAt)),
    principal: member => ({
      kind: "enterprise", id: member.id, tenantId: enterprise!.tenantId, grantVersion: member.grantVersion, expiresAt: member.expiresAt,
    }),
    valid: task => {
      if (!enterprise) return task.principal?.kind !== "enterprise";
      const principal = task.principal;
      if (principal?.kind !== "enterprise" || principal.tenantId !== enterprise.tenantId || principal.expiresAt <= Date.now()) return false;
      const member = members.find(item => item.id === principal.id);
      return !!member && member.role !== "viewer" && member.grantVersion === principal.grantVersion &&
        member.expiresAt > Date.now() && !isRevoked("member", member.id, member.grantVersion);
    },
    revoke(kind, id) {
      const member = members.find(item => item.id === id);
      const worker = config.workers.find(item => item.id === id);
      const throughVersion = kind === "member" ? member?.grantVersion : worker?.expiresAt;
      if (throughVersion === undefined) throw new PaError("身份不存在", 404, "PA_NOT_FOUND");
      store.transaction(() => {
        const key = `${kind}:${id}`;
        if (isRevoked(kind, id, throughVersion)) return;
        if (store.get("revocations", key)) store.update<Revocation>("revocations", key, { throughVersion });
        else store.create<Revocation>("revocations", { throughVersion }, key);
        store.audit(null, "identity.revoked", { kind, id, throughVersion }, `revoked:${key}:${throughVersion}`);
      });
    },
  };
  const isolation = config.sandbox ? new PaOciSandbox(config.sandbox) : null;
  const policy: PaPolicyDriver = {
    // An admin oversees every work task. A companion chat turn belongs to the member who sent it and to nobody else.
    owns: (member, task) => task.principal?.kind === "enterprise" && task.principal.tenantId === enterprise?.tenantId &&
      (member.id === task.principal.id || member.role === "admin" && task.kind !== "chat"),
    admits(task, model, work) {
      if (!identity.valid(task)) throw unauthorized();
      if (work?.kind === "shell" && redactPaCredentials(work.script) !== work.script)
        throw new PaError("隔离脚本含有凭据，请使用网关授权的调用", 403, "PA_CAPABILITY_DENIED");
      if (task.execution?.target === "worker" && (task.dataClass === "local_only" || task.channelId))
        throw new PaError("此任务授权或密级不允许派发远端设备", 403, "PA_ROUTE_DENIED");
      if (work?.kind === "shell" && task.execution?.target !== "worker" && !isolation)
        throw new PaError("此运行实例未配置 OCI 沙盒", 503, "PA_SANDBOX_UNAVAILABLE");
      if (work?.kind === "ollama" && (model.runtime !== "ollama" || enterprise))
        throw new PaError("此模型不能在远端执行设备调用", 403, "PA_ROUTE_DENIED");
      if (!work && enterprise && (task.dataClass === "local_only" ||
        model.runtime !== "managed" || !enterprise.gateway.models.some(item => item.id === model.modelId)))
        throw new PaError("此任务仅可使用当前组织批准的网关模型", 403, "PA_ROUTE_DENIED");
    },
    reserve(task, attempt, work, remainingMs, delegated) {
      if (!enterprise || task.principal?.kind !== "enterprise") return;
      const principal = task.principal;
      const member = members.find(item => item.id === principal.id);
      if (!member || !identity.valid(task)) throw unauthorized();
      const day = new Date().toISOString().slice(0, 10);
      const reservationId = delegated ? `${attempt.runId}:${delegated.kind}` : attempt.runId;
      const estimate: PaQuota = {
        calls: work ? 0 : 1,
        cpuMs: work ? Math.min(remainingMs, 120000) * (task.execution?.target === "worker" ? config.maxHandoffs + 1 : 1) : 0,
        costMicros: work ? 0 : enterprise.gateway.models.find(item => item.id === (delegated?.model ?? attempt.agentSnapshot.model).modelId)!.reserveCostMicros,
      };
      store.transaction(() => {
        if (store.get("budget_reservations", reservationId)) return;
        const rows = store.list<Reservation>("budget_reservations").filter(row => row.day === day);
        const within = (spent: Reservation[], maximum: PaQuota) =>
          (Object.keys(estimate) as Array<keyof PaQuota>).every(key =>
            spent.reduce((total, row) => total + row.reserved[key], 0) + estimate[key] <= maximum[key]);
        if (!within(rows, enterprise.budgets.tenant) ||
          !within(rows.filter(row => row.group === member.group), enterprise.budgets.groups[member.group]!) ||
          !within(rows.filter(row => row.role === member.role), enterprise.budgets.roles[member.role]!))
          throw new PaError("组织、组或角色的当日预算已达到上限", 429, "PA_BUDGET");
        store.create<Reservation>("budget_reservations", { day, group: member.group, role: member.role, reserved: estimate }, reservationId);
        store.audit(task.id, "budget.reserved", { day, group: member.group, role: member.role, estimate }, `${reservationId}:budget`);
      });
    },
  };
  const distributed = config.workers.length > 0 ? new PaDistributedScheduler(store, config, identity.valid,
    worker => !isRevoked("worker", worker.id, worker.expiresAt)) : null;
  const credentials = enterprise ? createPaManagedCredentials(enterprise.gateway) : { runtime: input.localRuntime };
  const key = enterprise?.auditSigningKeyFile ? createPrivateKey(readPrivatePaFile(enterprise.auditSigningKeyFile, 16384)) : null;
  if (key && key.asymmetricKeyType !== "ed25519") throw new PaError("PA 审计签名须使用 Ed25519", 503, "PA_CONFIG");
  const payload = (tenantId: string, entries: number, head: string | null) => Buffer.from(JSON.stringify([tenantId, entries, head]));
  return {
    mode: config.mode, ...(enterprise ? { tenantId: enterprise.tenantId } : {}), store, identity, policy, storage,
    isolation, credentials, scheduler: { distributed },
    managedModels: enterprise?.gateway.models.map(model => ({ runtime: "managed", modelId: model.id })) ?? [],
    directory,
    org: enterprise?.orgServer ? {
      url: trustedPaUrl(enterprise.orgServer.url), refreshMs: enterprise.orgServer.refreshSeconds * 1000,
      credential: () => readPrivatePaFile(enterprise.orgServer!.credentialFile, 4096).trim(),
    } : null,
    audit() {
      const result = store.verifyAudit();
      if (!result.valid || !key || !enterprise) return result;
      const { entries, head } = result;
      const tenantId = enterprise.tenantId;
      return { ...result, checkpoint: { tenantId, entries, head, signature: sign(null, payload(tenantId, entries, head), key).toString("base64") } };
    },
    verifyCheckpoint(checkpoint) {
      if (!key || checkpoint.tenantId !== enterprise?.tenantId || !store.verifyAudit().valid) return false;
      const row = checkpoint.entries > 0 ? store.db.prepare("SELECT hash FROM pa_audit WHERE sequence=?").get(checkpoint.entries) as { hash: string } | undefined : null;
      return (checkpoint.entries === 0 ? checkpoint.head === null : row?.hash === checkpoint.head) &&
        verify(null, payload(checkpoint.tenantId, checkpoint.entries, checkpoint.head), createPublicKey(key), Buffer.from(checkpoint.signature, "base64"));
    },
  };
}
