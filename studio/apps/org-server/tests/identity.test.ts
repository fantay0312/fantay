import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrgPlan } from '@open-design/contracts/org';
import { createOrgServer } from '../src/server.js';

const dirs: string[] = [];
const open: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const item of open.splice(0)) item.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ISSUER = 'https://idp.test';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An OpenID provider in memory: discovery, keys and the token endpoint, with knobs to misbehave. */
function provider() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const state = {
    person: { sub: 'idp-1', email: 'mia@acme.test', name: 'Mia', email_verified: true as boolean },
    nonce: '', challenge: '', alg: 'RS256', audience: 'fantay' as string | string[], tamper: false, calls: 0,
  };
  const idToken = () => {
    const head = b64({ alg: state.alg, kid: 'k1', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const body = b64({ iss: ISSUER, aud: state.audience, exp: now + 300, iat: now, nonce: state.nonce, ...state.person });
    const signature = state.alg === 'none' ? '' : sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${state.tamper ? b64({ iss: ISSUER, aud: 'fantay', exp: now + 300, nonce: state.nonce, sub: 'idp-9', email: 'owner@acme.test' }) : body}.${signature}`;
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    state.calls += 1;
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return reply({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
    if (url === `${ISSUER}/keys`) return reply({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body));
      const proves = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === state.challenge;
      if (form.get('client_secret') !== 's3cret' || form.get('code') !== 'the-code' || !proves) return reply({ error: 'invalid_grant' }, 400);
      return reply({ access_token: 'unused', id_token: idToken() });
    }
    return reply({ error: 'not_found' }, 404);
  }) as typeof fetch;
  return { state, fetcher };
}

async function server(plan: OrgPlan = 'enterprise') {
  const dir = await mkdtemp(path.join(tmpdir(), 'fantay-org-'));
  dirs.push(dir);
  const idp = provider();
  const app = createOrgServer({ dataDir: dir, publicUrl: 'https://org.acme.test', fetch: idp.fetcher });
  open.push(app);
  const created = app.service.init({ id: 'acme', name: 'Acme', plan, owner: { name: 'Olivia', email: 'olivia@acme.test' } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (token: string | null, method: string, route: string, body?: unknown, type = 'application/json') => {
    const response = await fetch(`${base}${route}`, {
      method, redirect: 'manual',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': type }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location') ?? '', body: text ? JSON.parse(text) as any : null };
  };
  /** One sign-in through the provider; returns where the browser lands. */
  const signIn = async () => {
    const start = await call(null, 'GET', '/v1/sso/start');
    const authorize = new URL(start.location);
    idp.state.nonce = authorize.searchParams.get('nonce') ?? '';
    idp.state.challenge = authorize.searchParams.get('code_challenge') ?? '';
    const landed = await call(null, 'GET', `/v1/sso/callback?code=the-code&state=${authorize.searchParams.get('state')}`);
    return { authorize, hash: landed.location };
  };
  return { app, base, call, signIn, idp, owner: created.token.token, ownerId: created.owner.id };
}
const SSO = { enabled: true, issuer: ISSUER, clientId: 'fantay', clientSecret: 's3cret', allowedDomains: ['acme.test'], autoProvision: true, defaultRole: 'member' };

describe('single sign-on', () => {
  it('signs a member in through the provider and opens a console session, not a new access token', async () => {
    const { call, signIn, owner, idp } = await server('team');
    expect((await call(null, 'GET', '/v1/public')).body).toEqual({ initialized: true, name: 'Acme', sso: false });
    const saved = await call(owner, 'PUT', '/v1/sso', SSO);
    expect(saved.body).toMatchObject({ enabled: true, hasClientSecret: true, redirectUri: 'https://org.acme.test/v1/sso/callback' });
    expect(JSON.stringify(saved.body)).not.toContain('s3cret');
    expect((await call(null, 'GET', '/v1/public')).body.sso).toBe(true);
    const mia = await call(owner, 'POST', '/v1/members', { name: 'Mia', email: 'mia@acme.test', role: 'admin' });
    const { authorize, hash } = await signIn();
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'fantay', redirect_uri: 'https://org.acme.test/v1/sso/callback', code_challenge_method: 'S256',
    });
    expect(hash).toMatch(/^\/#session=fss_[A-Za-z0-9_-]{43}$/);
    const session = hash.slice('/#session='.length);
    const me = await call(session, 'GET', '/v1/me');
    // The provider says who; the role is the one the organization gave.
    expect(me.body).toMatchObject({ auth: 'session', member: { email: 'mia@acme.test', role: 'admin' } });
    // Signing in did not rotate the member's access token (the one a desktop holds).
    expect((await call(mia.body.token.token, 'GET', '/v1/me')).body.auth).toBe('token');
    const listed = (await call(owner, 'GET', '/v1/members')).body.find((item: { id: string }) => item.id === mia.body.member.id);
    expect(listed).toMatchObject({ ssoSubject: 'idp-1', grantVersion: mia.body.member.grantVersion });
    expect((await call(session, 'POST', '/v1/logout')).status).toBe(200);
    expect((await call(session, 'GET', '/v1/me')).status).toBe(401);
    // The discovery document and the keys were fetched once and reused.
    const before = idp.state.calls;
    await signIn();
    expect(idp.state.calls - before).toBe(1);
  });

  it('provisions on first sign-in only when allowed, within the allowed domains', async () => {
    const { call, signIn, owner, idp } = await server();
    await call(owner, 'PUT', '/v1/sso', { ...SSO, autoProvision: false });
    idp.state.person = { sub: 'idp-2', email: 'new@acme.test', name: 'New Person', email_verified: true };
    expect((await signIn()).hash).toBe('/#sso_error=ORG_SSO_NOT_MEMBER');
    await call(owner, 'PUT', '/v1/sso', { ...SSO, clientSecret: undefined, defaultRole: 'viewer' });
    const session = (await signIn()).hash.slice('/#session='.length);
    expect((await call(session, 'GET', '/v1/me')).body).toMatchObject({ member: { name: 'New Person', role: 'viewer' }, permissions: ['library.read'] });
    idp.state.person = { sub: 'idp-3', email: 'eve@other.test', name: 'Eve', email_verified: true };
    expect((await signIn()).hash).toBe('/#sso_error=ORG_SSO_DOMAIN');
    idp.state.person = { sub: 'idp-4', email: 'unverified@acme.test', name: 'U', email_verified: false };
    expect((await signIn()).hash).toBe('/#sso_error=ORG_SSO_REJECTED');
    // A suspended member does not get in, whatever the provider says.
    const members = (await call(owner, 'GET', '/v1/members')).body as Array<{ id: string; email: string; revision: number }>;
    const added = members.find(item => item.email === 'new@acme.test')!;
    await call(owner, 'PATCH', `/v1/members/${added.id}`, { status: 'suspended', revision: added.revision });
    idp.state.person = { sub: 'idp-2', email: 'new@acme.test', name: 'New Person', email_verified: true };
    expect((await signIn()).hash).toBe('/#sso_error=ORG_SSO_SUSPENDED');
    expect((await call(session, 'GET', '/v1/me')).status).toBe(401);
  });

  it('rejects tokens it cannot trust', async () => {
    const { call, signIn, owner, idp } = await server();
    await call(owner, 'POST', '/v1/members', { name: 'Mia', email: 'mia@acme.test' });
    await call(owner, 'PUT', '/v1/sso', SSO);
    const rejected = async () => expect((await signIn()).hash).toBe('/#sso_error=ORG_SSO_REJECTED');
    idp.state.alg = 'none';
    await rejected();
    idp.state.alg = 'HS256';
    await rejected();
    idp.state.alg = 'RS256';
    idp.state.tamper = true;
    await rejected();
    idp.state.tamper = false;
    idp.state.audience = 'someone-else';
    await rejected();
    idp.state.audience = 'fantay';
    // A token minted for another attempt (wrong nonce), and a state used twice.
    const start = await call(null, 'GET', '/v1/sso/start');
    const authorize = new URL(start.location);
    idp.state.nonce = 'stale';
    idp.state.challenge = authorize.searchParams.get('code_challenge') ?? '';
    const state = authorize.searchParams.get('state');
    expect((await call(null, 'GET', `/v1/sso/callback?code=the-code&state=${state}`)).location).toBe('/#sso_error=ORG_SSO_REJECTED');
    expect((await call(null, 'GET', `/v1/sso/callback?code=the-code&state=${state}`)).location).toBe('/#sso_error=ORG_SSO_REJECTED');
    expect((await signIn()).hash).toMatch(/^\/#session=/);
    // Only the owner configures SSO, and a plain http issuer is refused.
    const mia = (await call(owner, 'POST', '/v1/members', { name: 'Max', email: 'max@acme.test', role: 'admin' })).body.token.token;
    expect((await call(mia, 'PUT', '/v1/sso', SSO)).status).toBe(403);
    expect((await call(mia, 'GET', '/v1/sso')).status).toBe(403);
    expect((await call(owner, 'PUT', '/v1/sso', { ...SSO, issuer: 'http://idp.test' })).status).toBe(400);
  });
});

describe('SCIM provisioning', () => {
  const SCIM = 'application/scim+json';
  it('is an enterprise feature with its own token', async () => {
    const team = await server('team');
    expect((await team.call(team.owner, 'POST', '/v1/scim/token')).body.error.code).toBe('ORG_PLAN_REQUIRED');
    const { call, owner } = await server();
    expect((await call(owner, 'GET', '/v1/scim')).body).toMatchObject({ enabled: false, baseUrl: 'https://org.acme.test/scim/v2' });
    const token: string = (await call(owner, 'POST', '/v1/scim/token')).body.token;
    expect(token).toMatch(/^fsc_/);
    expect((await call(owner, 'GET', '/v1/scim')).body.enabled).toBe(true);
    // Each token opens its own door only.
    expect((await call(owner, 'GET', '/scim/v2/Users')).status).toBe(401);
    expect((await call(token, 'GET', '/v1/me')).status).toBe(401);
    expect((await call(null, 'GET', '/scim/v2/Users')).status).toBe(401);
    expect((await call(token, 'GET', '/scim/v2/ServiceProviderConfig')).body.patch.supported).toBe(true);
    await call(owner, 'DELETE', '/v1/scim/token');
    expect((await call(token, 'GET', '/scim/v2/Users')).status).toBe(401);
  });

  it('creates, updates, suspends and removes members without ever touching roles or the primary owner', async () => {
    const { call, owner, ownerId } = await server();
    const token: string = (await call(owner, 'POST', '/v1/scim/token')).body.token;
    const created = await call(token, 'POST', '/scim/v2/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'mia@acme.test', externalId: 'ext-1',
      name: { givenName: 'Mia', familyName: 'Chen' }, active: true, roles: [{ value: 'owner' }],
    }, SCIM);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userName: 'mia@acme.test', displayName: 'Mia Chen', active: true, externalId: 'ext-1' });
    expect(created.location).toBe(`https://org.acme.test/scim/v2/Users/${created.body.id}`);
    const duplicate = await call(token, 'POST', '/scim/v2/Users', { userName: 'mia@acme.test' }, SCIM);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ scimType: 'uniqueness', status: '409' });
    const found = await call(token, 'GET', `/scim/v2/Users?filter=${encodeURIComponent('userName eq "MIA@acme.test"')}`);
    expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id: created.body.id }] });
    expect((await call(token, 'GET', `/scim/v2/Users?filter=${encodeURIComponent('title co "x"')}`)).body.scimType).toBe('invalidFilter');
    const member = () => call(owner, 'GET', '/v1/members').then(result => result.body.find((item: { id: string }) => item.id === created.body.id));
    const before = await member();
    expect(before).toMatchObject({ role: 'member', hasToken: false, externalId: 'ext-1' });
    // Azure AD style: a string boolean, and no path.
    const suspended = await call(token, 'PATCH', `/scim/v2/Users/${created.body.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    }, SCIM);
    expect(suspended.body.active).toBe(false);
    const after = await member();
    expect(after.status).toBe('suspended');
    expect(after.grantVersion).toBeGreaterThan(before.grantVersion);
    const renamed = await call(token, 'PATCH', `/scim/v2/Users/${created.body.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: true, displayName: 'Mia C.' } }],
    }, SCIM);
    expect(renamed.body).toMatchObject({ active: true, displayName: 'Mia C.' });
    expect((await member()).role).toBe('member');
    // The primary owner is out of the provider's reach.
    expect((await call(token, 'DELETE', `/scim/v2/Users/${ownerId}`)).status).toBe(403);
    expect((await call(token, 'PATCH', `/scim/v2/Users/${ownerId}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }],
    }, SCIM)).status).toBe(403);
    expect((await call(token, 'DELETE', `/scim/v2/Users/${created.body.id}`)).status).toBe(204);
    expect((await call(token, 'GET', `/scim/v2/Users/${created.body.id}`)).status).toBe(404);
    const audit = (await call(owner, 'GET', '/v1/audit')).body.items.map((item: { action: string; actorId: string }) => `${item.actorId}:${item.action}`);
    expect(audit).toEqual(expect.arrayContaining(['scim:member.provisioned.scim', 'scim:member.removed.scim']));
  });

  it('keeps groups in step with the provider', async () => {
    const { call, owner } = await server();
    const token: string = (await call(owner, 'POST', '/v1/scim/token')).body.token;
    const user = async (email: string) => (await call(token, 'POST', '/scim/v2/Users', { userName: email }, SCIM)).body.id as string;
    const mia = await user('mia@acme.test'), max = await user('max@acme.test');
    const group = await call(token, 'POST', '/scim/v2/Groups', { displayName: '客服组', members: [{ value: mia }] }, SCIM);
    expect(group.status).toBe(201);
    expect(group.body.members.map((item: { value: string }) => item.value)).toEqual([mia]);
    const patch = (Operations: unknown[]) => call(token, 'PATCH', `/scim/v2/Groups/${group.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations }, SCIM);
    expect((await patch([{ op: 'add', path: 'members', value: [{ value: max }] }])).body.members).toHaveLength(2);
    expect((await patch([{ op: 'remove', path: `members[value eq "${mia}"]` }])).body.members.map((item: { value: string }) => item.value)).toEqual([max]);
    expect((await patch([{ op: 'replace', path: 'displayName', value: '客服二组' }])).body.displayName).toBe('客服二组');
    const members = (await call(owner, 'GET', '/v1/members')).body as Array<{ id: string; groupIds: string[] }>;
    expect(members.find(item => item.id === max)!.groupIds).toEqual([group.body.id]);
    expect(members.find(item => item.id === mia)!.groupIds).toEqual([]);
    expect((await call(token, 'GET', `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "客服二组"')}`)).body.totalResults).toBe(1);
    expect((await call(token, 'DELETE', `/scim/v2/Groups/${group.body.id}`)).status).toBe(204);
    expect((await call(owner, 'GET', '/v1/groups')).body).toEqual([]);
  });
});

describe('admin console', () => {
  it('serves its own files with a strict content security policy and nothing else from the folder', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fantay-org-console-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>console</title>');
    await writeFile(path.join(dir, 'app.js'), 'export {};');
    await writeFile(path.join(dir, 'secret.txt'), 'not a console file');
    const data = await mkdtemp(path.join(tmpdir(), 'fantay-org-'));
    dirs.push(data);
    const app = createOrgServer({ dataDir: data, consoleDir: dir });
    open.push(app);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(home.headers.get('x-frame-options')).toBe('DENY');
    expect((await fetch(`${base}/console/app.js`)).headers.get('content-type')).toContain('text/javascript');
    // Anything that is not a console file falls through to the API, which wants a token.
    for (const name of ['secret.txt', '..%2Findex.html', 'missing.js'])
      expect((await fetch(`${base}/console/${name}`)).status, name).toBe(401);
    // Before the organization exists the sign-in page can say so.
    expect(await (await fetch(`${base}/v1/public`)).json()).toEqual({ initialized: false, name: null, sso: false });
  });
});

describe('controller sync', () => {
  it('gives a controller every published item with its audience, and each member only their own', async () => {
    const { app, call, owner } = await server();
    const group = (await call(owner, 'POST', '/v1/groups', { name: '客服组' })).body;
    const publish = async (name: string, audience?: unknown) => {
      const item = (await call(owner, 'POST', '/v1/library', { kind: 'character', name, document: { name }, ...(audience ? { audience } : {}) })).body;
      return (await call(owner, 'POST', `/v1/library/${item.id}/publish`, { revision: item.revision })).body;
    };
    await publish('小月');
    await publish('客服手册', { kind: 'groups', groupIds: [group.id] });
    await call(owner, 'POST', '/v1/library', { kind: 'character', name: '草稿', document: {} });
    const mia = (await call(owner, 'POST', '/v1/members', { name: 'Mia', email: 'mia@acme.test', groupIds: [group.id] })).body;
    const max = (await call(owner, 'POST', '/v1/members', { name: 'Max', email: 'max@acme.test' })).body;
    expect((await call(max.token.token, 'GET', '/v1/sync/library')).body.items.map((item: { name: string }) => item.name)).toEqual(['小月']);
    const directoryOnly = (await call(owner, 'POST', '/v1/service-tokens', { label: 'a', scopes: ['directory.sync'] })).body.token.token;
    expect((await call(directoryOnly, 'GET', '/v1/sync/library')).status).toBe(403);
    const controller = (await call(owner, 'POST', '/v1/service-tokens', { label: 'b', scopes: ['directory.sync', 'library.sync'] })).body.token.token;
    const library = (await call(controller, 'GET', '/v1/sync/library')).body;
    expect(library.items.map((item: { name: string; audience: unknown }) => [item.name, item.audience])).toEqual([
      ['小月', { kind: 'everyone' }], ['客服手册', { kind: 'groups', groupIds: [group.id] }],
    ]);
    const directory = (await call(controller, 'GET', '/v1/sync/directory')).body;
    expect(directory.members.find((item: { id: string }) => item.id === mia.member.id).groups).toEqual([group.id]);
    expect(app.service.publicInfo().initialized).toBe(true);
  });
});
