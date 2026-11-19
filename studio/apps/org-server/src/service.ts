// SPDX-License-Identifier: AGPL-3.0-only
// The rules of a Fantay organization: who may do what, to whom, on which plan.
//
// Two planes are kept apart. The management plane (organization, members, roles, groups, the shared library, policy,
// audit) lives here and is permission-checked on every call. The data plane (what members say to characters and what
// is remembered about them) never reaches this server: there is no call that stores or returns a conversation, a
// message or a memory, so no role, including the owner, can read one here.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ORG_DEFAULT_POLICY,
  ORG_LIMITS,
  ORG_PLAN_FEATURES,
  orgCanAdminister,
  orgCustomRoleInputSchema,
  orgCustomRolePatchSchema,
  orgGroupInputSchema,
  orgGroupPatchSchema,
  orgInitInputSchema,
  orgLibraryAssetSchema,
  orgLibraryInputSchema,
  orgLibraryPatchSchema,
  orgLibraryStatusSchema,
  orgMemberInputSchema,
  orgMemberPatchSchema,
  orgMemberRoleSchema,
  orgPaPermissions,
  orgPaRole,
  orgPatchSchema,
  orgPermissions,
  orgPlanChangeSchema,
  orgServiceTokenInputSchema,
  orgSsoInputSchema,
  orgTokenInputSchema,
  orgTransferSchema,
  type OrgAuditEvent,
  type OrgCustomRole,
  type OrgDirectorySync,
  type OrgGroup,
  type OrgInfo,
  type OrgIssuedToken,
  type OrgLibraryAsset,
  type OrgLibraryAudience,
  type OrgLibraryItem,
  type OrgLibrarySummary,
  type OrgLibrarySync,
  type OrgMember,
  type OrgPermission,
  type OrgPlanFeatures,
  type OrgPublicInfo,
  type OrgScimStatus,
  type OrgServiceToken,
  type OrgSession,
  type OrgSsoConfig,
} from '@open-design/contracts/org';
import { OrgError, OrgStore, type TokenKind } from './store.js';

type StoredMember = Omit<OrgMember, 'hasToken' | 'tokenExpiresAt'>;
/** `directory` moves with every change a daemon's member list depends on; `library` with every change a reader sees. */
interface Clock { id: string; revision: number; createdAt: number; updatedAt: number; directory: number; library: number }
/** Stored SSO settings; the client secret stays here and is never part of a response. */
export interface SsoSettings {
  enabled: boolean; issuer: string; clientId: string; clientSecret: string;
  allowedDomains: string[]; autoProvision: boolean; defaultRole: 'member' | 'viewer';
}
type StoredSso = SsoSettings & { id: string; revision: number; createdAt: number; updatedAt: number };
interface StoredSession { id: string; revision: number; createdAt: number; updatedAt: number; memberId: string; expiresAt: number }
/** What the identity provider said about the person signing in. */
export interface SsoProfile { subject: string; email: string; name: string }
export interface OrgServiceOptions {
  /** The address members reach the server at (https://…): needed for the SSO callback and the SCIM base URL. */
  publicUrl?: string;
}
export interface MemberActor { kind: 'member'; member: StoredMember; permissions: ReadonlySet<OrgPermission>; auth: 'token' | 'session' }
export interface ServiceActor { kind: 'service'; token: OrgServiceToken }
export type Actor = MemberActor | ServiceActor;

const DAY = 86_400_000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const TOKEN = /^f(?:to|ts|ss|sc)_[A-Za-z0-9_-]{43}$/;
const PREFIX: Record<TokenKind, string> = { member: 'fto_', service: 'fts_', session: 'fss_', scim: 'fsc_' };
const SCIM_OWNER = 'scim';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const forbidden = (message = '当前角色没有这项权限') => new OrgError(403, 'ORG_FORBIDDEN', message);
const invalid = (message: string) => new OrgError(400, 'ORG_INVALID_REQUEST', message);
const limit = (message: string) => new OrgError(409, 'ORG_LIMIT', message);
const unique = <T>(values: readonly T[]) => [...new Set(values)];
function imageKind(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((char, index) => at(from + index) === char.charCodeAt(0));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte)) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

export class OrgService {
  readonly store: OrgStore;
  private readonly publicUrl: string | null;
  constructor(directory: string, private readonly now: () => number = Date.now, options: OrgServiceOptions = {}) {
    this.store = new OrgStore(directory);
    this.publicUrl = options.publicUrl ? new URL(options.publicUrl).origin : null;
  }
  close(): void { this.store.close(); }

  // ---- shared helpers --------------------------------------------------------------------------------------------
  initialized(): boolean { return this.store.count('org') > 0; }
  private org(): OrgInfo {
    const org = this.store.list<OrgInfo>('org')[0];
    if (!org) throw new OrgError(503, 'ORG_NOT_INITIALIZED', '组织尚未初始化');
    return org;
  }
  private features(): OrgPlanFeatures { return ORG_PLAN_FEATURES[this.org().plan]; }
  private requireFeature(name: Exclude<keyof OrgPlanFeatures, 'maxMembers'>): void {
    if (!this.features()[name]) throw new OrgError(403, 'ORG_PLAN_REQUIRED', '当前套餐不包含这项功能，企业版可用');
  }
  private memberActor(actor: Actor): MemberActor {
    if (actor.kind !== 'member') throw forbidden('服务凭据只能用于同步');
    return actor;
  }
  private need(actor: Actor, permission: OrgPermission): MemberActor {
    const member = this.memberActor(actor);
    if (!member.permissions.has(permission)) throw forbidden();
    return member;
  }
  private log(actorId: string, action: string, targetId: string | null, detail: Record<string, unknown> = {}): void {
    this.store.appendAudit({ at: this.now(), actorId, action, targetId, detail });
  }
  private tick(kind: 'directory' | 'library'): number {
    const clock = this.store.get<Clock>('meta', 'clock');
    if (!clock) {
      const created = this.store.create<Clock>('meta', { directory: 0, library: 0, [kind]: 1 }, this.now(), 'clock');
      return created[kind];
    }
    return this.store.update<Clock>('meta', 'clock', { [kind]: clock[kind] + 1 }, this.now())[kind];
  }
  private clock(kind: 'directory' | 'library'): number {
    return this.store.get<Clock>('meta', 'clock')?.[kind] ?? 0;
  }
  /** Custom roles a member holds directly and through groups; empty on a plan without them. */
  private customRolesOf(member: Pick<StoredMember, 'customRoleIds' | 'groupIds'>): OrgCustomRole[] {
    const features = this.features();
    if (!features.customRoles) return [];
    const viaGroups = features.groups
      ? member.groupIds.flatMap(id => this.store.get<OrgGroup>('groups', id)?.customRoleIds ?? [])
      : [];
    return unique([...member.customRoleIds, ...viaGroups])
      .map(id => this.store.get<OrgCustomRole>('roles', id))
      .filter((role): role is OrgCustomRole => role !== null);
  }
  private permissionsOf(member: StoredMember): OrgPermission[] {
    return orgPermissions({ plan: this.org().plan, role: member.role, customRoles: this.customRolesOf(member) });
  }
  private view(member: StoredMember): OrgMember {
    const token = this.store.tokenOf('member', member.id);
    const live = token !== null && token.expiresAt > this.now();
    return { ...member, hasToken: live, tokenExpiresAt: live ? token.expiresAt : null };
  }
  /** Moves a member's grant forward: everything delegated under the previous version stops being valid. */
  private regrant(member: StoredMember, patch: Partial<StoredMember> = {}, expected?: number): StoredMember {
    const next = this.store.update<StoredMember>('members', member.id, {
      ...patch, grantVersion: Math.max(member.grantVersion + 1, this.now()),
    }, this.now(), expected);
    this.tick('directory');
    return next;
  }
  private issue(kind: TokenKind, ownerId: string, ttlDays: number, ttlMs = ttlDays * DAY): OrgIssuedToken {
    const token = `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
    const expiresAt = this.now() + ttlMs;
    this.store.putToken(kind, ownerId, digest(token), expiresAt, this.now());
    return { token, expiresAt };
  }
  private assertGroups(ids: readonly string[]): void {
    for (const id of ids) if (!this.store.get('groups', id)) throw invalid('用户组不存在');
  }
  private assertRoles(ids: readonly string[]): void {
    for (const id of ids) if (!this.store.get('roles', id)) throw invalid('自定义角色不存在');
  }
  private assertEmailFree(email: string, exceptId?: string): void {
    const taken = this.store.list<StoredMember>('members')
      .some(member => member.id !== exceptId && member.email.toLowerCase() === email.toLowerCase());
    if (taken) throw new OrgError(409, 'ORG_CONFLICT', '这个邮箱已经在组织里');
  }
  /** `actor` holds the permission; this is the second half of the check, about the person acted on. */
  private assertAdministers(actor: MemberActor, target: StoredMember): void {
    if (!orgCanAdminister(actor.member, target))
      throw forbidden(target.primary ? '主要所有者只能通过移交变更' : actor.member.id === target.id ? '不能对自己执行这项操作' : '管理员和所有者只能由所有者管理');
  }

  // ---- bootstrap and sessions ------------------------------------------------------------------------------------
  /** Creates the organization and its primary owner. Runs once, from the server's own command line. */
  init(raw: unknown): { org: OrgInfo; owner: OrgMember; token: OrgIssuedToken } {
    const input = orgInitInputSchema.parse(raw);
    return this.store.transaction(() => {
      if (this.initialized()) throw new OrgError(409, 'ORG_CONFLICT', '组织已经初始化');
      const at = this.now();
      const org = this.store.create<OrgInfo>('org', { name: input.name, plan: input.plan, policy: ORG_DEFAULT_POLICY }, at, input.id);
      const owner = this.store.create<StoredMember>('members', {
        name: input.owner.name, email: input.owner.email, role: 'owner', primary: true, status: 'active',
        groupIds: [], customRoleIds: [], grantVersion: at, ssoSubject: null, externalId: null,
      }, at);
      const token = this.issue('member', owner.id, 90);
      this.tick('directory');
      this.log(owner.id, 'org.created', org.id, { plan: org.plan });
      return { org, owner: this.view(owner), token };
    });
  }
  /** Resolves a bearer token. Suspended members, expired tokens and unknown tokens all get the same answer: nobody. */
  authenticate(bearer: string | undefined): Actor | null {
    if (!bearer || !TOKEN.test(bearer)) return null;
    const row = this.store.tokenByDigest(digest(bearer));
    const at = this.now();
    if (!row || row.expiresAt <= at) return null;
    if (row.lastUsedAt === null || at - row.lastUsedAt > 60_000) this.store.touchToken(row.sha256, at);
    if (row.kind === 'scim') return null;                     // the provisioning token opens /scim/v2 only
    if (row.kind === 'service') {
      const token = this.store.get<OrgServiceToken>('service_tokens', row.ownerId);
      return token ? { kind: 'service', token: { ...token, lastUsedAt: at } } : null;
    }
    const memberId = row.kind === 'session' ? this.store.get<StoredSession>('sessions', row.ownerId)?.memberId : row.ownerId;
    const member = memberId ? this.store.get<StoredMember>('members', memberId) : null;
    if (!member || member.status !== 'active') return null;
    return { kind: 'member', member, permissions: new Set(this.permissionsOf(member)), auth: row.kind === 'session' ? 'session' : 'token' };
  }
  session(actor: Actor): OrgSession {
    const { member, permissions, auth } = this.memberActor(actor);
    const org = this.org();
    const list = [...permissions];
    return {
      org: { id: org.id, name: org.name, plan: org.plan },
      member: { id: member.id, name: member.name, email: member.email, role: member.role, primary: member.primary, groupIds: member.groupIds },
      permissions: list, features: ORG_PLAN_FEATURES[org.plan], policy: org.policy, paRole: orgPaRole(member.role, list), auth,
    };
  }
  /** Ends a console session. A member access token is not a session: it ends by rotation or revocation. */
  logout(bearer: string | undefined): { ok: true } {
    const row = bearer ? this.store.tokenByDigest(digest(bearer)) : null;
    if (row?.kind === 'session') {
      this.store.deleteToken('session', row.ownerId);
      this.store.remove('sessions', row.ownerId);
    }
    return { ok: true };
  }

  // ---- organization ----------------------------------------------------------------------------------------------
  info(actor: Actor): OrgInfo {
    this.memberActor(actor);
    return this.org();
  }
  patchOrg(actor: Actor, raw: unknown): OrgInfo {
    const by = this.need(actor, 'org.manage');
    const input = orgPatchSchema.parse(raw);
    if (input.policy && input.policy.retentionDays !== null) this.requireFeature('retention');
    return this.store.transaction(() => {
      const org = this.org();
      const next = this.store.update<OrgInfo>('org', org.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
      }, this.now(), input.revision);
      this.log(by.member.id, 'org.updated', org.id, { name: input.name !== undefined, policy: input.policy !== undefined });
      return next;
    });
  }
  /** Only the primary owner changes the plan. Moving down keeps groups and custom roles on file but stops applying them. */
  changePlan(actor: Actor, raw: unknown): OrgInfo {
    const by = this.need(actor, 'org.manage');
    if (!by.member.primary) throw forbidden('只有主要所有者可以变更套餐');
    const input = orgPlanChangeSchema.parse(raw);
    return this.store.transaction(() => {
      const org = this.org();
      if (this.store.count('members') > ORG_PLAN_FEATURES[input.plan].maxMembers) throw limit('成员数超过这个套餐的上限');
      const policy = ORG_PLAN_FEATURES[input.plan].retention ? org.policy : { ...org.policy, retentionDays: null };
      const next = this.store.update<OrgInfo>('org', org.id, { plan: input.plan, policy }, this.now(), input.revision);
      // Effective permissions depend on the plan: every grant is renewed so daemons re-read them.
      for (const member of this.store.list<StoredMember>('members')) this.regrant(member);
      this.log(by.member.id, 'org.plan.changed', org.id, { from: org.plan, to: input.plan });
      return next;
    });
  }
  transfer(actor: Actor, raw: unknown): OrgMember {
    const by = this.memberActor(actor);
    if (!by.member.primary) throw forbidden('只有主要所有者可以移交组织');
    const input = orgTransferSchema.parse(raw);
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', input.memberId);
      if (target.id === by.member.id || target.status !== 'active') throw invalid('请选择另一位在职成员');
      this.regrant(this.store.require<StoredMember>('members', by.member.id), { primary: false });
      const next = this.regrant(target, { role: 'owner', primary: true });
      this.log(by.member.id, 'org.transferred', target.id);
      return this.view(next);
    });
  }

  // ---- members ---------------------------------------------------------------------------------------------------
  members(actor: Actor): OrgMember[] {
    const by = this.memberActor(actor);
    if (!by.permissions.has('members.manage') && !by.permissions.has('roles.manage')) throw forbidden();
    return this.store.list<StoredMember>('members').map(member => this.view(member));
  }
  addMember(actor: Actor, raw: unknown): { member: OrgMember; token: OrgIssuedToken } {
    const by = this.need(actor, 'members.manage');
    const input = orgMemberInputSchema.parse(raw);
    if ((input.role === 'owner' || input.role === 'admin') && !by.permissions.has('roles.manage'))
      throw forbidden('只有所有者可以添加管理员或所有者');
    if (input.groupIds.length) {
      this.requireFeature('groups');
      this.need(actor, 'groups.manage');
    }
    return this.store.transaction(() => {
      if (this.store.count('members') >= this.features().maxMembers) throw limit('成员数已达到套餐上限');
      this.assertEmailFree(input.email);
      this.assertGroups(input.groupIds);
      const at = this.now();
      const member = this.store.create<StoredMember>('members', {
        name: input.name, email: input.email, role: input.role, primary: false, status: 'active',
        groupIds: unique(input.groupIds), customRoleIds: [], grantVersion: at, ssoSubject: null, externalId: null,
      }, at);
      const token = this.issue('member', member.id, input.tokenTtlDays);
      this.tick('directory');
      this.log(by.member.id, 'member.added', member.id, { role: member.role });
      return { member: this.view(member), token };
    });
  }
  patchMember(actor: Actor, id: string, raw: unknown): OrgMember {
    const by = this.need(actor, 'members.manage');
    const input = orgMemberPatchSchema.parse(raw);
    if (input.groupIds !== undefined) {
      this.requireFeature('groups');
      this.need(actor, 'groups.manage');
    }
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      this.assertAdministers(by, target);
      if (input.email !== undefined) this.assertEmailFree(input.email, id);
      if (input.groupIds !== undefined) this.assertGroups(input.groupIds);
      const patch: Partial<StoredMember> = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.groupIds !== undefined ? { groupIds: unique(input.groupIds) } : {}),
      };
      const access = input.status !== undefined && input.status !== target.status || input.groupIds !== undefined;
      const next = access ? this.regrant(target, patch, input.revision)
        : this.store.update<StoredMember>('members', id, patch, this.now(), input.revision);
      this.log(by.member.id, 'member.updated', id, { fields: Object.keys(patch) });
      return this.view(next);
    });
  }
  /** Built-in role and custom roles of a member. Owner only (`roles.manage`), and never on oneself. */
  setRole(actor: Actor, id: string, raw: unknown): OrgMember {
    const by = this.need(actor, 'roles.manage');
    const input = orgMemberRoleSchema.parse(raw);
    if (input.customRoleIds !== undefined) this.requireFeature('customRoles');
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      this.assertAdministers(by, target);
      if (input.customRoleIds !== undefined) this.assertRoles(input.customRoleIds);
      const next = this.regrant(target, {
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.customRoleIds !== undefined ? { customRoleIds: unique(input.customRoleIds) } : {}),
      }, input.revision);
      this.log(by.member.id, 'member.role.changed', id, { from: target.role, to: next.role, customRoleIds: next.customRoleIds });
      return this.view(next);
    });
  }
  removeMember(actor: Actor, id: string): { ok: true } {
    const by = this.need(actor, 'members.manage');
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      this.assertAdministers(by, target);
      this.store.deleteToken('member', id);
      this.store.remove('members', id);
      this.tick('directory');
      this.log(by.member.id, 'member.removed', id, { role: target.role });
      return { ok: true as const };
    });
  }
  /** Issues a new access token and ends the old one. Anyone may rotate their own; otherwise `members.manage`. */
  rotateToken(actor: Actor, id: string, raw: unknown): OrgIssuedToken {
    const by = this.memberActor(actor);
    const input = orgTokenInputSchema.parse(raw ?? {});
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      if (target.id !== by.member.id) {
        this.need(actor, 'members.manage');
        this.assertAdministers(by, target);
      }
      if (target.status !== 'active') throw invalid('已停用的成员不能签发令牌');
      const token = this.issue('member', id, input.ttlDays);
      this.regrant(target);
      this.log(by.member.id, 'member.token.rotated', id);
      return token;
    });
  }
  revokeToken(actor: Actor, id: string): { ok: true } {
    const by = this.memberActor(actor);
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      if (target.id !== by.member.id) {
        this.need(actor, 'members.manage');
        this.assertAdministers(by, target);
      }
      this.store.deleteToken('member', id);
      this.regrant(target);
      this.log(by.member.id, 'member.token.revoked', id);
      return { ok: true as const };
    });
  }

  // ---- groups (enterprise plan) ----------------------------------------------------------------------------------
  groups(actor: Actor): OrgGroup[] {
    const by = this.memberActor(actor);
    this.requireFeature('groups');
    if (!by.permissions.has('groups.manage') && !by.permissions.has('members.manage') && !by.permissions.has('library.manage')) throw forbidden();
    return this.store.list<OrgGroup>('groups');
  }
  /** Putting a custom role on a group grants it to every member of the group, so that part needs `roles.manage`. */
  private groupRoles(actor: Actor, ids: readonly string[]): string[] {
    if (!ids.length) return [];
    this.need(actor, 'roles.manage');
    this.requireFeature('customRoles');
    this.assertRoles(ids);
    return unique(ids);
  }
  createGroup(actor: Actor, raw: unknown): OrgGroup {
    this.requireFeature('groups');
    const by = this.need(actor, 'groups.manage');
    const input = orgGroupInputSchema.parse(raw);
    return this.store.transaction(() => {
      if (this.store.count('groups') >= ORG_LIMITS.groups) throw limit('用户组数量已达上限');
      const group = this.store.create<OrgGroup>('groups', { name: input.name, customRoleIds: this.groupRoles(actor, input.customRoleIds) }, this.now());
      this.log(by.member.id, 'group.created', group.id, { name: group.name });
      return group;
    });
  }
  patchGroup(actor: Actor, id: string, raw: unknown): OrgGroup {
    this.requireFeature('groups');
    const by = this.need(actor, 'groups.manage');
    const input = orgGroupPatchSchema.parse(raw);
    return this.store.transaction(() => {
      this.store.require<OrgGroup>('groups', id);
      const next = this.store.update<OrgGroup>('groups', id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.customRoleIds !== undefined ? { customRoleIds: this.groupRoles(actor, input.customRoleIds) } : {}),
      }, this.now(), input.revision);
      if (input.customRoleIds !== undefined)
        for (const member of this.store.list<StoredMember>('members')) if (member.groupIds.includes(id)) this.regrant(member);
      this.log(by.member.id, 'group.updated', id, { name: next.name, customRoleIds: next.customRoleIds });
      return next;
    });
  }
  deleteGroup(actor: Actor, id: string): { ok: true } {
    this.requireFeature('groups');
    const by = this.need(actor, 'groups.manage');
    return this.store.transaction(() => {
      const group = this.store.require<OrgGroup>('groups', id);
      if (group.customRoleIds.length) this.need(actor, 'roles.manage');
      for (const member of this.store.list<StoredMember>('members'))
        if (member.groupIds.includes(id)) this.regrant(member, { groupIds: member.groupIds.filter(item => item !== id) });
      // An item shown only to this group goes back to a draft instead of silently opening to everyone.
      for (const item of this.store.list<OrgLibraryItem>('library')) {
        if (item.audience.kind !== 'groups' || !item.audience.groupIds.includes(id)) continue;
        const groupIds = item.audience.groupIds.filter(entry => entry !== id);
        this.store.update<OrgLibraryItem>('library', item.id, groupIds.length
          ? { audience: { kind: 'groups', groupIds } }
          : { audience: { kind: 'everyone' }, status: item.status === 'published' ? 'draft' : item.status }, this.now());
        this.tick('library');
      }
      this.store.remove('groups', id);
      this.log(by.member.id, 'group.deleted', id, { name: group.name });
      return { ok: true as const };
    });
  }

  // ---- custom roles (enterprise plan) ----------------------------------------------------------------------------
  roles(actor: Actor): OrgCustomRole[] {
    const by = this.memberActor(actor);
    this.requireFeature('customRoles');
    if (!by.permissions.has('roles.manage') && !by.permissions.has('members.manage')) throw forbidden();
    return this.store.list<OrgCustomRole>('roles');
  }
  private holders(roleId: string): StoredMember[] {
    const groups = new Set(this.store.list<OrgGroup>('groups').filter(group => group.customRoleIds.includes(roleId)).map(group => group.id));
    return this.store.list<StoredMember>('members')
      .filter(member => member.customRoleIds.includes(roleId) || member.groupIds.some(id => groups.has(id)));
  }
  createRole(actor: Actor, raw: unknown): OrgCustomRole {
    this.requireFeature('customRoles');
    const by = this.need(actor, 'roles.manage');
    const input = orgCustomRoleInputSchema.parse(raw);
    return this.store.transaction(() => {
      if (this.store.count('roles') >= ORG_LIMITS.customRoles) throw limit('自定义角色数量已达上限');
      const role = this.store.create<OrgCustomRole>('roles', {
        name: input.name, description: input.description, permissions: unique(input.permissions),
      }, this.now());
      this.log(by.member.id, 'role.created', role.id, { name: role.name, permissions: role.permissions });
      return role;
    });
  }
  patchRole(actor: Actor, id: string, raw: unknown): OrgCustomRole {
    this.requireFeature('customRoles');
    const by = this.need(actor, 'roles.manage');
    const input = orgCustomRolePatchSchema.parse(raw);
    return this.store.transaction(() => {
      this.store.require<OrgCustomRole>('roles', id);
      const next = this.store.update<OrgCustomRole>('roles', id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.permissions !== undefined ? { permissions: unique(input.permissions) } : {}),
      }, this.now(), input.revision);
      if (input.permissions !== undefined) for (const member of this.holders(id)) this.regrant(member);
      this.log(by.member.id, 'role.updated', id, { name: next.name, permissions: next.permissions });
      return next;
    });
  }
  deleteRole(actor: Actor, id: string): { ok: true } {
    this.requireFeature('customRoles');
    const by = this.need(actor, 'roles.manage');
    return this.store.transaction(() => {
      const role = this.store.require<OrgCustomRole>('roles', id);
      const affected = this.holders(id);
      for (const group of this.store.list<OrgGroup>('groups'))
        if (group.customRoleIds.includes(id))
          this.store.update<OrgGroup>('groups', group.id, { customRoleIds: group.customRoleIds.filter(item => item !== id) }, this.now());
      for (const member of affected)
        this.regrant(this.store.require<StoredMember>('members', member.id), { customRoleIds: member.customRoleIds.filter(item => item !== id) });
      this.store.remove('roles', id);
      this.log(by.member.id, 'role.deleted', id, { name: role.name });
      return { ok: true as const };
    });
  }

  // ---- shared library --------------------------------------------------------------------------------------------
  private canRead(member: StoredMember, item: OrgLibrarySummary): boolean {
    if (item.status !== 'published') return false;
    if (item.audience.kind === 'everyone') return true;
    // A group audience needs the plan that has groups; without it the item is closed rather than opened to everyone.
    return this.features().scopedLibrary && item.audience.groupIds.some(id => member.groupIds.includes(id));
  }
  private summary(item: OrgLibraryItem): OrgLibrarySummary {
    const { document: _document, ...rest } = item;
    return rest;
  }
  private audience(actor: Actor, audience: OrgLibraryAudience): OrgLibraryAudience {
    if (audience.kind === 'everyone') return audience;
    this.requireFeature('scopedLibrary');
    this.assertGroups(audience.groupIds);
    return { kind: 'groups', groupIds: unique(audience.groupIds) };
  }
  private documentOf(document: Record<string, unknown>): Record<string, unknown> {
    if (Buffer.byteLength(JSON.stringify(document)) > ORG_LIMITS.documentBytes) throw new OrgError(413, 'ORG_TOO_LARGE', '文档太大');
    return document;
  }
  /** A change to a published item is live at once, so it takes the next tick of the library clock. */
  private stamped(item: OrgLibraryItem, patch: Partial<OrgLibraryItem>, expected?: number): OrgLibraryItem {
    const live = (patch.status ?? item.status) === 'published';
    const next = this.store.update<OrgLibraryItem>('library', item.id, { ...patch, ...(live ? { version: this.tick('library') } : {}) }, this.now(), expected);
    if (!live && item.status === 'published') this.tick('library');
    return next;
  }
  /** Managers see every item; readers see what is published for them. */
  library(actor: Actor): OrgLibrarySummary[] {
    const by = this.need(actor, 'library.read');
    const manage = by.permissions.has('library.manage');
    return this.store.list<OrgLibraryItem>('library')
      .filter(item => manage || this.canRead(by.member, item))
      .map(item => this.summary(item));
  }
  libraryItem(actor: Actor, id: string): OrgLibraryItem {
    const by = this.need(actor, 'library.read');
    const item = this.store.require<OrgLibraryItem>('library', id);
    // An item a reader may not see does not exist for them.
    if (!by.permissions.has('library.manage') && !this.canRead(by.member, item)) throw new OrgError(404, 'ORG_NOT_FOUND', '记录不存在');
    return item;
  }
  createLibraryItem(actor: Actor, raw: unknown): OrgLibraryItem {
    const by = this.need(actor, 'library.manage');
    const input = orgLibraryInputSchema.parse(raw);
    const audience = this.audience(actor, input.audience);
    return this.store.transaction(() => {
      if (this.store.count('library') >= ORG_LIMITS.libraryItems) throw limit('角色库条目数量已达上限');
      const item = this.store.create<OrgLibraryItem>('library', {
        kind: input.kind, name: input.name, status: 'draft', version: 0, audience, assets: [],
        updatedBy: by.member.id, document: this.documentOf(input.document),
      }, this.now());
      this.log(by.member.id, 'library.created', item.id, { kind: item.kind, name: item.name });
      return item;
    });
  }
  patchLibraryItem(actor: Actor, id: string, raw: unknown): OrgLibraryItem {
    const by = this.need(actor, 'library.manage');
    const input = orgLibraryPatchSchema.parse(raw);
    const audience = input.audience ? this.audience(actor, input.audience) : undefined;
    return this.store.transaction(() => {
      const item = this.store.require<OrgLibraryItem>('library', id);
      const next = this.stamped(item, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.document !== undefined ? { document: this.documentOf(input.document) } : {}),
        ...(audience ? { audience } : {}),
        updatedBy: by.member.id,
      }, input.revision);
      this.log(by.member.id, 'library.updated', id, { name: next.name, document: input.document !== undefined, audience: next.audience });
      return next;
    });
  }
  setLibraryStatus(actor: Actor, id: string, status: 'published' | 'retired', raw: unknown): OrgLibraryItem {
    const by = this.need(actor, 'library.manage');
    const input = orgLibraryStatusSchema.parse(raw);
    return this.store.transaction(() => {
      const item = this.store.require<OrgLibraryItem>('library', id);
      const next = this.stamped(item, { status, updatedBy: by.member.id }, input.revision);
      this.log(by.member.id, `library.${status}`, id, { name: item.name });
      return next;
    });
  }
  deleteLibraryItem(actor: Actor, id: string): { ok: true } {
    const by = this.need(actor, 'library.manage');
    return this.store.transaction(() => {
      const item = this.store.require<OrgLibraryItem>('library', id);
      this.store.removeAssets(id);
      this.store.remove('library', id);
      this.tick('library');
      this.log(by.member.id, 'library.deleted', id, { kind: item.kind, name: item.name });
      return { ok: true as const };
    });
  }
  /** Saves an image of an item (portrait, sprite). One image per role: a new one replaces the old one. */
  putAsset(actor: Actor, id: string, raw: unknown): OrgLibraryItem {
    const by = this.need(actor, 'library.manage');
    const input = orgLibraryAssetSchema.parse(raw);
    const text = input.data.replace(/^data:[^,]*;base64,/, '');
    if (text.length > Math.ceil(ORG_LIMITS.assetBytes / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw invalid('图片数据无效或太大');
    const bytes = Buffer.from(text, 'base64');
    if (!bytes.length || bytes.length > ORG_LIMITS.assetBytes) throw invalid('图片数据无效或太大');
    if (imageKind(bytes) !== input.mime) throw invalid('图片内容与类型不符');
    return this.store.transaction(() => {
      const item = this.store.require<OrgLibraryItem>('library', id);
      const kept = item.assets.filter(asset => asset.role !== input.role);
      if (kept.length >= ORG_LIMITS.assetsPerItem) throw limit('这个条目的图片数量已达上限');
      for (const asset of item.assets) if (asset.role === input.role) this.store.removeAssets(id, asset.id);
      const asset: OrgLibraryAsset = { id: randomUUID(), role: input.role, mime: input.mime, bytes: bytes.length, sha256: digest(bytes) };
      this.store.putAsset(id, asset.id, bytes);
      const next = this.stamped(item, { assets: [...kept, asset], updatedBy: by.member.id }, input.revision);
      this.log(by.member.id, 'library.asset.saved', id, { role: asset.role, bytes: asset.bytes });
      return next;
    });
  }
  asset(actor: Actor, id: string, assetId: string): { bytes: Uint8Array; mime: string } {
    const service = actor.kind === 'service' && actor.token.scopes.includes('library.sync');
    const item = service ? this.store.require<OrgLibraryItem>('library', id) : this.libraryItem(actor, id);
    if (service && item.status !== 'published') throw new OrgError(404, 'ORG_NOT_FOUND', '记录不存在');
    const meta = item.assets.find(asset => asset.id === assetId);
    const bytes = meta ? this.store.asset(id, assetId) : null;
    if (!meta || !bytes) throw new OrgError(404, 'ORG_NOT_FOUND', '图片不存在');
    return { bytes, mime: meta.mime };
  }

  // ---- audit (enterprise plan) -----------------------------------------------------------------------------------
  audit(actor: Actor, before?: number, count = 100): { items: OrgAuditEvent[]; nextBefore: number | null } {
    this.requireFeature('auditLog');
    this.need(actor, 'audit.read');
    const size = Math.min(Math.max(1, Math.trunc(count)), 500);
    const items = this.store.audit(before && before > 0 ? before : Number.MAX_SAFE_INTEGER, size + 1);
    return { items: items.slice(0, size), nextBefore: items.length > size ? items[size - 1]!.sequence : null };
  }
  verifyAudit(actor: Actor): { valid: boolean; entries: number; head: string | null } {
    this.requireFeature('auditLog');
    this.need(actor, 'audit.read');
    return this.store.verifyAudit();
  }

  // ---- service credentials and sync ------------------------------------------------------------------------------
  serviceTokens(actor: Actor): OrgServiceToken[] {
    this.need(actor, 'org.manage');
    return this.store.list<OrgServiceToken>('service_tokens').map(token => ({
      ...token, lastUsedAt: this.store.tokenOf('service', token.id)?.lastUsedAt ?? null,
    }));
  }
  createServiceToken(actor: Actor, raw: unknown): { record: OrgServiceToken; token: OrgIssuedToken } {
    const by = this.need(actor, 'org.manage');
    const input = orgServiceTokenInputSchema.parse(raw);
    return this.store.transaction(() => {
      if (this.store.count('service_tokens') >= ORG_LIMITS.serviceTokens) throw limit('服务凭据数量已达上限');
      const at = this.now();
      const record = this.store.create<OrgServiceToken>('service_tokens', {
        label: input.label, scopes: unique(input.scopes), expiresAt: at + input.ttlDays * DAY, lastUsedAt: null, createdBy: by.member.id,
      }, at);
      const token = this.issue('service', record.id, input.ttlDays);
      this.log(by.member.id, 'service-token.created', record.id, { label: record.label, scopes: record.scopes });
      return { record, token };
    });
  }
  deleteServiceToken(actor: Actor, id: string): { ok: true } {
    const by = this.need(actor, 'org.manage');
    return this.store.transaction(() => {
      this.store.require<OrgServiceToken>('service_tokens', id);
      this.store.deleteToken('service', id);
      this.store.remove('service_tokens', id);
      this.log(by.member.id, 'service-token.deleted', id);
      return { ok: true as const };
    });
  }
  /** The member list a controller daemon enforces, in the shape of `enterprise.members` of its PA configuration.
   *  Only token digests leave the server, and only to a service credential with the `directory.sync` scope. */
  syncDirectory(actor: Actor): OrgDirectorySync {
    if (actor.kind !== 'service' || !actor.token.scopes.includes('directory.sync')) throw forbidden('需要带目录同步范围的服务凭据');
    const org = this.org();
    const at = this.now();
    const members = this.store.list<StoredMember>('members').flatMap(member => {
      const token = this.store.tokenOf('member', member.id);
      if (member.status !== 'active' || !token || token.expiresAt <= at) return [];
      const permissions = this.permissionsOf(member);
      return [{
        id: member.id, role: orgPaRole(member.role, permissions), group: member.groupIds[0] ?? 'default',
        tokenSha256: token.sha256, grantVersion: member.grantVersion, expiresAt: token.expiresAt,
        permissions: orgPaPermissions(permissions), groups: this.features().groups ? member.groupIds : [],
      }];
    });
    return { tenantId: org.id, generatedAt: at, version: this.clock('directory'), members, policy: org.policy };
  }
  /** What a member's client pulls: every item it may read that changed after `since`, and the ids it may read now
   *  (anything else it still holds was retired, deleted or moved out of its groups). */
  syncLibrary(actor: Actor, since = 0): OrgLibrarySync {
    // A controller daemon (service credential, `library.sync`) takes every published item with its audience and shows
    // each member only what the audience allows. A member's own client gets what that member may read.
    const all = actor.kind === 'service';
    if (all && !actor.token.scopes.includes('library.sync')) throw forbidden('需要带角色库同步范围的服务凭据');
    const reader = all ? null : this.need(actor, 'library.read').member;
    const readable = this.store.list<OrgLibraryItem>('library')
      .filter(item => reader ? this.canRead(reader, item) : item.status === 'published');
    return {
      version: this.clock('library'),
      items: readable.filter(item => item.version > since),
      current: readable.map(item => item.id),
    };
  }

  // ---- single sign-on (OIDC) -------------------------------------------------------------------------------------
  publicInfo(): OrgPublicInfo {
    const org = this.store.list<OrgInfo>('org')[0];
    const sso = org ? this.ssoSettings() : null;
    return { initialized: Boolean(org), name: org?.name ?? null, sso: Boolean(sso?.enabled && this.publicUrl) };
  }
  redirectUri(): string | null { return this.publicUrl ? `${this.publicUrl}/v1/sso/callback` : null; }
  /** The stored settings with the client secret, for the sign-in flow only. Null when SSO was never set up or the
   *  plan no longer has it. */
  ssoSettings(): SsoSettings | null {
    const stored = this.store.get<StoredSso>('meta', 'sso');
    return stored && this.features().sso ? stored : null;
  }
  sso(actor: Actor): OrgSsoConfig {
    this.need(actor, 'org.manage');
    const stored = this.store.get<StoredSso>('meta', 'sso');
    return {
      enabled: stored?.enabled ?? false, issuer: stored?.issuer ?? '', clientId: stored?.clientId ?? '',
      hasClientSecret: Boolean(stored?.clientSecret), allowedDomains: stored?.allowedDomains ?? [],
      autoProvision: stored?.autoProvision ?? false, defaultRole: stored?.defaultRole ?? 'member', redirectUri: this.redirectUri(),
    };
  }
  saveSso(actor: Actor, raw: unknown): OrgSsoConfig {
    const by = this.need(actor, 'org.manage');
    this.requireFeature('sso');
    const input = orgSsoInputSchema.parse(raw);
    const issuer = new URL(input.issuer);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(issuer.hostname);
    if (issuer.username || issuer.password || issuer.hash || issuer.search || !(issuer.protocol === 'https:' || issuer.protocol === 'http:' && loopback))
      throw invalid('身份提供方地址必须使用 HTTPS，且不能包含凭据或参数');
    return this.store.transaction(() => {
      const stored = this.store.get<StoredSso>('meta', 'sso');
      const clientSecret = input.clientSecret ?? stored?.clientSecret ?? '';
      if (input.enabled && !clientSecret) throw invalid('启用单点登录前需要填写客户端密钥');
      const doc: SsoSettings = {
        enabled: input.enabled, issuer: input.issuer.replace(/\/+$/, ''), clientId: input.clientId, clientSecret,
        allowedDomains: unique(input.allowedDomains), autoProvision: input.autoProvision, defaultRole: input.defaultRole,
      };
      if (stored) this.store.update<StoredSso>('meta', 'sso', doc, this.now());
      else this.store.create<StoredSso>('meta', doc, this.now(), 'sso');
      this.log(by.member.id, 'sso.updated', null, { enabled: doc.enabled, issuer: doc.issuer, autoProvision: doc.autoProvision, secretChanged: input.clientSecret !== undefined });
      return this.sso(actor);
    });
  }
  /** The last step of a sign-in: the provider has vouched for `profile`. Finds the member (by the linked subject, then
   *  by email), creates one when the organization allows it, and opens a console session. Roles never come from the
   *  provider: a new member gets the default role and an existing one keeps theirs. */
  ssoSignIn(profile: SsoProfile): OrgIssuedToken {
    const settings = this.ssoSettings();
    if (!settings?.enabled) throw new OrgError(403, 'ORG_SSO_DISABLED', '组织没有启用单点登录');
    const email = profile.email.trim().toLowerCase();
    const emailDomain = email.slice(email.lastIndexOf('@') + 1);
    if (settings.allowedDomains.length && !settings.allowedDomains.includes(emailDomain))
      throw new OrgError(403, 'ORG_SSO_DOMAIN', '这个邮箱域名不在允许范围内');
    return this.store.transaction(() => {
      const members = this.store.list<StoredMember>('members');
      let member = members.find(item => item.ssoSubject === profile.subject)
        ?? members.find(item => item.ssoSubject === null && item.email.toLowerCase() === email) ?? null;
      if (!member) {
        if (!settings.autoProvision) throw new OrgError(403, 'ORG_SSO_NOT_MEMBER', '你还不是这个组织的成员，请联系管理员添加');
        if (members.some(item => item.email.toLowerCase() === email)) throw new OrgError(403, 'ORG_SSO_NOT_MEMBER', '这个邮箱已绑定其他登录身份');
        if (members.length >= this.features().maxMembers) throw limit('成员数已达到套餐上限');
        const at = this.now();
        member = this.store.create<StoredMember>('members', {
          name: profile.name.trim().slice(0, 80) || email.slice(0, email.lastIndexOf('@')), email, role: settings.defaultRole,
          primary: false, status: 'active', groupIds: [], customRoleIds: [], grantVersion: at, ssoSubject: profile.subject, externalId: null,
        }, at);
        this.tick('directory');
        this.log(member.id, 'member.provisioned.sso', member.id, { role: member.role });
      }
      if (member.status !== 'active') throw new OrgError(403, 'ORG_SSO_SUSPENDED', '账号已停用，请联系管理员');
      if (member.ssoSubject !== profile.subject)
        member = this.store.update<StoredMember>('members', member.id, { ssoSubject: profile.subject }, this.now());
      const at = this.now();
      for (const session of this.store.list<StoredSession>('sessions')) {
        if (session.expiresAt > at) continue;
        this.store.deleteToken('session', session.id);
        this.store.remove('sessions', session.id);
      }
      const session = this.store.create<StoredSession>('sessions', { memberId: member.id, expiresAt: at + SESSION_MS }, at);
      this.log(member.id, 'sso.signed-in', member.id);
      return this.issue('session', session.id, 0, SESSION_MS);
    });
  }

  // ---- SCIM provisioning (enterprise plan) -----------------------------------------------------------------------
  scimStatus(actor: Actor): OrgScimStatus {
    this.need(actor, 'org.manage');
    const token = this.features().scim ? this.store.tokenOf('scim', SCIM_OWNER) : null;
    return {
      enabled: token !== null && token.expiresAt > this.now(), baseUrl: this.publicUrl ? `${this.publicUrl}/scim/v2` : null,
      tokenCreatedAt: token?.createdAt ?? null, lastUsedAt: token?.lastUsedAt ?? null,
    };
  }
  /** Generates the provisioning token (replacing any earlier one). It can add, update, suspend and remove members and
   *  groups, and nothing else: it never assigns a role and never touches the primary owner. */
  createScimToken(actor: Actor): OrgIssuedToken {
    const by = this.need(actor, 'org.manage');
    this.requireFeature('scim');
    return this.store.transaction(() => {
      const token = this.issue('scim', SCIM_OWNER, 3650);
      this.log(by.member.id, 'scim.token.created', null);
      return token;
    });
  }
  deleteScimToken(actor: Actor): { ok: true } {
    const by = this.need(actor, 'org.manage');
    return this.store.transaction(() => {
      this.store.deleteToken('scim', SCIM_OWNER);
      this.log(by.member.id, 'scim.token.deleted', null);
      return { ok: true as const };
    });
  }
  authenticateScim(bearer: string | undefined): boolean {
    if (!bearer || !TOKEN.test(bearer) || !this.initialized() || !this.features().scim) return false;
    const row = this.store.tokenByDigest(digest(bearer));
    const at = this.now();
    if (!row || row.kind !== 'scim' || row.expiresAt <= at) return false;
    if (row.lastUsedAt === null || at - row.lastUsedAt > 60_000) this.store.touchToken(row.sha256, at);
    return true;
  }
  scimUsers(): OrgMember[] { return this.store.list<StoredMember>('members').map(member => this.view(member)); }
  scimUser(id: string): OrgMember { return this.view(this.store.require<StoredMember>('members', id)); }
  scimCreateUser(input: { email: string; name: string; active: boolean; externalId: string | null }): OrgMember {
    return this.store.transaction(() => {
      if (this.store.count('members') >= this.features().maxMembers) throw limit('成员数已达到套餐上限');
      this.assertEmailFree(input.email);
      const at = this.now();
      const member = this.store.create<StoredMember>('members', {
        name: input.name, email: input.email, role: 'member', primary: false, status: input.active ? 'active' : 'suspended',
        groupIds: [], customRoleIds: [], grantVersion: at, ssoSubject: null, externalId: input.externalId,
      }, at);
      this.tick('directory');
      this.log(SCIM_OWNER, 'member.provisioned.scim', member.id, { active: input.active });
      return this.view(member);
    });
  }
  scimUpdateUser(id: string, patch: { email?: string; name?: string; active?: boolean; externalId?: string | null }): OrgMember {
    return this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      const status = patch.active === undefined ? target.status : patch.active ? 'active' : 'suspended';
      if (target.primary && status !== 'active') throw forbidden('主要所有者不能通过 SCIM 停用');
      if (patch.email !== undefined) this.assertEmailFree(patch.email, id);
      const fields: Partial<StoredMember> = {
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
        status,
      };
      const next = status !== target.status ? this.regrant(target, fields) : this.store.update<StoredMember>('members', id, fields, this.now());
      this.log(SCIM_OWNER, 'member.updated.scim', id, { fields: Object.keys(patch) });
      return this.view(next);
    });
  }
  scimDeleteUser(id: string): void {
    this.store.transaction(() => {
      const target = this.store.require<StoredMember>('members', id);
      if (target.primary) throw forbidden('主要所有者不能通过 SCIM 移除');
      this.store.deleteToken('member', id);
      this.store.remove('members', id);
      this.tick('directory');
      this.log(SCIM_OWNER, 'member.removed.scim', id, { role: target.role });
    });
  }
  scimGroups(): Array<OrgGroup & { memberIds: string[] }> {
    const members = this.store.list<StoredMember>('members');
    return this.store.list<OrgGroup>('groups').map(group => ({
      ...group, memberIds: members.filter(member => member.groupIds.includes(group.id)).map(member => member.id),
    }));
  }
  scimGroup(id: string): OrgGroup & { memberIds: string[] } {
    const group = this.scimGroups().find(item => item.id === id);
    if (!group) throw new OrgError(404, 'ORG_NOT_FOUND', '记录不存在');
    return group;
  }
  /** Sets who is in a group. Members named here must exist; everyone else leaves the group. */
  private scimSetMembers(groupId: string, memberIds: readonly string[]): void {
    const wanted = new Set(memberIds);
    for (const id of wanted) this.store.require<StoredMember>('members', id);
    for (const member of this.store.list<StoredMember>('members')) {
      const inGroup = member.groupIds.includes(groupId);
      if (inGroup === wanted.has(member.id)) continue;
      this.regrant(member, { groupIds: inGroup ? member.groupIds.filter(id => id !== groupId) : [...member.groupIds, groupId] });
    }
  }
  scimCreateGroup(input: { name: string; memberIds: string[] }): OrgGroup & { memberIds: string[] } {
    this.requireFeature('groups');
    return this.store.transaction(() => {
      if (this.store.count('groups') >= ORG_LIMITS.groups) throw limit('用户组数量已达上限');
      if (this.store.list<OrgGroup>('groups').some(group => group.name === input.name)) throw new OrgError(409, 'ORG_CONFLICT', '已有同名用户组');
      const group = this.store.create<OrgGroup>('groups', { name: input.name, customRoleIds: [] }, this.now());
      this.scimSetMembers(group.id, input.memberIds);
      this.log(SCIM_OWNER, 'group.created.scim', group.id, { name: group.name });
      return this.scimGroup(group.id);
    });
  }
  scimUpdateGroup(id: string, patch: { name?: string; memberIds?: string[] }): OrgGroup & { memberIds: string[] } {
    this.requireFeature('groups');
    return this.store.transaction(() => {
      this.store.require<OrgGroup>('groups', id);
      if (patch.name !== undefined) this.store.update<OrgGroup>('groups', id, { name: patch.name }, this.now());
      if (patch.memberIds !== undefined) this.scimSetMembers(id, patch.memberIds);
      this.log(SCIM_OWNER, 'group.updated.scim', id, { fields: Object.keys(patch) });
      return this.scimGroup(id);
    });
  }
  /** Removes a group the way an owner would: through the same rule, so scoped library items close instead of opening. */
  scimDeleteGroup(id: string): void {
    this.requireFeature('groups');
    const owner = this.store.list<StoredMember>('members').find(member => member.primary);
    if (!owner) throw new OrgError(503, 'ORG_NOT_INITIALIZED', '组织尚未初始化');
    this.deleteGroup({ kind: 'member', member: owner, permissions: new Set(this.permissionsOf(owner)), auth: 'token' }, id);
  }
}
