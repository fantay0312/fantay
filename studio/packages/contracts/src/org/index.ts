// SPDX-License-Identifier: Apache-2.0
// Fantay organization contract: plans, roles, permissions and the wire shapes of the organization server.
// Shared by the organization server (apps/org-server), the daemon and the web. Import as "@open-design/contracts/org".
import { z } from "zod";

// ---- plans -----------------------------------------------------------------------------------------------------
export const ORG_PLANS = ["team", "enterprise"] as const;
export type OrgPlan = (typeof ORG_PLANS)[number];
export interface OrgPlanFeatures {
  customRoles: boolean;      // additive roles beyond the four built-in ones
  groups: boolean;           // member groups
  scopedLibrary: boolean;    // a library item visible to chosen groups only
  auditLog: boolean;         // reading and verifying the audit log
  retention: boolean;        // a retention period in the policy
  sso: boolean;              // single sign-on to the console through the organization's OIDC provider
  scim: boolean;             // provisioning members and groups from the identity provider (SCIM 2.0)
  maxMembers: number;
}
export const ORG_PLAN_FEATURES: Record<OrgPlan, OrgPlanFeatures> = {
  team: { customRoles: false, groups: false, scopedLibrary: false, auditLog: false, retention: false, sso: true, scim: false, maxMembers: 150 },
  enterprise: { customRoles: true, groups: true, scopedLibrary: true, auditLog: true, retention: true, sso: true, scim: true, maxMembers: 10000 },
};

// ---- roles and permissions -------------------------------------------------------------------------------------
export const ORG_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
/** Display order, and the line `orgCanAdminister` draws: admins and owners are administered by owners only. */
export const ORG_ROLE_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export const ORG_PERMISSIONS = [
  "org.manage",       // organization name and policy, service credentials
  "roles.manage",     // assign admin and owner, define and assign custom roles
  "members.manage",   // add, suspend and remove lower-ranked members, rotate their access tokens
  "groups.manage",    // member groups
  "library.manage",   // create, edit, publish and retire characters, world books and style presets
  "library.read",     // read the published library
  "chat.use",         // chat with library characters; conversations, personas and memories stay with the member
  "audit.read",       // read and verify the audit log
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly OrgPermission[]> = {
  owner: ORG_PERMISSIONS,
  admin: ["members.manage", "groups.manage", "library.manage", "library.read", "chat.use"],
  member: ["library.read", "chat.use"],
  viewer: ["library.read"],
};
/** What a custom role may grant. Organization and role administration stay with the built-in owner role. */
export const ORG_GRANTABLE_PERMISSIONS = [
  "members.manage", "groups.manage", "library.manage", "library.read", "chat.use", "audit.read",
] as const satisfies readonly OrgPermission[];
/** A permission that exists only where the plan has the feature behind it. */
const PLAN_GATED: Partial<Record<OrgPermission, keyof OrgPlanFeatures>> = {
  "groups.manage": "groups",
  "audit.read": "auditLog",
};

/** Effective permissions: the built-in role plus every custom role (additive, as nothing ever subtracts), minus what
 *  the plan does not include. Custom roles count only on a plan that has them. */
export function orgPermissions(input: {
  plan: OrgPlan; role: OrgRole; customRoles?: ReadonlyArray<{ permissions: readonly OrgPermission[] }>;
}): OrgPermission[] {
  const features = ORG_PLAN_FEATURES[input.plan];
  const granted = new Set<OrgPermission>(ORG_ROLE_PERMISSIONS[input.role]);
  if (features.customRoles)
    for (const role of input.customRoles ?? [])
      for (const permission of role.permissions)
        if ((ORG_GRANTABLE_PERMISSIONS as readonly OrgPermission[]).includes(permission)) granted.add(permission);
  return ORG_PERMISSIONS.filter(permission => {
    const feature = PLAN_GATED[permission];
    return granted.has(permission) && (!feature || features[feature] === true);
  });
}
/** Whether `actor`, who already holds the permission for the action, may apply it to `target` (suspend, remove,
 *  rotate a token, change a role). Nobody administers themselves or the primary owner; admins and owners answer to
 *  owners only; members and viewers answer to anyone holding the permission. */
export function orgCanAdminister(
  actor: { id: string; role: OrgRole }, target: { id: string; role: OrgRole; primary: boolean },
): boolean {
  if (target.primary || actor.id === target.id) return false;
  return actor.role === "owner" || ORG_ROLE_RANK[target.role] < ORG_ROLE_RANK.admin;
}

// ---- the daemon's view of a member ------------------------------------------------------------------------------
/** The role the Fantay daemon enforces locally (`OD_PA_CONFIG` → `enterprise.members[].role`). */
export type OrgPaRole = "admin" | "operator" | "viewer";
export const ORG_PA_PERMISSIONS = ["library.manage"] as const;
export type OrgPaPermission = (typeof ORG_PA_PERMISSIONS)[number];
export function orgPaRole(role: OrgRole, permissions: readonly OrgPermission[]): OrgPaRole {
  if (role === "owner" || role === "admin") return "admin";
  return permissions.includes("chat.use") ? "operator" : "viewer";
}
export function orgPaPermissions(permissions: readonly OrgPermission[]): OrgPaPermission[] {
  return permissions.includes("library.manage") ? ["library.manage"] : [];
}

// ---- records ---------------------------------------------------------------------------------------------------
export interface OrgEntity { id: string; revision: number; createdAt: number; updatedAt: number }
/** Configuration every client of the organization applies. Conversations and memories are never sent to the server. */
export interface OrgPolicy {
  companion: {
    enabled: boolean;                 // companion chats are available to members
    memory: boolean;                  // characters keep a private memory per member
    personas: boolean;                // members may write their own personas
  };
  models: string[];                   // gateway model ids members may pick; empty means every approved model
  retentionDays: number | null;       // how long a client keeps conversations; null keeps them (enterprise plan)
}
export const ORG_DEFAULT_POLICY: OrgPolicy = {
  companion: { enabled: true, memory: true, personas: true }, models: [], retentionDays: null,
};
export interface OrgInfo extends OrgEntity { name: string; plan: OrgPlan; policy: OrgPolicy }
export type OrgMemberStatus = "active" | "suspended";
export interface OrgMember extends OrgEntity {
  name: string;
  email: string;
  role: OrgRole;
  primary: boolean;                   // the one owner nobody else can administer
  status: OrgMemberStatus;
  groupIds: string[];
  customRoleIds: string[];
  /** Moves whenever the member's access changes (role, custom roles, groups, status, token). A daemon treats a task
   *  delegated under an older version as revoked. */
  grantVersion: number;
  hasToken: boolean;
  tokenExpiresAt: number | null;
  /** The identity provider's subject once the member has signed in through SSO. */
  ssoSubject: string | null;
  /** The identity provider's own id of this member, set by SCIM provisioning. */
  externalId: string | null;
}
export interface OrgGroup extends OrgEntity { name: string; customRoleIds: string[] }
export interface OrgCustomRole extends OrgEntity { name: string; description: string; permissions: OrgPermission[] }
export const ORG_LIBRARY_KINDS = ["character", "lorebook", "preset"] as const;
export type OrgLibraryKind = (typeof ORG_LIBRARY_KINDS)[number];
export type OrgLibraryStatus = "draft" | "published" | "retired";
export type OrgLibraryAudience = { kind: "everyone" } | { kind: "groups"; groupIds: string[] };
export interface OrgLibraryAsset { id: string; role: string; mime: string; bytes: number; sha256: string }
export interface OrgLibrarySummary extends OrgEntity {
  kind: OrgLibraryKind;
  name: string;
  status: OrgLibraryStatus;
  /** The library clock at the last change to the published item (0 while it was never published). The clock only
   *  moves forward across the whole library, so a client re-imports exactly the items newer than its last sync. */
  version: number;
  audience: OrgLibraryAudience;
  assets: OrgLibraryAsset[];
  updatedBy: string;
}
/** `document` is the portable file of its kind: a character card (V2/V3 JSON), a world book or a style preset. */
export interface OrgLibraryItem extends OrgLibrarySummary { document: Record<string, unknown> }
export interface OrgServiceToken extends OrgEntity {
  label: string; scopes: OrgServiceScope[]; expiresAt: number; lastUsedAt: number | null; createdBy: string;
}
/** `directory.sync`: the member list a controller daemon enforces. `library.sync`: every published library item
 *  with its audience, for a controller daemon that applies the audience itself. */
export const ORG_SERVICE_SCOPES = ["directory.sync", "library.sync"] as const;
export type OrgServiceScope = (typeof ORG_SERVICE_SCOPES)[number];
export interface OrgAuditEvent {
  sequence: number; at: number; actorId: string; action: string; targetId: string | null;
  detail: Record<string, unknown>; hash: string;
}

// ---- responses -------------------------------------------------------------------------------------------------
export interface OrgSession {
  org: { id: string; name: string; plan: OrgPlan };
  member: Pick<OrgMember, "id" | "name" | "email" | "role" | "primary" | "groupIds">;
  permissions: OrgPermission[];
  features: OrgPlanFeatures;
  policy: OrgPolicy;
  paRole: OrgPaRole;
  /** `token`: a member access token (also what a desktop uses). `session`: a console session opened through SSO. */
  auth: "token" | "session";
}
/** What the sign-in page may know before anyone has signed in. */
export interface OrgPublicInfo { initialized: boolean; name: string | null; sso: boolean }
/** Single sign-on through the organization's OpenID Connect provider. The client secret is write-only. */
export interface OrgSsoConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  /** Email domains that may sign in; empty accepts every address the provider vouches for. */
  allowedDomains: string[];
  /** Creates the member on a first sign-in (while seats remain); otherwise only members added beforehand sign in. */
  autoProvision: boolean;
  defaultRole: "member" | "viewer";
  /** The callback to register at the provider; null while the server does not know its public address. */
  redirectUri: string | null;
}
/** SCIM 2.0 provisioning. The bearer token is shown once, when it is generated. */
export interface OrgScimStatus { enabled: boolean; baseUrl: string | null; tokenCreatedAt: number | null; lastUsedAt: number | null }
/** Returned once, when a token is issued. The server keeps only its SHA-256. */
export interface OrgIssuedToken { token: string; expiresAt: number }
export interface OrgDirectoryEntry {
  id: string; role: OrgPaRole; group: string; tokenSha256: string; grantVersion: number; expiresAt: number;
  permissions: OrgPaPermission[];
  /** Every group of the member: a daemon shows a library item scoped to groups only to their members. */
  groups: string[];
}
/** What a controller daemon pulls with a `directory.sync` service credential: `members` has the shape of
 *  `enterprise.members` in the daemon's PA configuration. */
export interface OrgDirectorySync {
  tenantId: string; generatedAt: number; version: number; members: OrgDirectoryEntry[];
  /** The organization's policy, applied by the daemon together with the directory. */
  policy: OrgPolicy;
}
/** What a member's client pulls: every published item the member may read whose `version` is newer than `since`, and
 *  the ids of the items the member can no longer read. */
export interface OrgLibrarySync { version: number; items: OrgLibraryItem[]; current: string[] }

// ---- inputs ----------------------------------------------------------------------------------------------------
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const name = z.string().trim().min(1).max(80);
const revision = z.number().int().min(1);
const ttlDays = z.number().int().min(1).max(366);
export const orgRoleSchema = z.enum(ORG_ROLES);
export const orgPlanSchema = z.enum(ORG_PLANS);
export const orgPolicySchema = z.object({
  companion: z.object({ enabled: z.boolean(), memory: z.boolean(), personas: z.boolean() }).strict(),
  models: z.array(z.string().min(1).max(200)).max(100),
  retentionDays: z.number().int().min(30).max(3650).nullable(),
}).strict();
export const orgInitInputSchema = z.object({
  id, name, plan: orgPlanSchema.default("team"),
  owner: z.object({ name, email: z.string().trim().email().max(200) }).strict(),
}).strict();
export const orgPatchSchema = z.object({ name: name.optional(), policy: orgPolicySchema.optional(), revision }).strict();
export const orgPlanChangeSchema = z.object({ plan: orgPlanSchema, revision }).strict();
export const orgTransferSchema = z.object({ memberId: id }).strict();
export const orgMemberInputSchema = z.object({
  name, email: z.string().trim().email().max(200), role: orgRoleSchema.default("member"),
  groupIds: z.array(id).max(50).default([]), tokenTtlDays: ttlDays.default(90),
}).strict();
export const orgMemberPatchSchema = z.object({
  name: name.optional(), email: z.string().trim().email().max(200).optional(),
  status: z.enum(["active", "suspended"]).optional(), groupIds: z.array(id).max(50).optional(), revision,
}).strict();
export const orgMemberRoleSchema = z.object({
  role: orgRoleSchema.optional(), customRoleIds: z.array(id).max(20).optional(), revision,
}).strict();
export const orgTokenInputSchema = z.object({ ttlDays: ttlDays.default(90) }).strict();
export const orgGroupInputSchema = z.object({ name, customRoleIds: z.array(id).max(20).default([]) }).strict();
export const orgGroupPatchSchema = z.object({ name: name.optional(), customRoleIds: z.array(id).max(20).optional(), revision }).strict();
const grantable = z.array(z.enum(ORG_GRANTABLE_PERMISSIONS)).max(ORG_GRANTABLE_PERMISSIONS.length);
export const orgCustomRoleInputSchema = z.object({ name, description: z.string().max(400).default(""), permissions: grantable }).strict();
export const orgCustomRolePatchSchema = z.object({
  name: name.optional(), description: z.string().max(400).optional(), permissions: grantable.optional(), revision,
}).strict();
export const orgLibraryAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("groups"), groupIds: z.array(id).min(1).max(50) }).strict(),
]);
const document = z.record(z.unknown());
export const orgLibraryInputSchema = z.object({
  kind: z.enum(ORG_LIBRARY_KINDS), name: z.string().trim().min(1).max(120), document,
  audience: orgLibraryAudienceSchema.default({ kind: "everyone" }),
}).strict();
export const orgLibraryPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), document: document.optional(),
  audience: orgLibraryAudienceSchema.optional(), revision,
}).strict();
export const orgLibraryStatusSchema = z.object({ revision }).strict();
export const orgLibraryAssetSchema = z.object({
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z.string().min(1),
  revision,
}).strict();
const domain = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const orgSsoInputSchema = z.object({
  enabled: z.boolean(),
  issuer: z.string().trim().url().max(300),
  clientId: z.string().trim().min(1).max(200),
  /** Omit to keep the stored secret. */
  clientSecret: z.string().min(1).max(500).optional(),
  allowedDomains: z.array(domain).max(50).default([]),
  autoProvision: z.boolean().default(false),
  defaultRole: z.enum(["member", "viewer"]).default("member"),
}).strict();
export type OrgSsoInput = z.infer<typeof orgSsoInputSchema>;
export const orgServiceTokenInputSchema = z.object({
  label: z.string().trim().min(1).max(80), scopes: z.array(z.enum(ORG_SERVICE_SCOPES)).min(1).max(ORG_SERVICE_SCOPES.length),
  ttlDays: ttlDays.default(90),
}).strict();

export type OrgInitInput = z.infer<typeof orgInitInputSchema>;
export type OrgMemberInput = z.infer<typeof orgMemberInputSchema>;
export type OrgLibraryInput = z.infer<typeof orgLibraryInputSchema>;

/** Size limits the server enforces and a client can check first. */
export const ORG_LIMITS = {
  documentBytes: 2 * 1024 * 1024,     // one library document, as JSON
  assetBytes: 8 * 1024 * 1024,        // one image
  assetsPerItem: 12,
  libraryItems: 2000,
  groups: 500,
  customRoles: 50,
  serviceTokens: 20,
} as const;
