import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readdir, readFile, mkdir, lstat, writeFile, realpath, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tokenToSeaRuntime } from './tokentosea-runtime.js';

interface Options { configuredEnv?: Record<string, string>; input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number }
type Cloud = (body: Record<string, unknown>) => Promise<any>;
function argumentsFor(args: string[]) {
  const positional: string[] = [], flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (!value.startsWith('--')) positional.push(value);
    else {
      const entry = args[i + 1];
      const items = flags.get(value) ?? [];
      items.push(entry && !entry.startsWith('--') ? args[++i]! : 'true'); flags.set(value, items);
    }
  }
  return { positional, flag: (name: string) => flags.get(name)?.at(-1), flags };
}
function safeFile(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid TokenToSea snapshot path');
  return value;
}
async function snapshot(root: string, exclusions: string[], prefixes: string[], signal?: AbortSignal) {
  const base = await realpath(root), files: Array<{ path: string; contentBase64: string; sha256: string }> = [];
  let bytes = 0;
  async function walk(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      if (exclusions.some(rule => rule.endsWith('/') ? entry.isDirectory() && entry.name === rule.slice(0, -1) : entry.name === rule)
        || prefixes.some(rule => rule.endsWith('/') ? entry.isDirectory() && entry.name.startsWith(rule.slice(0, -1)) : entry.name.startsWith(rule))) continue;
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 20 * 1024 * 1024 - bytes) throw new Error('TokenToSea snapshot exceeds its size limit');
        data = await handle.readFile({ signal });
      } finally { await handle.close(); }
      bytes += data.length;
      if (bytes > 20 * 1024 * 1024 || files.length >= 1000) throw new Error('TokenToSea snapshot exceeds its size limit');
      files.push({ path: path.relative(base, absolute).split(path.sep).join('/'), contentBase64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  await walk(base); return files;
}
async function materialize(root: string, files: Array<{ path: string; contentBase64: string; sha256: string }>, signal?: AbortSignal) {
  const destination = path.resolve(root);
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Snapshot destination cannot be a symlink');
  for (const file of files) {
    signal?.throwIfAborted();
    const relative = safeFile(file.path), data = Buffer.from(file.contentBase64, 'base64');
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Snapshot checksum mismatch');
    const pieces = relative.split('/'); let current = destination;
    for (const piece of pieces.slice(0, -1)) {
      current = path.join(current, piece); await mkdir(current, { recursive: true });
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Snapshot directory cannot be a symlink');
    }
    const target = path.join(destination, relative);
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Snapshot file cannot be a symlink');
    const temp = path.join(path.dirname(target), `.tts-${randomUUID()}.tmp`);
    try { await writeFile(temp, data, { mode: 0o600, flag: 'wx', signal }); signal?.throwIfAborted(); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
  }
}

/** Compatibility at the old command boundary; all operations now belong to TokenToSea. No subprocess. */
export async function runTokenToSeaCommand(args: string[], options: Options = {}): Promise<string> {
  const timeout = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signals = [options.signal, timeout].filter((value): value is AbortSignal => Boolean(value));
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  const runtime = tokenToSeaRuntime();
  const parsed = argumentsFor(args);
  const workspaceId = options.configuredEnv?.TOKENTOSEA_WORKSPACE_ID ?? options.configuredEnv?.VELA_WORKSPACE_ID ?? parsed.flag('--workspace-id');
  return runtime.inWorkspace(workspaceId, async () => {
    const { positional: p, flag, flags } = parsed, [domain, action, id] = p;
    let body = options.input === undefined ? {} : JSON.parse(String(options.input));
    if (options.input === undefined && flag('--comment-file') && flag('--comment-file') !== '-') {
      const data = await readFile(flag('--comment-file')!, { encoding: 'utf8', signal });
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error('Comment request exceeds its size limit');
      body = JSON.parse(data);
    }
    const cloud: Cloud = value => runtime.collaboration({ ...value, workspaceId }, signal);
    let result: unknown;
    if (flag('--help')) return `${domain} TokenToSea service\n`;
    if (domain === 'media' && action === 'stock-search') {
      result = await runtime.stockSearch(body, signal);
    } else if (domain === 'model' || domain === 'models') {
      result = { source: 'remote', data: (await runtime.models()).filter(m => !m.executionKind).map(m => ({ ...m, enabled: m.available !== false })) };
    } else if (domain === 'team-projects') {
      if (action === 'list') result = await cloud({ operation: 'project.list' });
      else if (action === 'get') result = await cloud({ operation: 'project.get', projectId: id });
      else if (action === 'remove') result = await cloud({ operation: 'project.remove', projectId: id });
      else if (action === 'upsert' || action === 'ensure-private' || action === 'visibility') {
        result = await cloud({ operation: 'project.upsert', projectId: id,
          ...(flag('--display-name') ? { name: flag('--display-name') } : {}),
          ...(flag('--metadata-json') ? { metadata: JSON.parse(flag('--metadata-json')!) } : {}),
          ...(action === 'visibility' ? { visibility: p[3] } : {}),
        });
        if (action === 'ensure-private' || flag('--resource-id')) {
          const record = result as { ownerMemberId: string };
          const resourceId = flag('--resource-id') ?? `project-${Buffer.from(JSON.stringify([workspaceId, record.ownerMemberId, id])).toString('base64url')}`;
          result = await cloud({ operation: 'project.register-resource', projectId: id, resourceId });
        }
      } else if (action === 'register-resource') result = await cloud({ operation: 'project.register-resource', projectId: id, resourceId: p[3] });
      else if (action === 'pull') {
        const project = await cloud({ operation: 'project.get', projectId: id });
        const value = await cloud({ operation: flag('--authorize-only') ? 'resource.head' : 'resource.pull', resourceId: project.resourceId, ref: flag('--ref') ?? 'published', ...(flag('--expected-version') ? { expectedVersion: flag('--expected-version') } : {}) });
        if (!flag('--authorize-only') && p[3]) await materialize(p[3], value.files, signal);
        const context = await cloud({ operation: 'workspace.get' }), now = Date.now();
        result = { ...value, id: value.versionId, schemaVersion: 1, projectId: id, workspaceId, resourceTeamId: workspaceId,
          viewerMemberId: context.workspaceMemberId, ownerMemberId: project.ownerMemberId, ref: 'published', lifecycleState: 'active',
          manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(value.manifest)).digest('hex')}`,
          manifestEntryCount: value.manifest.length, authorizedAt: new Date(now).toISOString(), expiresAt: new Date(now + 2000).toISOString(),
          access: { canView: true, canComment: true, canEdit: project.ownerMemberId === context.workspaceMemberId } };
      } else throw new Error(`Unsupported TokenToSea project operation: ${action}`);
    } else if (domain === 'resource') {
      if (action === 'shared') result = await cloud({ operation: 'resource.list' });
      else if (action === 'push') {
        const metadata = flag('--metadata-json') ? JSON.parse(flag('--metadata-json')!) : {};
        const projectId = metadata.projectId ?? `resource-${p[3]}`;
        const context = await cloud({ operation: 'workspace.get' });
        await cloud({ operation: 'project.upsert', projectId, name: metadata.displayName ?? projectId, visibility: context.workspaceType === 'team' ? 'team' : 'private', metadata });
        result = await cloud({ operation: 'resource.push', projectId, resourceId: p[3], kind: id,
          files: await snapshot(p[4]!, flags.get('--exclude') ?? [], flags.get('--exclude-prefix') ?? [], signal), ref: flag('--ref') ?? 'published', metadata });
      } else if (action === 'head' || action === 'pull' || action === 'remove') {
        const resourceId = action === 'pull' && p[4] ? p[3] : id;
        result = await cloud({ operation: `resource.${action}`, resourceId, ref: flag('--ref') ?? 'published', ...(flag('--expected-version') ? { expectedVersion: flag('--expected-version') } : {}) });
        if (action === 'pull') await materialize((p[4] ?? p[3])!, (result as any).files, signal);
      } else if (action === 'pull-batch') {
        const requests = Array.isArray(body.requests) ? body.requests : [];
        const results = [];
        for (const request of requests) {
          signal?.throwIfAborted();
          try {
            const value = await cloud({ operation: 'resource.pull', resourceId: request.resourceId, ref: request.ref ?? 'published', ...(request.expectedVersionId ? { expectedVersion: request.expectedVersionId } : {}) });
            await materialize(request.destDir ?? request.destination ?? request.dir, value.files, signal);
            results.push({ ...value, key: request.key, id: value.versionId, ok: true });
          } catch (error) { results.push({ key: request.key, ok: false, error: error instanceof Error ? error.message : 'TokenToSea pull failed' }); }
        }
        result = { results };
      } else throw new Error(`Unsupported TokenToSea resource operation: ${action}`);
      if (result && typeof result === 'object' && 'versionId' in result) result = { ...result, id: (result as any).versionId };
    } else if (domain === 'share') {
      const sourceKey = flag('--source-key');
      const sourceFileId = sourceKey?.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1];
      result = await cloud({ operation: `publication.${action}`, projectId: action === 'project-status' ? id : flag('--project-id'),
        slug: action === 'publish' ? flag('--slug') : id, resourceId: action === 'publish' ? id : flag('--resource-id'),
        versionId: flag('--version-id'), version: flag('--version'), sourceFilePath: flag('--source-file-path'), sourceFileId,
        entryPath: flag('--entry-path'), name: flag('--name') });
    } else if (domain === 'collab') {
      const command = action, verb = id, projectId = p[3];
      if (command === 'member') {
        const value = await cloud({ operation: 'member.list' });
        const context = await cloud({ operation: 'workspace.get' });
        result = verb === 'register' ? { member: value.members.find((m: any) => m.memberId === context.workspaceMemberId) } : value;
      } else if (command === 'presence') result = await cloud({ operation: `presence.${verb}`, projectId, clientId: flag('--client-id'), filePath: flag('--file-path'), ...(flag('--activity-json') ? { activity: JSON.parse(flag('--activity-json')!) } : {}) });
      else if (command === 'comment') {
        if (verb === 'push') {
          const value = await cloud({ operation: 'comment.push', projectId, comment: body });
          result = value.comments.find((c: any) => c.id === body.id) ?? { seq: value.latestSeq };
        } else if (verb === 'push-batch') {
          result = await cloud({ operation: 'comment.batch', projectId, comments: body.comments });
        } else if (verb === 'align') {
          result = await cloud({ operation: 'comment.align', projectId, ...body });
        } else if (verb === 'pull' && flag('--mode')) {
          const mode = flag('--mode'), context = await cloud({ operation: 'workspace.get' });
          const scopeToken = createHash('sha256').update(JSON.stringify([workspaceId, projectId, context.workspaceMemberId])).digest('hex');
          const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
          let after = 0, watermark: number | undefined;
          const cursor = flag('--page-token') ?? flag('--resume-token');
          if (cursor) {
            const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { scope: string; after: number; watermark?: number; mode?: string };
            if (decoded.scope !== scopeToken || !Number.isSafeInteger(decoded.after) || decoded.after < 0 || flag('--page-token') && decoded.mode !== mode) throw Object.assign(new Error('TokenToSea cursor scope changed'), { code: 'SCOPE_CHANGED', status: 409 });
            after = decoded.after; watermark = flag('--page-token') ? decoded.watermark : undefined;
          }
          const value = await cloud({ operation: 'comment.pull', projectId, after, limit: Number(flag('--limit') ?? 100), ...(watermark === undefined ? {} : { watermark }) });
          const resumeToken = encode({ scope: scopeToken, after: value.latestSeq });
          result = { mode, comments: value.comments, hasMore: value.hasMore, complete: !value.hasMore,
            nextPageToken: value.hasMore ? encode({ scope: scopeToken, after: value.lastSeq, watermark: value.latestSeq, mode }) : null,
            resumeToken: value.hasMore ? null : resumeToken, scopeToken, watermarkSeq: value.latestSeq,
            scanThroughSeq: value.hasMore ? value.lastSeq : value.latestSeq, streamEpoch: 'tokentosea-v1',
            handoff: !value.hasMore && mode === 'snapshot' ? { sinceSeq: value.latestSeq, resumeToken, scopeToken } : null,
          };
        } else if (verb === 'pull') result = await cloud({ operation: 'comment.pull', projectId, after: Number(flag('--since-seq') ?? 0) });
        else throw new Error(`Unsupported TokenToSea comment operation: ${verb}`);
      } else throw new Error(`Unsupported TokenToSea collaboration operation: ${command}`);
    } else if (domain === 'billing') {
      const wallet = await runtime.json<{ balanceUsd: string; availableUsd: string }>('wallet');
      result = { balanceUsd: wallet.balanceUsd, availableUsd: wallet.availableUsd, totalAvailableCreditsUsd: wallet.availableUsd, currency: 'USD', provider: 'tokentosea' };
    } else throw new Error(`Unsupported TokenToSea operation: ${domain}`);
    return JSON.stringify(result);
  });
}
