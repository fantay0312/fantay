import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrgIssuedToken, OrgMember, OrgPlan } from '@open-design/contracts/org';
import { createOrgServer } from '../src/server.js';
import { OrgService, type Actor } from '../src/service.js';
import { OrgError } from '../src/store.js';

const dirs: string[] = [];
const open: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const item of open.splice(0)) item.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fantay-org-'));
  dirs.push(dir);
  return dir;
}
/** 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return error instanceof OrgError ? error.code : error instanceof Error ? error.name : 'unknown'; }
  return 'ok';
};

async function org(plan: OrgPlan = 'enterprise') {
  let clock = 1_800_000_000_000;
  const service = new OrgService(await directory(), () => (clock += 1000));
  open.push(service);
  const created = service.init({ id: 'acme', name: 'Acme', plan, owner: { name: 'Olivia', email: 'olivia@acme.test' } });
  const as = (token: OrgIssuedToken): Actor => {
    const actor = service.authenticate(token.token);
    if (!actor) throw new Error('token rejected');
    return actor;
  };
  const owner = () => as(created.token);
  const add = (role: OrgMember['role'], name: string, by: () => Actor = owner) => {
    const added = service.addMember(by(), { name, email: `${name.toLowerCase()}@acme.test`, role });
    return { ...added, actor: () => as(added.token) };
  };
  return { service, created, owner, add, as, advance: (ms: number) => { clock += ms; } };
}

describe('roles and separation of privileges', () => {
  it('initializes once and gives the owner every permission the plan has', async () => {
    const team = await org('team');
    expect(code(() => team.service.init({ id: 'again', name: 'x', owner: { name: 'x', email: 'x@acme.test' } }))).toBe('ORG_CONFLICT');
    const session = team.service.session(team.owner());
    expect(session.member).toMatchObject({ role: 'owner', primary: true });
    expect(session.paRole).toBe('admin');
    expect(session.permissions).toEqual(['org.manage', 'roles.manage', 'members.manage', 'library.manage', 'library.read', 'chat.use']);
    const enterprise = await org('enterprise');
    expect(enterprise.service.session(enterprise.owner()).permissions).toContain('audit.read');
    expect(enterprise.service.session(enterprise.owner()).permissions).toContain('groups.manage');
  });

  it('lets admins manage members and viewers, and only owners manage admins, owners and roles', async () => {
    const { service, owner, add, created } = await org();
    const admin = add('admin', 'Adam');
    const admin2 = add('admin', 'Ada');
    expect(service.session(admin.actor()).permissions).toEqual(['members.manage', 'groups.manage', 'library.manage', 'library.read', 'chat.use']);
    // An admin adds members and viewers, never admins or owners.
    const member = add('member', 'Mia', admin.actor);
    expect(code(() => add('admin', 'Eve', admin.actor))).toBe('ORG_FORBIDDEN');
    expect(code(() => add('owner', 'Eve', admin.actor))).toBe('ORG_FORBIDDEN');
    // Roles are the owner's to assign.
    expect(code(() => service.setRole(admin.actor(), member.member.id, { role: 'admin', revision: member.member.revision }))).toBe('ORG_FORBIDDEN');
    // An admin does not touch another admin, the owner, or their own account.
    for (const target of [admin2.member, created.owner, admin.member])
      expect(code(() => service.patchMember(admin.actor(), target.id, { status: 'suspended', revision: target.revision })), target.name).toBe('ORG_FORBIDDEN');
    expect(code(() => service.removeMember(admin.actor(), admin2.member.id))).toBe('ORG_FORBIDDEN');
    expect(service.patchMember(admin.actor(), member.member.id, { status: 'suspended', revision: member.member.revision }).status).toBe('suspended');
    // The owner manages admins, but nobody demotes or removes the primary owner, and nobody changes their own role.
    expect(service.setRole(owner(), admin2.member.id, { role: 'member', revision: admin2.member.revision }).role).toBe('member');
    const second = add('owner', 'Otto');
    expect(code(() => service.removeMember(second.actor(), created.owner.id))).toBe('ORG_FORBIDDEN');
    expect(code(() => service.setRole(second.actor(), created.owner.id, { role: 'member', revision: created.owner.revision }))).toBe('ORG_FORBIDDEN');
    expect(code(() => service.setRole(second.actor(), second.member.id, { role: 'admin', revision: second.member.revision }))).toBe('ORG_FORBIDDEN');
    // Members and viewers hold no management permission at all.
    const plain = add('member', 'Max');
    const viewer = add('viewer', 'Vic');
    for (const actor of [plain.actor(), viewer.actor()]) {
      expect(code(() => service.members(actor))).toBe('ORG_FORBIDDEN');
      expect(code(() => service.addMember(actor, { name: 'x', email: 'x@acme.test' }))).toBe('ORG_FORBIDDEN');
      expect(code(() => service.patchOrg(actor, { name: 'x', revision: 1 }))).toBe('ORG_FORBIDDEN');
      expect(code(() => service.createLibraryItem(actor, { kind: 'character', name: 'x', document: {} }))).toBe('ORG_FORBIDDEN');
    }
    expect(service.session(plain.actor()).paRole).toBe('operator');
    expect(service.session(viewer.actor())).toMatchObject({ paRole: 'viewer', permissions: ['library.read'] });
  });

  it('ends access on suspension and rotation, and moves the grant version', async () => {
    const { service, owner, add } = await org();
    const mia = add('member', 'Mia');
    const before = service.members(owner()).find(item => item.id === mia.member.id)!;
    // A member rotates their own token; the old one stops working.
    const fresh = service.rotateToken(mia.actor(), mia.member.id, {});
    expect(service.authenticate(mia.token.token)).toBeNull();
    expect(service.authenticate(fresh.token)).not.toBeNull();
    const rotated = service.members(owner()).find(item => item.id === mia.member.id)!;
    expect(rotated.grantVersion).toBeGreaterThan(before.grantVersion);
    // Another member cannot rotate it.
    const max = add('member', 'Max');
    expect(code(() => service.rotateToken(max.actor(), mia.member.id, {}))).toBe('ORG_FORBIDDEN');
    service.patchMember(owner(), mia.member.id, { status: 'suspended', revision: rotated.revision });
    expect(service.authenticate(fresh.token)).toBeNull();
    expect(code(() => service.rotateToken(owner(), mia.member.id, {}))).toBe('ORG_INVALID_REQUEST');
  });

  it('expires tokens and moves the primary owner only by transfer', async () => {
    const { service, owner, add, advance, created } = await org();
    const otto = add('member', 'Otto');
    expect(code(() => service.transfer(otto.actor(), { memberId: otto.member.id }))).toBe('ORG_FORBIDDEN');
    const next = service.transfer(owner(), { memberId: otto.member.id });
    expect(next).toMatchObject({ role: 'owner', primary: true });
    expect(service.session(owner()).member).toMatchObject({ role: 'owner', primary: false });
    expect(code(() => service.changePlan(owner(), { plan: 'team', revision: 1 }))).toBe('ORG_FORBIDDEN');
    advance(91 * 86_400_000);
    expect(service.authenticate(created.token.token)).toBeNull();
  });
});

describe('plans', () => {
  it('keeps groups, custom roles, scoped items and the audit log to the enterprise plan', async () => {
    const { service, owner } = await org('team');
    expect(code(() => service.createGroup(owner(), { name: '设计组' }))).toBe('ORG_PLAN_REQUIRED');
    expect(code(() => service.createRole(owner(), { name: '策展人', permissions: ['library.manage'] }))).toBe('ORG_PLAN_REQUIRED');
    expect(code(() => service.audit(owner()))).toBe('ORG_PLAN_REQUIRED');
    expect(code(() => service.createLibraryItem(owner(), {
      kind: 'character', name: 'x', document: {}, audience: { kind: 'groups', groupIds: ['g'] },
    }))).toBe('ORG_PLAN_REQUIRED');
    const info = service.info(owner());
    expect(code(() => service.patchOrg(owner(), { policy: { ...info.policy, retentionDays: 90 }, revision: info.revision }))).toBe('ORG_PLAN_REQUIRED');
  });

  it('adds custom roles on top of the built-in role, directly and through groups, and drops them on the team plan', async () => {
    const { service, owner, add } = await org('enterprise');
    const curator = service.createRole(owner(), { name: '策展人', permissions: ['library.manage'] });
    const auditor = service.createRole(owner(), { name: '审计员', permissions: ['audit.read'] });
    // Organization and role administration can never be put in a custom role.
    expect(code(() => service.createRole(owner(), { name: 'x', permissions: ['roles.manage'] }))).toBe('ZodError');
    const mia = add('member', 'Mia');
    const max = add('member', 'Max');
    service.setRole(owner(), mia.member.id, { customRoleIds: [curator.id], revision: mia.member.revision });
    expect(service.session(mia.actor()).permissions).toEqual(['library.manage', 'library.read', 'chat.use']);
    // Through a group: only an owner may attach a role to a group.
    const admin = add('admin', 'Adam');
    expect(code(() => service.createGroup(admin.actor(), { name: '合规', customRoleIds: [auditor.id] }))).toBe('ORG_FORBIDDEN');
    const group = service.createGroup(owner(), { name: '合规', customRoleIds: [auditor.id] });
    service.patchMember(owner(), max.member.id, { groupIds: [group.id], revision: max.member.revision });
    expect(service.session(max.actor()).permissions).toEqual(['library.read', 'chat.use', 'audit.read']);
    expect(service.verifyAudit(max.actor()).valid).toBe(true);
    // Removing the role takes the permission away again.
    service.deleteRole(owner(), auditor.id);
    expect(service.session(max.actor()).permissions).toEqual(['library.read', 'chat.use']);
    // On the team plan custom roles stay on file and stop applying.
    service.changePlan(owner(), { plan: 'team', revision: service.info(owner()).revision });
    expect(service.session(mia.actor()).permissions).toEqual(['library.read', 'chat.use']);
  });
});

describe('shared library', () => {
  it('shows members what is published for them and nothing else', async () => {
    const { service, owner, add } = await org('enterprise');
    const mia = add('member', 'Mia');
    const max = add('member', 'Max');
    const group = service.createGroup(owner(), { name: '客服组' });
    service.patchMember(owner(), mia.member.id, { groupIds: [group.id], revision: mia.member.revision });
    const draft = service.createLibraryItem(owner(), { kind: 'character', name: '小月', document: { spec: 'chara_card_v2', data: { name: '小月' } } });
    expect(draft).toMatchObject({ status: 'draft', version: 0 });
    expect(service.library(mia.actor())).toEqual([]);
    expect(code(() => service.libraryItem(mia.actor(), draft.id))).toBe('ORG_NOT_FOUND');
    const published = service.setLibraryStatus(owner(), draft.id, 'published', { revision: draft.revision });
    expect(published.version).toBe(1);
    expect(service.library(mia.actor()).map(item => item.name)).toEqual(['小月']);
    expect(service.libraryItem(max.actor(), draft.id).document).toEqual({ spec: 'chara_card_v2', data: { name: '小月' } });
    // An item for one group is invisible outside it.
    const scoped = service.createLibraryItem(owner(), {
      kind: 'character', name: '客服手册', document: {}, audience: { kind: 'groups', groupIds: [group.id] },
    });
    service.setLibraryStatus(owner(), scoped.id, 'published', { revision: scoped.revision });
    expect(service.library(mia.actor()).map(item => item.name)).toEqual(['小月', '客服手册']);
    expect(service.library(max.actor()).map(item => item.name)).toEqual(['小月']);
    expect(code(() => service.libraryItem(max.actor(), scoped.id))).toBe('ORG_NOT_FOUND');
    // Sync: everything new since the cursor, and the ids still readable.
    const first = service.syncLibrary(mia.actor());
    expect(first.items.map(item => item.id).sort()).toEqual([draft.id, scoped.id].sort());
    expect(service.syncLibrary(mia.actor(), first.version).items).toEqual([]);
    const edited = service.patchLibraryItem(owner(), draft.id, { name: '小月 2', revision: published.revision });
    const second = service.syncLibrary(mia.actor(), first.version);
    expect(second.items.map(item => item.name)).toEqual(['小月 2']);
    service.setLibraryStatus(owner(), draft.id, 'retired', { revision: edited.revision });
    const third = service.syncLibrary(mia.actor(), second.version);
    expect(third.items).toEqual([]);
    expect(third.current).toEqual([scoped.id]);
    expect(third.version).toBeGreaterThan(second.version);
    // Deleting the group closes the item that was only for it instead of opening it to everyone.
    service.deleteGroup(owner(), group.id);
    expect(service.library(max.actor())).toEqual([]);
    expect(service.library(owner()).find(item => item.id === scoped.id)).toMatchObject({ status: 'draft', audience: { kind: 'everyone' } });
  });

  it('stores images by role and checks their content', async () => {
    const { service, owner, add } = await org();
    const mia = add('member', 'Mia');
    const item = service.createLibraryItem(owner(), { kind: 'character', name: '小月', document: {} });
    expect(code(() => service.putAsset(owner(), item.id, { role: 'portrait', mime: 'image/jpeg', data: PNG, revision: item.revision }))).toBe('ORG_INVALID_REQUEST');
    const withPortrait = service.putAsset(owner(), item.id, { role: 'portrait', mime: 'image/png', data: PNG, revision: item.revision });
    const replaced = service.putAsset(owner(), item.id, { role: 'portrait', mime: 'image/png', data: PNG, revision: withPortrait.revision });
    expect(replaced.assets).toHaveLength(1);
    expect(code(() => service.asset(owner(), item.id, withPortrait.assets[0]!.id))).toBe('ORG_NOT_FOUND');
    expect(code(() => service.asset(mia.actor(), item.id, replaced.assets[0]!.id))).toBe('ORG_NOT_FOUND');
    service.setLibraryStatus(owner(), item.id, 'published', { revision: replaced.revision });
    expect(service.asset(mia.actor(), item.id, replaced.assets[0]!.id).mime).toBe('image/png');
    expect(code(() => service.putAsset(mia.actor(), item.id, { role: 'portrait', mime: 'image/png', data: PNG, revision: 1 }))).toBe('ORG_FORBIDDEN');
  });
});

describe('audit and directory sync', () => {
  it('chains the audit log and notices tampering', async () => {
    const { service, owner, add } = await org('enterprise');
    const mia = add('member', 'Mia');
    service.removeMember(owner(), mia.member.id);
    const log = service.audit(owner());
    expect(log.items.map(item => item.action)).toEqual(['member.removed', 'member.added', 'org.created']);
    expect(code(() => service.audit(add('admin', 'Adam').actor()))).toBe('ORG_FORBIDDEN');
    expect(service.verifyAudit(owner())).toMatchObject({ valid: true, entries: 4 });
    service.store.db.prepare("UPDATE audit SET detail='{\"role\":\"owner\"}' WHERE sequence=2").run();
    expect(service.verifyAudit(owner())).toMatchObject({ valid: false, entries: 1 });
  });

  it('hands the member directory only to a service credential with the scope', async () => {
    const { service, owner, add, as } = await org('enterprise');
    const curator = service.createRole(owner(), { name: '策展人', permissions: ['library.manage'] });
    const mia = add('member', 'Mia');
    service.setRole(owner(), mia.member.id, { customRoleIds: [curator.id], revision: mia.member.revision });
    const vic = add('viewer', 'Vic');
    const gone = add('member', 'Gone');
    service.patchMember(owner(), gone.member.id, { status: 'suspended', revision: gone.member.revision });
    expect(code(() => service.syncDirectory(owner()))).toBe('ORG_FORBIDDEN');
    expect(code(() => service.createServiceToken(mia.actor(), { label: 'x', scopes: ['directory.sync'] }))).toBe('ORG_FORBIDDEN');
    const credential = service.createServiceToken(owner(), { label: '总部控制器', scopes: ['directory.sync'] });
    const sync = service.syncDirectory(as(credential.token));
    expect(sync.tenantId).toBe('acme');
    expect(sync.members.map(item => [item.id === mia.member.id ? 'mia' : item.id === vic.member.id ? 'vic' : 'owner', item.role, item.permissions])).toEqual([
      ['owner', 'admin', ['library.manage']], ['mia', 'operator', ['library.manage']], ['vic', 'viewer', []],
    ]);
    expect(sync.members.every(item => /^[a-f0-9]{64}$/.test(item.tokenSha256) && item.group === 'default')).toBe(true);
    // A service credential is for sync only: it is nobody's session.
    expect(code(() => service.session(as(credential.token)))).toBe('ORG_FORBIDDEN');
    expect(code(() => service.members(as(credential.token)))).toBe('ORG_FORBIDDEN');
    service.deleteServiceToken(owner(), credential.record.id);
    expect(service.authenticate(credential.token.token)).toBeNull();
  });
});

describe('http surface', () => {
  it('authenticates every route and answers with stable error codes', async () => {
    const app = createOrgServer({ dataDir: await directory() });
    open.push(app);
    const created = app.service.init({ id: 'acme', name: 'Acme', plan: 'enterprise', owner: { name: 'Olivia', email: 'olivia@acme.test' } });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const call = async (token: string | null, method: string, route: string, body?: unknown) => {
      const response = await fetch(`${base}${route}`, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, response };
    };
    const json = async (result: Promise<{ response: Response }>) => (await result).response.json() as Promise<any>;
    expect(await json(call(null, 'GET', '/healthz'))).toEqual({ ok: true, initialized: true });
    expect((await call(null, 'GET', '/v1/me')).status).toBe(401);
    expect((await call('fto_' + 'a'.repeat(43), 'GET', '/v1/me')).status).toBe(401);
    const owner = created.token.token;
    expect((await json(call(owner, 'GET', '/v1/me'))).member.role).toBe('owner');
    expect((await call(owner, 'GET', '/v1/nothing')).status).toBe(404);
    expect((await call(owner, 'PUT', '/v1/org')).status).toBe(405);
    const added = await json(call(owner, 'POST', '/v1/members', { name: 'Mia', email: 'mia@acme.test', role: 'member' }));
    const mia: string = added.token.token;
    const denied = await call(mia, 'GET', '/v1/members');
    expect(denied.status).toBe(403);
    expect((await denied.response.json() as any).error.code).toBe('ORG_FORBIDDEN');
    expect((await call(owner, 'POST', '/v1/members', { name: '' })).status).toBe(400);
    // Library round trip, image included.
    const item = await json(call(owner, 'POST', '/v1/library', { kind: 'character', name: '小月', document: { data: { name: '小月' } } }));
    const withImage = await json(call(owner, 'POST', `/v1/library/${item.id}/assets`, { role: 'portrait', mime: 'image/png', data: PNG, revision: item.revision }));
    await call(owner, 'POST', `/v1/library/${item.id}/publish`, { revision: withImage.revision });
    const image = await call(mia, 'GET', `/v1/library/${item.id}/assets/${withImage.assets[0].id}`);
    expect(image.response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.response.arrayBuffer()).toString('base64')).toBe(PNG);
    expect((await json(call(mia, 'GET', '/v1/sync/library?since=0'))).items).toHaveLength(1);
    expect((await call(mia, 'GET', '/v1/sync/directory')).status).toBe(403);
  });
});
