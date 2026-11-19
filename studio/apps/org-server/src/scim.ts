// SPDX-License-Identifier: AGPL-3.0-only
// SCIM 2.0 (RFC 7643/7644) over the organization's members and groups, for an identity provider's provisioning.
// What it can do is deliberately narrow: create, update, suspend and remove members and groups. It never assigns a
// role and never touches the primary owner; those stay with the owners in the console.
import type { OrgGroup, OrgMember } from '@open-design/contracts/org';
import type { OrgService } from './service.js';
import { OrgError } from './store.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Json = Record<string, unknown>;
type GroupView = OrgGroup & { memberIds: string[] };
export interface ScimResult { status: number; body?: unknown; location?: string }

const bad = (detail: string, scimType = 'invalidValue') => Object.assign(new OrgError(400, 'ORG_INVALID_REQUEST', detail), { scimType });
const object = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
/** Azure AD sends booleans as the strings "True" and "False". */
const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : typeof value === 'string' && /^(true|false)$/i.test(value) ? value.toLowerCase() === 'true' : undefined;
const iso = (at: number) => new Date(at).toISOString();

export function scimError(error: unknown): ScimResult {
  const known = error instanceof OrgError;
  const zod = error instanceof Error && error.name === 'ZodError';
  const status = known ? error.status : zod ? 400 : 500;
  const scimType = (error as { scimType?: string }).scimType ?? (status === 409 ? 'uniqueness' : status === 400 ? 'invalidValue' : undefined);
  return {
    status,
    body: { schemas: [ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail: known ? error.message : zod ? '请求内容无效' : '服务器内部错误' },
  };
}

export class ScimApi {
  constructor(private readonly service: OrgService, private readonly base: string) {}

  // ---- resources -------------------------------------------------------------------------------------------------
  private user(member: OrgMember): Json {
    return {
      schemas: [USER], id: member.id, ...(member.externalId ? { externalId: member.externalId } : {}),
      userName: member.email, displayName: member.name, name: { formatted: member.name },
      emails: [{ value: member.email, primary: true, type: 'work' }], active: member.status === 'active',
      meta: { resourceType: 'User', created: iso(member.createdAt), lastModified: iso(member.updatedAt), location: `${this.base}/Users/${member.id}` },
    };
  }
  private group(group: GroupView, names: ReadonlyMap<string, string>): Json {
    return {
      schemas: [GROUP], id: group.id, displayName: group.name,
      members: group.memberIds.map(id => ({ value: id, display: names.get(id) ?? '', $ref: `${this.base}/Users/${id}` })),
      meta: { resourceType: 'Group', created: iso(group.createdAt), lastModified: iso(group.updatedAt), location: `${this.base}/Groups/${group.id}` },
    };
  }
  private names(): Map<string, string> {
    return new Map(this.service.scimUsers().map(member => [member.id, member.name]));
  }
  private list(resources: Json[], query: URLSearchParams): ScimResult {
    const start = Math.max(1, Number(query.get('startIndex') ?? 1) || 1);
    const count = Math.min(200, Math.max(0, query.has('count') ? Number(query.get('count')) || 0 : 100));
    const page = resources.slice(start - 1, start - 1 + count);
    return { status: 200, body: { schemas: [LIST], totalResults: resources.length, startIndex: start, itemsPerPage: page.length, Resources: page } };
  }
  /** `attribute eq "value"`: the one filter provisioning clients rely on. Anything else is refused, not ignored. */
  private filter(query: URLSearchParams, allowed: readonly string[]): { attribute: string; value: string } | null {
    const raw = query.get('filter');
    if (!raw) return null;
    const match = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
    const attribute = match?.[1]?.toLowerCase();
    if (!match || !attribute || !allowed.includes(attribute)) throw bad('不支持这个筛选条件', 'invalidFilter');
    return { attribute, value: match[2]!.replace(/\\(.)/g, '$1') };
  }

  // ---- input -----------------------------------------------------------------------------------------------------
  private userFields(body: Json): { email?: string; name?: string; active?: boolean; externalId?: string | null } {
    const name = object(body.name);
    const emails = Array.isArray(body.emails) ? body.emails.map(object) : [];
    const primary = emails.find(item => item.primary === true) ?? emails[0];
    const userName = text(body.userName);
    const email = userName && EMAIL.test(userName) ? userName : text(primary?.value);
    const full = text(body.displayName) ?? text(name.formatted) ?? text([text(name.givenName), text(name.familyName)].filter(Boolean).join(' '));
    const active = flag(body.active);
    return {
      ...(email !== undefined ? { email } : {}),
      ...(full !== undefined ? { name: full.slice(0, 80) } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(body.externalId !== undefined ? { externalId: text(body.externalId)?.slice(0, 200) ?? null } : {}),
    };
  }
  private checkedEmail(email: string | undefined): string {
    if (!email || !EMAIL.test(email) || email.length > 200) throw bad('userName 必须是邮箱地址');
    return email;
  }
  private memberIds(value: unknown): string[] {
    const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return items.map(item => text(object(item).value)).filter((id): id is string => id !== undefined);
  }
  private operations(body: Json): Array<{ op: string; path: string | undefined; value: unknown }> {
    const schemas = Array.isArray(body.schemas) ? body.schemas : [];
    if (!schemas.includes(PATCH) || !Array.isArray(body.Operations)) throw bad('需要 PatchOp 请求', 'invalidSyntax');
    return body.Operations.map(object).map(item => {
      const op = String(item.op ?? '').toLowerCase();
      if (!['add', 'replace', 'remove'].includes(op)) throw bad('不支持的 PatchOp 操作', 'invalidSyntax');
      return { op, path: text(item.path), value: item.value };
    });
  }

  // ---- users -----------------------------------------------------------------------------------------------------
  private patchUser(id: string, body: Json): OrgMember {
    let fields: Json = {};
    for (const { op, path, value } of this.operations(body)) {
      if (!path) { fields = { ...fields, ...object(value) }; continue; }
      const key = path.toLowerCase();
      const next = op === 'remove' ? null : value;
      if (key === 'active') fields.active = next;
      else if (key === 'username') fields.userName = next;
      else if (key === 'displayname' || key === 'name.formatted') fields.displayName = next;
      else if (key === 'externalid') fields.externalId = next;
      else if (key === 'name.givenname' || key === 'name.familyname')
        fields.name = { ...object(fields.name), [key === 'name.givenname' ? 'givenName' : 'familyName']: next };
      else if (key === 'name') fields.name = { ...object(fields.name), ...object(next) };
      else if (key.startsWith('emails')) fields.emails = [{ value: Array.isArray(next) ? object(next[0]).value : next, primary: true }];
      // An attribute this server does not keep (title, phone numbers…) is accepted and dropped.
    }
    const patch = this.userFields(fields);
    if (patch.email !== undefined) this.checkedEmail(patch.email);
    return this.service.scimUpdateUser(id, patch);
  }
  private users(method: string, id: string | undefined, query: URLSearchParams, body: Json): ScimResult {
    if (!id) {
      if (method === 'GET') {
        const filter = this.filter(query, ['username', 'externalid', 'emails.value']);
        const value = filter?.value.toLowerCase();
        const found = this.service.scimUsers().filter(member => !filter
          || (filter.attribute === 'externalid' ? member.externalId === filter.value : member.email.toLowerCase() === value));
        return this.list(found.map(member => this.user(member)), query);
      }
      if (method === 'POST') {
        const fields = this.userFields(body);
        const email = this.checkedEmail(fields.email);
        const created = this.service.scimCreateUser({
          email, name: fields.name ?? email.slice(0, email.lastIndexOf('@')), active: fields.active ?? true, externalId: fields.externalId ?? null,
        });
        return { status: 201, body: this.user(created), location: `${this.base}/Users/${created.id}` };
      }
      throw new OrgError(405, 'ORG_METHOD_NOT_ALLOWED', '不支持这个请求方法');
    }
    if (method === 'GET') return { status: 200, body: this.user(this.service.scimUser(id)) };
    if (method === 'PUT') {
      const fields = this.userFields(body);
      return { status: 200, body: this.user(this.service.scimUpdateUser(id, { ...fields, email: this.checkedEmail(fields.email), active: fields.active ?? true })) };
    }
    if (method === 'PATCH') return { status: 200, body: this.user(this.patchUser(id, body)) };
    if (method === 'DELETE') { this.service.scimDeleteUser(id); return { status: 204 }; }
    throw new OrgError(405, 'ORG_METHOD_NOT_ALLOWED', '不支持这个请求方法');
  }

  // ---- groups ----------------------------------------------------------------------------------------------------
  private patchGroup(id: string, body: Json): GroupView {
    const current = this.service.scimGroup(id);
    let name: string | undefined;
    let members = new Set(current.memberIds);
    let touched = false;
    for (const { op, path, value } of this.operations(body)) {
      const key = path?.toLowerCase();
      if (!key) {
        const fields = object(value);
        if (text(fields.displayName)) name = text(fields.displayName);
        if (fields.members !== undefined) {
          touched = true;
          if (op === 'replace') members = new Set(this.memberIds(fields.members));
          else for (const member of this.memberIds(fields.members)) members.add(member);
        }
      } else if (key === 'displayname') {
        name = text(value);
      } else if (key === 'members') {
        touched = true;
        if (op === 'replace') members = new Set(this.memberIds(value));
        else if (op === 'add') for (const member of this.memberIds(value)) members.add(member);
        else if (value === undefined) members.clear();
        else for (const member of this.memberIds(value)) members.delete(member);
      } else {
        const one = /^members\[value eq "([^"]+)"\]$/i.exec(path!);
        if (!one || op !== 'remove') throw bad('不支持的 PatchOp 路径', 'invalidPath');
        touched = true;
        members.delete(one[1]!);
      }
    }
    return this.service.scimUpdateGroup(id, { ...(name !== undefined ? { name: name.slice(0, 80) } : {}), ...(touched ? { memberIds: [...members] } : {}) });
  }
  private groups(method: string, id: string | undefined, query: URLSearchParams, body: Json): ScimResult {
    const names = this.names();
    if (!id) {
      if (method === 'GET') {
        const filter = this.filter(query, ['displayname']);
        return this.list(this.service.scimGroups().filter(group => !filter || group.name === filter.value).map(group => this.group(group, names)), query);
      }
      if (method === 'POST') {
        const name = text(body.displayName);
        if (!name) throw bad('displayName 不能为空');
        const created = this.service.scimCreateGroup({ name: name.slice(0, 80), memberIds: this.memberIds(body.members) });
        return { status: 201, body: this.group(created, this.names()), location: `${this.base}/Groups/${created.id}` };
      }
      throw new OrgError(405, 'ORG_METHOD_NOT_ALLOWED', '不支持这个请求方法');
    }
    if (method === 'GET') return { status: 200, body: this.group(this.service.scimGroup(id), names) };
    if (method === 'PUT') {
      const name = text(body.displayName);
      if (!name) throw bad('displayName 不能为空');
      return { status: 200, body: this.group(this.service.scimUpdateGroup(id, { name: name.slice(0, 80), memberIds: this.memberIds(body.members) }), this.names()) };
    }
    if (method === 'PATCH') return { status: 200, body: this.group(this.patchGroup(id, body), this.names()) };
    if (method === 'DELETE') { this.service.scimDeleteGroup(id); return { status: 204 }; }
    throw new OrgError(405, 'ORG_METHOD_NOT_ALLOWED', '不支持这个请求方法');
  }

  /** `path` is what follows `/scim/v2`. */
  handle(method: string, path: string, query: URLSearchParams, body: unknown): ScimResult {
    const [, resource, id, extra] = path.split('/');
    if (extra !== undefined) throw new OrgError(404, 'ORG_NOT_FOUND', '没有这个接口');
    if (resource === 'Users') return this.users(method, id, query, object(body));
    if (resource === 'Groups') return this.groups(method, id, query, object(body));
    if (method !== 'GET' || id !== undefined) throw new OrgError(404, 'ORG_NOT_FOUND', '没有这个接口');
    if (resource === 'ServiceProviderConfig') return { status: 200, body: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: '在组织服务器控制台生成的 SCIM 令牌', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${this.base}/ServiceProviderConfig` },
    } };
    if (resource === 'ResourceTypes') return { status: 200, body: { schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER },
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
    ] } };
    if (resource === 'Schemas') return { status: 200, body: { schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
      { id: USER, name: 'User', attributes: ['userName', 'displayName', 'name.formatted', 'emails', 'active', 'externalId'].map(name => ({ name })) },
      { id: GROUP, name: 'Group', attributes: ['displayName', 'members'].map(name => ({ name })) },
    ] } };
    throw new OrgError(404, 'ORG_NOT_FOUND', '没有这个接口');
  }
}
