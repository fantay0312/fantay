import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PaError } from "../../storage/personal-agent-store.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const roles = z.enum(["admin", "operator", "viewer"]);
const quota = z.object({
  calls: z.number().int().min(0).max(1000000),
  cpuMs: z.number().int().min(0).max(86400000000),
  costMicros: z.number().int().min(0).max(1000000000000),
}).strict();
export const paWorkerCaps = z.enum(["shell", "ollama"]);
const workerSchema = z.object({
  id, tokenSha256: hash, expiresAt: epoch,
  capabilities: z.array(paWorkerCaps).min(1).max(2),
  models: z.array(z.string().min(1).max(200)).max(100).default([]),
}).strict();
export const paSandboxConfig = z.object({
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  engineSocket: z.string().min(1).max(1024).optional(),
  runtime: z.enum(["runc", "runsc", "kata"]).optional(),
  memoryMb: z.number().int().min(32).max(4096).default(128),
  cpu: z.number().min(0.1).max(4).default(0.5),
}).strict();
const secretSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), path: z.string().min(1).max(1024) }).strict(),
  z.object({
    type: z.literal("vault"), url: z.string().url(), tokenFile: z.string().min(1).max(1024),
    mount: id, path: z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).max(300), field: id,
  }).strict(),
]);
/** Capabilities a member holds on top of the role. `library.manage`: agents, group chats, characters, world books and
 *  style presets (an admin always manages them). */
export const paMemberPermissions = z.enum(["library.manage"]);
/** One member as the daemon enforces it. `groups` are every organization group of the member: a library item synced
 *  for certain groups is shown only to their members. */
export const paMemberSchema = z.object({
  id, role: roles, group: id, tokenSha256: hash, grantVersion: epoch, expiresAt: epoch,
  permissions: z.array(paMemberPermissions).max(paMemberPermissions.options.length).default([]),
  groups: z.array(id).max(50).default([]),
}).strict();
const enterpriseSchema = z.object({
  tenantId: id,
  /** With `orgServer` this is only the directory used until the first sync; afterwards the server's list replaces it. */
  members: z.array(paMemberSchema).max(10000).default([]),
  /** The organization server this daemon follows: it pulls the member directory and the shared library from it, and
   *  the library is then changed only there. `credentialFile` holds a service credential with the `directory.sync`
   *  and `library.sync` scopes. */
  orgServer: z.object({
    url: z.string().url(),
    credentialFile: z.string().min(1).max(1024),
    refreshSeconds: z.number().int().min(10).max(3600).default(60),
  }).strict().optional(),
  budgets: z.object({ tenant: quota, groups: z.record(id, quota), roles: z.record(roles, quota) }).strict(),
  gateway: z.object({
    endpoint: z.string().url(), secret: secretSchema,
    models: z.array(z.object({
      id: z.string().min(1).max(200), maxTokens: z.number().int().min(1).max(64000),
      reserveCostMicros: z.number().int().min(0).max(1000000000),
    }).strict()).min(1).max(100),
  }).strict(),
  auditSigningKeyFile: z.string().min(1).max(1024).optional(),
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["personal", "enterprise"]),
  sandbox: paSandboxConfig.optional(),
  workers: z.array(workerSchema).max(40).default([]),
  leaseMs: z.number().int().min(1500).max(60000).default(10000),
  maxHandoffs: z.number().int().min(0).max(8).default(2),
  enterprise: enterpriseSchema.optional(),
}).strict().superRefine((config, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((config.mode === "enterprise") !== Boolean(config.enterprise)) reject("Enterprise mode requires enterprise configuration");
  const members = config.enterprise?.members ?? [];
  const linked = Boolean(config.enterprise?.orgServer);
  if (config.enterprise && !linked && !members.some(member => member.role === "admin")) reject("An enterprise administrator is required");
  if (config.enterprise && members.some(member => !config.enterprise?.budgets.groups[member.group])) reject("Every member group requires a quota");
  // A synced member whose group has no quota of its own is budgeted under `default`.
  if (linked && !config.enterprise?.budgets.groups.default) reject("An organization server needs a `default` group quota");
  if (config.enterprise && roles.options.some(role => !config.enterprise?.budgets.roles[role])) reject("Every enterprise role requires a quota");
  for (const values of [
    members.map(member => member.id), config.workers.map(worker => worker.id),
    [...members, ...config.workers].map(item => item.tokenSha256), config.enterprise?.gateway.models.map(model => model.id) ?? [],
  ]) if (new Set(values).size !== values.length) reject("Duplicate PA identities, model names, or credentials");
});

export type PaConfig = z.infer<typeof configSchema>;
export type PaEnterpriseConfig = NonNullable<PaConfig["enterprise"]>;
export type PaMember = PaEnterpriseConfig["members"][number];
export type PaWorkerIdentity = PaConfig["workers"][number];
/** Who may change the shared library: admins, and members granted `library.manage`. Viewers never write. */
export const paCanManageLibrary = (member: PaMember): boolean =>
  member.role === "admin" || member.role === "operator" && member.permissions.includes("library.manage");
export type PaSandboxConfig = z.infer<typeof paSandboxConfig>;
export type PaQuota = z.infer<typeof quota>;

export function readPrivatePaFile(file: string, maxBytes: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      throw new PaError("PA 配置和凭据文件须为仅所有者可读的普通文件", 503, "PA_CONFIG");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function loadPaConfig(file: string | undefined): PaConfig {
  if (!file) return configSchema.parse({ version: 1, mode: "personal" });
  const result = configSchema.safeParse(JSON.parse(readPrivatePaFile(file, 1024 * 1024)));
  if (!result.success) throw new PaError("PA 运行配置无效", 503, "PA_CONFIG");
  return result.data;
}

export function trustedPaUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || !(url.protocol === "https:" || url.protocol === "http:" && loopback))
    throw new PaError("PA 网关地址必须使用 HTTPS 或回环地址，且不能包含凭据", 503, "PA_CONFIG");
  return url;
}
