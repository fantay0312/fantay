/**
 * A loopback stand-in for the whole TokenToSea cloud, served from one origin
 * under the daemon's `OD_TOKENTOSEA_TEST_ORIGIN` mapping:
 *
 *   <origin>/api/oauth/*        OAuth issuer: authorize, token (authorization_code
 *                               and refresh_token), userinfo, jwks, revoke.
 *                               id_tokens are RS256-signed with a per-cloud key.
 *   <origin>/api/v1/connect/*   connect services: models, wallet, grant,
 *                               fantay/identity, official/runs, chat/completions.
 *   <origin>/design/api/*       the real design/collaboration service: an
 *                               in-process `apps/share` `createShareServer`,
 *                               reached through a proxy hop that strips `/design`.
 *   <origin>/{s,content,artifact}/...  public share viewer paths, forwarded unchanged.
 *
 * Members are named test accounts with distinct tokens; every user id is
 * `<origin>/api/oauth|<sub>`, which is what the daemon's identity mints under
 * the seam. Every request is recorded (`requests()`), and `env()` loads the
 * egress guard (`./tokentosea-egress-guard.ts`) so a production TokenToSea host
 * is refused and recorded if any code path reaches for it.
 *
 * Lifecycle: create one cloud per test (or file), point one or more daemons at
 * it through `suite.with.tokenToSea(cloud, member, run)` from `@/vitest/suite`,
 * and `close()` it at the end. This module owns no tools-dev lifecycle.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';

import { createShareServer } from '../../../apps/share/src/server.ts';
import { HttpError, type User } from '../../../apps/share/src/types.ts';
import { e2eWorkspaceRoot } from '../tools-dev/runtime.ts';

/** The daemon env var that points every TokenToSea endpoint at a loopback origin. */
export const TOKENTOSEA_TEST_ORIGIN_ENV = 'OD_TOKENTOSEA_TEST_ORIGIN';
/** The daemon's raw TokenToSea session cookie (43 base64url chars). */
export const TOKENTOSEA_SESSION_COOKIE = 'fantay_session';
/** The OAuth client the daemon persists and `fantay/identity` must report. */
export const TOKENTOSEA_CLIENT_ID = 'fantay-design';
export const EGRESS_LOG_ENV = 'OD_E2E_EGRESS_LOG';
export const EGRESS_DENY_ENV = 'OD_E2E_EGRESS_DENY';

const HARNESS_HEADER = 'x-e2e-tokentosea-harness';
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const AUTHORIZATION_CODE_TTL_MS = 60_000;
/** apps/share answers 429 above two concurrent collaboration requests; queue instead of flaking. */
const COLLABORATION_CONCURRENCY = 2;
const guardModuleUrl = new URL('./tokentosea-egress-guard.ts', import.meta.url).href;

export type TokenToSeaCloudWallet = { balanceUsd: string; availableUsd: string };
export type TokenToSeaCloudGrant = { perCallUsd: string | null; remainingUsd: string | null };

export type TokenToSeaCloudMemberInput =
  | string
  | {
    name: string;
    displayName?: string;
    email?: string;
    sub?: string;
    wallet?: Partial<TokenToSeaCloudWallet>;
    grant?: Partial<TokenToSeaCloudGrant>;
  };

/** A named account. `wallet` and `grant` are live: mutate them to change what connect returns. */
export type TokenToSeaCloudMember = {
  readonly name: string;
  readonly sub: string;
  /** `<issuer>|<sub>`: the id the daemon, apps/share and collaboration rows all use. */
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  wallet: TokenToSeaCloudWallet;
  grant: TokenToSeaCloudGrant;
};

export type TokenToSeaCloudArea = 'oauth' | 'connect' | 'design' | 'share' | 'unknown';

export type TokenToSeaCloudRequest = {
  seq: number;
  at: string;
  method: string;
  /** Path as received, including `/design` and without the query. */
  path: string;
  area: TokenToSeaCloudArea;
  /** Path below the area base, e.g. `wallet`, `token`, `collaboration`. */
  resource: string;
  /** Member name resolved from the bearer token, code or refresh token; null when anonymous. */
  member: string | null;
  /** HTTP status sent back (0 while the response is still open). */
  status: number;
  /** `operation` of a design `collaboration` request. */
  operation?: string;
  workspaceId?: string;
  handledBy: 'default' | 'override' | 'share' | 'unhandled';
  /** True for calls the harness itself made (`collaboration()`, seeding helpers). */
  fromHarness: boolean;
};

export type TokenToSeaCloudRequestFilter = Partial<
  Pick<TokenToSeaCloudRequest, 'area' | 'member' | 'method' | 'operation' | 'resource' | 'fromHarness' | 'handledBy'>
>;

export type TokenToSeaCloudReply = {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

export type TokenToSeaCloudHandlerInput = {
  member: TokenToSeaCloudMember | null;
  method: string;
  resource: string;
  query: URLSearchParams;
  /** Parsed JSON or form body; raw text otherwise; undefined when empty. */
  body: unknown;
  headers: IncomingHttpHeaders;
};

/** Return a reply to answer the request, or undefined to fall through to the default behavior. */
export type TokenToSeaCloudHandler = (
  input: TokenToSeaCloudHandlerInput,
) => TokenToSeaCloudReply | undefined | Promise<TokenToSeaCloudReply | undefined>;

export type TokenToSeaTokenGrant = { accessToken: string; refreshToken: string | null; expiresAt: number };

export type TokenToSeaSeedOptions = {
  /** Access-token lifetime written to the session. Below 30s the daemon refreshes on first use. Default 1h. */
  accessTokenTtlMs?: number;
  /** Absolute session lifetime (`validUntil`). Default 30 days, as the daemon writes it. */
  sessionTtlMs?: number;
  /** Raw cookie to use; must be 43 base64url characters. Default: random. */
  cookie?: string;
  /** Persist a refresh token (default true). Without one, an expired session simply ends. */
  refreshToken?: boolean;
};

export type TokenToSeaSeededSession = {
  member: TokenToSeaCloudMember;
  /** The raw `fantay_session` value. */
  cookie: string;
  /** `fantay_session=<cookie>`. */
  cookieHeader: string;
  headers: { cookie: string };
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  validUntil: number;
  /** The identity file that was written. */
  file: string;
};

export type TokenToSeaEgressRecord = {
  at: string;
  /** `loaded` marks a process that loaded the guard; it is not an egress attempt. */
  via: 'fetch' | 'dns' | 'socket' | 'loaded';
  host: string;
  url?: string;
  blocked: boolean;
  /** `daemon`/`web`: the tools-dev sidecar processes; `other`: tools-dev, builds, agent CLIs and other descendants. */
  role: 'daemon' | 'web' | 'other';
  pid: number;
  argv: string[];
};

export type TokenToSeaCloudEgress = {
  /** Whether `env()` loads the guard (`egressGuard` option). */
  enabled: boolean;
  /** JSONL file the guard appends to. */
  logPath: string;
  read: () => Promise<TokenToSeaEgressRecord[]>;
  /** Processes that loaded the guard, optionally for one role; proves the other checks are not vacuous. */
  loaded: (role?: TokenToSeaEgressRecord['role']) => Promise<TokenToSeaEgressRecord[]>;
  /** Attempts the guard refused (production TokenToSea hosts by default). */
  blocked: () => Promise<TokenToSeaEgressRecord[]>;
  /** Non-loopback attempts that were allowed through, optionally for one process role. */
  external: (role?: TokenToSeaEgressRecord['role']) => Promise<TokenToSeaEgressRecord[]>;
};

/** The collaboration view apps/share returns for `workspace.get` / `workspace.create`. */
export type TokenToSeaWorkspaceView = {
  workspaceId: string;
  workspaceName: string;
  workspaceType: 'personal' | 'team';
  workspaceMemberId: string;
  role: 'owner' | 'admin' | 'member';
  [key: string]: unknown;
};

export type TokenToSeaPublishedTeamProject = {
  project: Record<string, unknown>;
  resourceId: string;
  versionId: string;
  version: number;
};

export type TokenToSeaCloudOptions = {
  members?: TokenToSeaCloudMemberInput[];
  /** Cloud state root (sqlite, blobs, egress log). Default: a fresh dir under `.tmp/e2e`, removed on close. */
  dataDir?: string;
  /** Keep `dataDir` on close (default: remove it unless the caller supplied it). */
  keepData?: boolean;
  /** Catalog returned by `GET models`. Default: one agent-capable chat model, `e2e-chat`. */
  models?: Array<Record<string, unknown>>;
  /** Text the default `chat/completions` handler answers with. Default `ok`. */
  chatReply?: string;
  /** Load the egress guard into daemon processes (default true). */
  egressGuard?: boolean;
  /** Host suffixes the guard refuses. Default `['tokentosea.com']`. */
  egressDeny?: string[];
};

export type TokenToSeaCloud = {
  origin: string;
  issuer: string;
  endpoints: { issuer: string; connectBase: string; designBase: string };
  dataDir: string;
  /** The in-process apps/share instance (`{ server, store, collaboration, close }`). */
  share: ReturnType<typeof createShareServer>;
  egress: TokenToSeaCloudEgress;
  member: (name: string) => TokenToSeaCloudMember;
  addMember: (input: TokenToSeaCloudMemberInput) => TokenToSeaCloudMember;
  /** Daemon env for `suite.with.toolsDev({ env })`; `extra` wins, NODE_OPTIONS is composed. */
  env: (extra?: Record<string, string | undefined>) => Record<string, string | undefined>;
  issueTokens: (member: string, options?: { accessTokenTtlMs?: number; refreshToken?: boolean }) => TokenToSeaTokenGrant;
  /** Write a signed-in session into `<dataDir>/identity/tokentosea.json`. Call before the daemon starts. */
  seedSession: (dataDir: string, member: string, options?: TokenToSeaSeedOptions) => Promise<TokenToSeaSeededSession>;
  /** Revoke every client token of a member (harness tokens survive); refresh then answers invalid_grant. */
  revokeTokens: (member: string) => number;
  /** Decide who approves the next `GET authorize`; default is the first member. */
  queueLogin: (next: string | { deny: true }) => void;
  handle: (
    area: 'oauth' | 'connect' | 'design',
    method: string,
    resource: string,
    handler: TokenToSeaCloudHandler,
  ) => () => void;
  setModels: (models: Array<Record<string, unknown>>) => void;
  /** POST the design collaboration API as `member`; throws `{ status, body }` on a non-2xx. */
  collaboration: <T = unknown>(member: string, body: Record<string, unknown>) => Promise<T>;
  createTeamWorkspace: (owner: string, name: string) => Promise<TokenToSeaWorkspaceView>;
  /** Invite and accept through the cloud; returns the member's own view of the workspace. */
  addWorkspaceMember: (
    owner: string,
    workspaceId: string,
    member: string,
    role?: 'member' | 'admin',
  ) => Promise<TokenToSeaWorkspaceView>;
  workspace: (member: string, workspaceId: string) => Promise<TokenToSeaWorkspaceView>;
  /** Upsert a project, push one published version of `files` and return the catalog row. */
  publishTeamProject: (
    owner: string,
    input: {
      workspaceId: string;
      projectId: string;
      name?: string;
      files: Record<string, string | Buffer>;
      metadata?: Record<string, unknown>;
      visibility?: 'team' | 'private';
      resourceId?: string;
    },
  ) => Promise<TokenToSeaPublishedTeamProject>;
  /** Daemon workspace headers (`x-od-workspace-*`) for a view. */
  workspaceHeaders: (view: Pick<TokenToSeaWorkspaceView, 'workspaceId' | 'workspaceMemberId' | 'workspaceType' | 'role'>) => Record<string, string>;
  requests: (filter?: TokenToSeaCloudRequestFilter) => TokenToSeaCloudRequest[];
  close: () => Promise<void>;
};

type TokenRecord = {
  member: string;
  kind: 'access' | 'refresh';
  expiresAt: number;
  revoked: boolean;
  clientId: string;
  harness: boolean;
};

type CodeRecord = {
  member: string;
  clientId: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  expiresAt: number;
};

const defaultModels = (): Array<Record<string, unknown>> => [{
  id: 'e2e-chat',
  model: 'e2e/chat',
  name: 'E2E Chat',
  provider: 'e2e',
  priceVersion: 1,
  billingMode: 'token',
  toolCalling: true,
  available: true,
  maxOutputTokens: 4096,
}];

const sessionDigest = (value: string) => createHash('sha256').update(value).digest('base64url');
const sha256Hex = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const token = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

export async function startTokenToSeaCloud(options: TokenToSeaCloudOptions = {}): Promise<TokenToSeaCloud> {
  const ownsDataDir = options.dataDir == null;
  const dataDir = options.dataDir
    ?? join(e2eWorkspaceRoot(), '.tmp', 'e2e', `tokentosea-cloud-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(dataDir, { recursive: true });
  const egressLog = join(dataDir, 'egress.jsonl');
  await writeFile(egressLog, '');
  const egressDeny = options.egressDeny ?? ['tokentosea.com'];

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `e2e-${randomUUID().slice(0, 8)}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  const members = new Map<string, TokenToSeaCloudMember>();
  const tokens = new Map<string, TokenRecord>();
  const harnessTokens = new Map<string, string>();
  const codes = new Map<string, CodeRecord>();
  const loginQueue: Array<string | { deny: true }> = [];
  const overrides = new Map<string, TokenToSeaCloudHandler[]>();
  const log: TokenToSeaCloudRequest[] = [];
  let models = options.models ?? defaultModels();
  let seq = 0;

  let activeCollaboration = 0;
  const collaborationWaiters: Array<() => void> = [];
  async function acquireCollaboration(): Promise<() => void> {
    if (activeCollaboration >= COLLABORATION_CONCURRENCY) {
      await new Promise<void>((resolve) => collaborationWaiters.push(resolve));
    }
    activeCollaboration += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeCollaboration -= 1;
      collaborationWaiters.shift()?.();
    };
  }

  // The origin is only known once the front server listens; apps/share needs it up front.
  const front = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'fake_cloud_error', message: errorMessage(error) });
      else res.end();
    });
  });
  await listen(front);
  const origin = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  const issuer = `${origin}/api/oauth`;
  const endpoints = { issuer, connectBase: `${origin}/api/v1/connect`, designBase: `${origin}/design/api` };

  const share = createShareServer({
    dataDir: join(dataDir, 'share'),
    publicDir: join(e2eWorkspaceRoot(), 'apps', 'share', 'public'),
    origin,
    secret: randomBytes(32).toString('base64url'),
    verifyToken: async (value: string): Promise<User> => {
      const member = memberForAccessToken(value);
      if (!member) throw new HttpError(401, 'TokenToSea 登录已失效，请重新登录');
      return { id: member.userId, name: member.displayName };
    },
  });
  await listen(share.server);
  const sharePort = (share.server.address() as AddressInfo).port;

  function addMember(input: TokenToSeaCloudMemberInput): TokenToSeaCloudMember {
    const spec = typeof input === 'string' ? { name: input } : input;
    if (!/^[\w-]{1,64}$/.test(spec.name)) throw new Error(`invalid fake TokenToSea member name: ${spec.name}`);
    if (members.has(spec.name)) throw new Error(`fake TokenToSea member already exists: ${spec.name}`);
    const sub = spec.sub ?? `sub-${spec.name}`;
    const member: TokenToSeaCloudMember = {
      name: spec.name,
      sub,
      userId: `${issuer}|${sub}`,
      displayName: spec.displayName ?? spec.name,
      email: spec.email ?? `${spec.name}@example.test`,
      wallet: { balanceUsd: '25.000000', availableUsd: '25.000000', ...spec.wallet },
      grant: { perCallUsd: null, remainingUsd: null, ...spec.grant },
    };
    members.set(member.name, member);
    return member;
  }
  for (const input of options.members ?? []) addMember(input);

  function requireMember(name: string): TokenToSeaCloudMember {
    const member = members.get(name);
    if (!member) throw new Error(`unknown fake TokenToSea member: ${name}`);
    return member;
  }

  function memberForAccessToken(value: string): TokenToSeaCloudMember | null {
    const record = tokens.get(value);
    if (!record || record.kind !== 'access' || record.revoked || record.expiresAt <= Date.now()) return null;
    return members.get(record.member) ?? null;
  }

  function issueTokens(
    name: string,
    issue: { accessTokenTtlMs?: number; refreshToken?: boolean; clientId?: string; harness?: boolean } = {},
  ): TokenToSeaTokenGrant {
    requireMember(name);
    const clientId = issue.clientId ?? TOKENTOSEA_CLIENT_ID;
    const expiresAt = Date.now() + (issue.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS);
    const accessToken = token('tts_at_');
    tokens.set(accessToken, { member: name, kind: 'access', expiresAt, revoked: false, clientId, harness: issue.harness === true });
    let refreshToken: string | null = null;
    if (issue.refreshToken !== false) {
      refreshToken = token('tts_rt_');
      tokens.set(refreshToken, { member: name, kind: 'refresh', expiresAt: Number.MAX_SAFE_INTEGER, revoked: false, clientId, harness: issue.harness === true });
    }
    return { accessToken, refreshToken, expiresAt };
  }

  function harnessToken(name: string): string {
    const existing = harnessTokens.get(name);
    if (existing && memberForAccessToken(existing)) return existing;
    const grant = issueTokens(name, { accessTokenTtlMs: 24 * 60 * 60_000, refreshToken: false, harness: true });
    harnessTokens.set(name, grant.accessToken);
    return grant.accessToken;
  }

  function idToken(member: TokenToSeaCloudMember, clientId: string, nonce: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iss: issuer, sub: member.sub, aud: clientId, nonce, iat: now, exp: now + 600 }));
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
    return `${header}.${claims}.${signature}`;
  }

  function tokenResponse(grant: TokenToSeaTokenGrant, extra: Record<string, unknown> = {}): TokenToSeaCloudReply {
    return {
      json: {
        access_token: grant.accessToken,
        ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
        token_type: 'Bearer',
        expires_in: Math.max(0, Math.round((grant.expiresAt - Date.now()) / 1000)),
        ...extra,
      },
    };
  }

  function oauthDefault(
    method: string,
    resource: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
    bearerMember: TokenToSeaCloudMember | null,
    record: TokenToSeaCloudRequest,
  ): TokenToSeaCloudReply | null {
    if (method === 'GET' && resource === 'jwks') return { json: { keys: [jwk] } };
    if (method === 'GET' && resource === 'authorize') {
      const redirectUri = query.get('redirect_uri') ?? '';
      const state = query.get('state') ?? '';
      const clientId = query.get('client_id') ?? '';
      const nonce = query.get('nonce') ?? '';
      const challenge = query.get('code_challenge') ?? '';
      if (query.get('response_type') !== 'code' || !redirectUri || !state || !clientId || !nonce || !challenge
        || query.get('code_challenge_method') !== 'S256') {
        return { status: 400, json: { error: 'invalid_request' } };
      }
      const location = new URL(redirectUri);
      const next = loginQueue.shift() ?? [...members.keys()][0];
      if (next == null || typeof next !== 'string') {
        location.search = new URLSearchParams({ error: 'access_denied', state, iss: issuer }).toString();
      } else {
        requireMember(next);
        record.member = next;
        const code = token('tts_code_');
        codes.set(code, { member: next, clientId, redirectUri, nonce, challenge, expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS });
        location.search = new URLSearchParams({ code, state, iss: issuer }).toString();
      }
      return { status: 302, headers: { location: location.href, 'cache-control': 'no-store' } };
    }
    if (method === 'POST' && resource === 'token') {
      const grantType = String(body.grant_type ?? '');
      if (grantType === 'authorization_code') {
        const code = codes.get(String(body.code ?? ''));
        codes.delete(String(body.code ?? ''));
        if (!code || code.expiresAt <= Date.now() || code.clientId !== body.client_id || code.redirectUri !== body.redirect_uri
          || sessionDigest(String(body.code_verifier ?? '')) !== code.challenge) {
          return { status: 400, json: { error: 'invalid_grant' } };
        }
        record.member = code.member;
        const member = requireMember(code.member);
        const grant = issueTokens(code.member, { clientId: code.clientId, accessTokenTtlMs: 15 * 60_000 });
        return tokenResponse(grant, { id_token: idToken(member, code.clientId, code.nonce), scope: 'openid profile email offline_access' });
      }
      if (grantType === 'refresh_token') {
        const presented = String(body.refresh_token ?? '');
        const refresh = tokens.get(presented);
        if (!refresh || refresh.kind !== 'refresh' || refresh.revoked || refresh.clientId !== body.client_id) {
          return { status: 400, json: { error: 'invalid_grant' } };
        }
        record.member = refresh.member;
        refresh.revoked = true;
        return tokenResponse(issueTokens(refresh.member, { clientId: refresh.clientId, accessTokenTtlMs: 15 * 60_000 }));
      }
      return { status: 400, json: { error: 'unsupported_grant_type' } };
    }
    if (method === 'GET' && resource === 'userinfo') {
      if (!bearerMember) return { status: 401, json: { error: 'invalid_token' } };
      return { json: { sub: bearerMember.sub, name: bearerMember.displayName, email: bearerMember.email } };
    }
    if (method === 'POST' && resource === 'revoke') {
      const presented = tokens.get(String(body.token ?? ''));
      if (presented) {
        presented.revoked = true;
        record.member = presented.member;
      }
      return { json: {} };
    }
    return null;
  }

  function connectDefault(
    method: string,
    resource: string,
    body: unknown,
    member: TokenToSeaCloudMember | null,
  ): TokenToSeaCloudReply | null {
    if (!member) return { status: 401, json: { error: 'unauthorized', message: 'TokenToSea 登录已失效，请重新登录' } };
    if (method === 'GET' && resource === 'models') return { json: { data: models } };
    if (method === 'GET' && resource === 'wallet') return { json: { ...member.wallet } };
    if (method === 'GET' && resource === 'grant') return { json: { ...member.grant } };
    if (method === 'GET' && resource === 'fantay/identity') {
      return { json: { issuer, client_id: TOKENTOSEA_CLIENT_ID, sub: member.sub, name: member.displayName, email: member.email } };
    }
    if (method === 'GET' && resource === 'official/runs') return { json: [] };
    if (method === 'POST' && resource === 'chat/completions') return chatCompletion(body);
    return null;
  }

  function chatCompletion(body: unknown): TokenToSeaCloudReply {
    const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const model = typeof input.model === 'string' ? input.model : 'e2e-chat';
    const content = options.chatReply ?? 'ok';
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (input.stream === true) {
      const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created, model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
      return {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        text: chunk({ delta: { role: 'assistant', content }, finish_reason: null })
          + chunk({ delta: {}, finish_reason: 'stop' }, { usage })
          + 'data: [DONE]\n\n',
      };
    }
    return {
      json: {
        id: 'chatcmpl-e2e', object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      },
    };
  }

  function stockSearchDefault(body: unknown, member: TokenToSeaCloudMember | null): TokenToSeaCloudReply {
    if (!member) return { status: 401, json: { error: '请使用 TokenToSea 登录' } };
    const slots = body && typeof body === 'object' && Array.isArray((body as { slots?: unknown }).slots)
      ? (body as { slots: Array<{ id?: unknown }> }).slots
      : [];
    // apps/share would call Wikimedia from this process; stay hermetic.
    return { json: { providers: ['e2e'], slots: slots.map((slot) => ({ id: String(slot.id ?? ''), status: 'not_found', attempts: [] })) } };
  }

  async function runOverrides(
    area: TokenToSeaCloudArea,
    input: TokenToSeaCloudHandlerInput,
  ): Promise<TokenToSeaCloudReply | undefined> {
    for (const handler of overrides.get(`${area} ${input.method} ${input.resource}`) ?? []) {
      const reply = await handler(input);
      if (reply !== undefined) return reply;
    }
    return undefined;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const method = (req.method ?? 'GET').toUpperCase();
    const record: TokenToSeaCloudRequest = {
      seq: ++seq,
      at: new Date().toISOString(),
      method,
      path: url.pathname,
      area: 'unknown',
      resource: '',
      member: null,
      status: 0,
      handledBy: 'unhandled',
      fromHarness: req.headers[HARNESS_HEADER] === '1',
    };
    log.push(record);
    res.once('finish', () => { record.status = res.statusCode; });

    const raw = await readBody(req);
    const body = parseBody(req.headers['content-type'], raw);
    const bearer = /^Bearer (\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const bearerMember = bearer ? memberForAccessToken(bearer) : null;
    if (bearerMember) record.member = bearerMember.name;

    let area: TokenToSeaCloudArea = 'unknown';
    let resource = '';
    let sharePath: string | null = null;
    if (url.pathname.startsWith('/api/oauth/')) {
      area = 'oauth';
      resource = url.pathname.slice('/api/oauth/'.length);
    } else if (url.pathname.startsWith('/api/v1/connect/')) {
      area = 'connect';
      resource = url.pathname.slice('/api/v1/connect/'.length);
    } else if (url.pathname === '/design' || url.pathname.startsWith('/design/')) {
      sharePath = url.pathname.slice('/design'.length) || '/';
      area = sharePath.startsWith('/api/') ? 'design' : 'share';
      resource = area === 'design' ? sharePath.slice('/api/'.length) : sharePath;
    } else if (/^\/(?:s|content|artifact)\//.test(url.pathname) || ['/', '/app.js', '/style.css', '/icon.svg'].includes(url.pathname)) {
      area = 'share';
      sharePath = url.pathname;
      resource = url.pathname;
    }
    record.area = area;
    record.resource = resource;
    if (area === 'design' && resource === 'collaboration' && body && typeof body === 'object') {
      const operation = (body as { operation?: unknown }).operation;
      const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
      if (typeof operation === 'string') record.operation = operation;
      if (typeof workspaceId === 'string') record.workspaceId = workspaceId;
    }

    if (area === 'unknown') {
      sendReply(res, { status: 404, json: { error: 'not_found', message: `fake TokenToSea cloud does not serve ${url.pathname}` } });
      return;
    }

    if (area !== 'share') {
      const override = await runOverrides(area, {
        member: bearerMember, method, resource, query: url.searchParams, body, headers: req.headers,
      });
      if (override) {
        record.handledBy = 'override';
        sendReply(res, override);
        return;
      }
    }

    if (area === 'oauth') {
      const form = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const reply = oauthDefault(method, resource, url.searchParams, form, bearerMember, record);
      record.handledBy = reply ? 'default' : 'unhandled';
      sendReply(res, reply ?? { status: 404, json: { error: 'not_found', message: `fake TokenToSea OAuth has no ${method} ${resource}` } });
      return;
    }
    if (area === 'connect') {
      const reply = connectDefault(method, resource, body, bearerMember);
      record.handledBy = reply ? 'default' : 'unhandled';
      sendReply(res, reply ?? { status: 404, json: { error: 'not_found', message: `fake TokenToSea connect has no ${method} ${resource}` } });
      return;
    }
    if (area === 'design' && method === 'POST' && resource === 'stock-search') {
      record.handledBy = 'default';
      sendReply(res, stockSearchDefault(body, bearerMember));
      return;
    }

    record.handledBy = 'share';
    const release = area === 'design' && resource === 'collaboration' ? await acquireCollaboration() : () => {};
    res.once('close', release);
    await forwardToShare(req, res, `${sharePath ?? '/'}${url.search}`, raw).finally(release);
  }

  function forwardToShare(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer): Promise<void> {
    const headers: IncomingHttpHeaders = { ...req.headers };
    delete headers['transfer-encoding'];
    delete headers.connection;
    delete headers[HARNESS_HEADER];
    headers.host = `127.0.0.1:${sharePort}`;
    headers['content-length'] = String(raw.length);
    return new Promise<void>((resolve) => {
      const upstream = httpRequest({ host: '127.0.0.1', port: sharePort, method: req.method, path, headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
        response.once('end', () => resolve());
        response.once('error', () => resolve());
      });
      upstream.once('error', (error) => {
        if (!res.headersSent) sendJson(res, 502, { error: 'share_unreachable', message: error.message });
        else res.end();
        resolve();
      });
      upstream.end(raw);
    });
  }

  async function collaboration<T>(name: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${endpoints.designBase}/collaboration`, {
      method: 'POST',
      headers: { authorization: `Bearer ${harnessToken(name)}`, 'content-type': 'application/json', [HARNESS_HEADER]: '1' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw Object.assign(
        new Error(`fake TokenToSea collaboration ${String(payload.operation)} as ${name} failed: HTTP ${response.status} ${text.slice(0, 300)}`),
        { status: response.status, body: parsed },
      );
    }
    return parsed as T;
  }

  const cloud: TokenToSeaCloud = {
    origin,
    issuer,
    endpoints,
    dataDir,
    share,
    egress: {
      enabled: options.egressGuard !== false,
      logPath: egressLog,
      read: () => readEgress(egressLog),
      loaded: async (role) => (await readEgress(egressLog))
        .filter((entry) => entry.via === 'loaded' && (role == null || entry.role === role)),
      blocked: async () => (await readEgress(egressLog)).filter((entry) => entry.via !== 'loaded' && entry.blocked),
      external: async (role) => (await readEgress(egressLog))
        .filter((entry) => entry.via !== 'loaded' && !entry.blocked && (role == null || entry.role === role)),
    },
    member: requireMember,
    addMember,
    env(extra = {}) {
      const guard = options.egressGuard !== false;
      const nodeOptions = [
        extra.NODE_OPTIONS ?? process.env.NODE_OPTIONS,
        guard ? `--import=${guardModuleUrl}` : undefined,
      ].filter(Boolean).join(' ');
      return {
        // An ambient client id/redirect from a developer shell must not change what the daemon presents.
        TOKENTOSEA_CLIENT_ID: undefined,
        TOKENTOSEA_REDIRECT_URI: undefined,
        [TOKENTOSEA_TEST_ORIGIN_ENV]: origin,
        ...(guard ? { [EGRESS_LOG_ENV]: egressLog, [EGRESS_DENY_ENV]: egressDeny.join(',') } : {}),
        ...extra,
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      };
    },
    issueTokens: (name, issue = {}) => issueTokens(name, issue),
    async seedSession(targetDataDir, name, seed = {}) {
      const member = requireMember(name);
      const cookie = seed.cookie ?? randomBytes(32).toString('base64url');
      if (!/^[\w-]{43}$/.test(cookie)) throw new Error('a TokenToSea session cookie must be 43 base64url characters');
      const grant = issueTokens(name, {
        accessTokenTtlMs: seed.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS,
        refreshToken: seed.refreshToken !== false,
      });
      const validUntil = Date.now() + (seed.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
      const file = join(targetDataDir, 'identity', 'tokentosea.json');
      let saved: { clientId?: string; sessions: Record<string, unknown> } = { sessions: {} };
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { sessions?: unknown };
        if (parsed.sessions && typeof parsed.sessions === 'object') saved = parsed as typeof saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Mirrors what TokenToSeaIdentity persists after a completed sign-in.
      saved.sessions[sessionDigest(cookie)] = {
        user: { id: member.userId, name: member.displayName, email: member.email },
        accessToken: grant.accessToken,
        ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
        expiresAt: grant.expiresAt,
        validUntil,
        clientId: TOKENTOSEA_CLIENT_ID,
      };
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
      await rename(temp, file);
      await chmod(file, 0o600);
      const cookieHeader = `${TOKENTOSEA_SESSION_COOKIE}=${cookie}`;
      return {
        member,
        cookie,
        cookieHeader,
        headers: { cookie: cookieHeader },
        userId: member.userId,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        validUntil,
        file,
      };
    },
    revokeTokens(name) {
      requireMember(name);
      let count = 0;
      for (const record of tokens.values()) {
        if (record.member === name && !record.harness && !record.revoked) {
          record.revoked = true;
          count += 1;
        }
      }
      return count;
    },
    queueLogin(next) {
      if (typeof next === 'string') requireMember(next);
      loginQueue.push(next);
    },
    handle(area, method, resource, handler) {
      const key = `${area} ${method.toUpperCase()} ${resource.replace(/^\/+/, '')}`;
      const list = overrides.get(key) ?? [];
      list.unshift(handler);
      overrides.set(key, list);
      return () => {
        const current = overrides.get(key);
        if (!current) return;
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    setModels(next) { models = next; },
    collaboration,
    createTeamWorkspace: (owner, name) => collaboration<TokenToSeaWorkspaceView>(owner, { operation: 'workspace.create', name }),
    async addWorkspaceMember(owner, workspaceId, memberName, role = 'member') {
      const invitation = await collaboration<{ token: string }>(owner, { operation: 'invitation.create', workspaceId, role });
      await collaboration(memberName, { operation: 'invitation.accept', token: invitation.token });
      return collaboration<TokenToSeaWorkspaceView>(memberName, { operation: 'workspace.get', workspaceId });
    },
    workspace: (name, workspaceId) => collaboration<TokenToSeaWorkspaceView>(name, { operation: 'workspace.get', workspaceId }),
    async publishTeamProject(owner, input) {
      const { workspaceId, projectId } = input;
      const upserted = await collaboration<{ ownerMemberId: string }>(owner, {
        operation: 'project.upsert',
        workspaceId,
        projectId,
        name: input.name ?? projectId,
        visibility: input.visibility ?? 'team',
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      // Same derivation the daemon uses for `team-projects ensure-private`.
      const resourceId = input.resourceId
        ?? `project-${Buffer.from(JSON.stringify([workspaceId, upserted.ownerMemberId, projectId])).toString('base64url')}`;
      const files = Object.entries(input.files).map(([path, content]) => {
        const bytes = Buffer.from(content);
        return { path, contentBase64: bytes.toString('base64'), sha256: sha256Hex(bytes) };
      });
      const pushed = await collaboration<{ versionId: string; version: number }>(owner, {
        operation: 'resource.push', workspaceId, projectId, resourceId, kind: 'project', files, ref: 'published',
      });
      const project = await collaboration<Record<string, unknown>>(owner, { operation: 'project.get', workspaceId, projectId });
      return { project, resourceId, versionId: pushed.versionId, version: pushed.version };
    },
    workspaceHeaders(view) {
      return {
        'x-od-workspace-id': view.workspaceId,
        'x-od-workspace-member-id': view.workspaceMemberId,
        'x-od-workspace-type': view.workspaceType === 'team' ? 'team' : 'personal',
        'x-od-workspace-role': view.role,
      };
    },
    requests(filter = {}) {
      return log.filter((entry) => Object.entries(filter).every(([key, value]) =>
        value === undefined || entry[key as keyof TokenToSeaCloudRequest] === value));
    },
    async close() {
      // Daemons keep pooled sockets open; drop them so close() does not wait on their idle timeout.
      const closed = new Promise<void>((resolve) => front.close(() => resolve()));
      front.closeAllConnections();
      await closed;
      share.close();
      share.server.closeAllConnections();
      if (ownsDataDir && options.keepData !== true) await rm(dataDir, { recursive: true, force: true });
    },
  };
  return cloud;
}

function listen(server: import('node:http').Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function parseBody(contentType: string | undefined, raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  const type = String(contentType ?? '').toLowerCase();
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  if (type.startsWith('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendReply(res: ServerResponse, reply: TokenToSeaCloudReply): void {
  const status = reply.status ?? 200;
  if (reply.text !== undefined) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...reply.headers });
    res.end(reply.text);
    return;
  }
  if (reply.json === undefined) {
    res.writeHead(status, { ...reply.headers });
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...reply.headers });
  res.end(JSON.stringify(reply.json));
}

async function readEgress(file: string): Promise<TokenToSeaEgressRecord[]> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: TokenToSeaEgressRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as TokenToSeaEgressRecord);
    } catch {
      // A torn final line from a still-running process is not evidence of anything.
    }
  }
  return records;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
