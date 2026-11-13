import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { HttpError, type User } from './types.js';
import type { ShareStore } from './store.js';

type RecordValue = Record<string, unknown>;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (v: unknown): RecordValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '请求格式无效');
  return v as RecordValue;
};
const text = (v: unknown, max = 160): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/u.test(v)) throw new HttpError(400, '参数无效');
  return v.trim();
};
type Member = { id: string; workspace_id: string; user_id: string; name: string; role: string };
type Workspace = { id: string; name: string; kind: string; revision: number };
type Project = { id: string; workspace_id: string; owner: string; name: string; visibility: string; metadata: string; revision: number; created_at: string; updated_at: string };

/** TokenToSea identities own all collaboration authority; no upstream account IDs are accepted. */
export class CollaborationStore {
  readonly db: DatabaseSync;
  private readonly blobs: string;
  constructor(directory: string, readonly origin: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.blobs = path.join(directory, 'collaboration-blobs');
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'collaboration.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,UNIQUE(workspace_id,user_id));
      CREATE TABLE IF NOT EXISTS invitations(token_hash TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,role TEXT NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT);
      CREATE TABLE IF NOT EXISTS projects(id TEXT NOT NULL,workspace_id TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,visibility TEXT NOT NULL,metadata TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
      CREATE TABLE IF NOT EXISTS resources(id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,owner TEXT NOT NULL,kind TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,resource_id TEXT NOT NULL,owner TEXT NOT NULL,manifest TEXT NOT NULL,created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS heads(workspace_id TEXT NOT NULL,resource_id TEXT NOT NULL,ref TEXT NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(workspace_id,resource_id,ref));
      CREATE TABLE IF NOT EXISTS comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,request_key TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(workspace_id,project_id,author,request_key));
      CREATE TABLE IF NOT EXISTS presence(workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,member_id TEXT NOT NULL,client_id TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,project_id,member_id,client_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS publications(slug TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,owner TEXT NOT NULL,resource_id TEXT NOT NULL,version_id TEXT NOT NULL,source_file_path TEXT NOT NULL,source_file_id TEXT,entry_path TEXT NOT NULL)');
    if (!(this.db.prepare('PRAGMA table_info(versions)').all() as Array<{ name: string }>).some(column => column.name === 'version')) this.db.exec('ALTER TABLE versions ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }

  private event(workspace: string, type: string, payload: unknown) {
    this.db.prepare('INSERT INTO events(workspace_id,type,payload,created_at) VALUES(?,?,?,?)').run(workspace, type, JSON.stringify(payload), new Date().toISOString());
  }
  private personal(user: User) {
    const id = `tts_personal_${digest(user.id).slice(0, 24)}`;
    this.db.prepare("INSERT OR IGNORE INTO workspaces(id,name,kind) VALUES(?,?,'personal')").run(id, user.name);
    this.db.prepare("INSERT INTO members VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET name=excluded.name").run(`tts_member_${digest(`${id}:${user.id}`).slice(0, 24)}`, id, user.id, user.name, 'owner');
  }
  private member(user: User, workspace: unknown, manage = false): Member {
    const id = text(workspace), member = this.db.prepare('SELECT * FROM members WHERE workspace_id=? AND user_id=?').get(id, user.id) as Member | undefined;
    if (!member || (manage && !['owner', 'admin'].includes(member.role))) throw new HttpError(403, '没有工作区权限');
    return member;
  }
  private project(member: Member, id: unknown, write = false): Project {
    const project = this.db.prepare('SELECT * FROM projects WHERE workspace_id=? AND id=?').get(member.workspace_id, text(id)) as Project | undefined;
    if (!project || project.visibility === 'deleted' || (project.visibility !== 'team' && project.owner !== member.id)) throw new HttpError(404, '项目不存在');
    if (write && project.owner !== member.id) throw new HttpError(403, '只有项目拥有者可以修改源文件');
    return project;
  }
  private view(member: Member, workspace: Workspace) {
    return { workspaceId: workspace.id, workspaceName: workspace.name, workspaceType: workspace.kind,
      workspaceMemberId: member.id, role: member.role, displayName: member.name, memberStatus: 'active',
      lifecycleState: 'active', billingState: 'free', planId: null, providerMode: 'personal_byok',
      billingOwnerKind: 'user', billingOwnerId: member.user_id, canInvite: member.role !== 'member',
      seatSummary: { usedSeats: Number((this.db.prepare('SELECT COUNT(*) AS n FROM members WHERE workspace_id=?').get(workspace.id) as { n: number }).n), seatLimit: 100 },
      revision: workspace.revision, workspaceSettingsUrl: `${this.origin}/?workspace=${encodeURIComponent(workspace.id)}` };
  }
  private projectView(project: Project, viewer?: Member) {
    const resource = this.db.prepare('SELECT id FROM resources WHERE workspace_id=? AND project_id=? AND owner=? LIMIT 1').get(project.workspace_id, project.id, project.owner) as { id: string } | undefined;
    const head = resource ? this.db.prepare("SELECT version_id FROM heads WHERE workspace_id=? AND resource_id=? AND ref='published'").get(project.workspace_id, resource.id) as { version_id: string } | undefined : undefined;
    return { id: project.id, projectId: project.id, workspaceId: project.workspace_id, ownerMemberId: project.owner, displayName: project.name,
      visibility: project.visibility, resourceId: resource?.id ?? null, metadata: JSON.parse(project.metadata),
      revision: project.revision, syncState: head ? 'synced' : 'pending_upload', publishedVersionId: head?.version_id ?? null, lastSyncedVersionId: head?.version_id ?? null,
      access: { canView: true, canComment: true, canEdit: viewer?.id === project.owner, frozen: false }, createdAt: project.created_at, updatedAt: project.updated_at };
  }

  private mergeMetadata(member: Member, old: Project | undefined, incoming: RecordValue): RecordValue {
    const mutation = incoming._commentFiles;
    const previous = object(old ? JSON.parse(old.metadata) : {});
    if (!mutation || !Object.hasOwn(object(mutation), 'baseRevision')) return { ...incoming, ...(previous._commentFiles ? { _commentFiles: previous._commentFiles } : {}) };
    const value = object(mutation);
    const state = previous._commentFiles ? object(previous._commentFiles) : { revision: 0, files: [] };
    if (value.schemaVersion !== 1 || value.baseRevision !== state.revision || !Array.isArray(value.files) || value.files.length > 1000) throw new HttpError(409, '评论文件版本不一致');
    const facts = new Map((state.files as RecordValue[]).map(fact => [String(fact.sourceFileId), fact]));
    for (const raw of value.files) {
      const file = object(raw), id = text(file.sourceFileId), source = text(file.sourceFilePath, 500), entry = text(file.entryPath, 500);
      if (!/^[a-f0-9-]{36}$/i.test(id) || ![source, entry].every(p => /\.html?$/i.test(p) && !p.startsWith('/') && !p.includes('\\') && p.split('/').every(part => part && part !== '.' && part !== '..')) || typeof file.retired !== 'boolean') throw new HttpError(400, '评论文件身份无效');
      const prior = facts.get(id), receipt = file.receipt ? object(file.receipt) : value;
      if (prior && (prior.sourceFilePath !== source || prior.retired === true && !file.retired)) throw new HttpError(409, '评论文件生命周期冲突');
      if (file.retired) {
        if (!prior || prior.entryPath !== entry || prior.resourceId !== receipt.resourceId || prior.versionId !== receipt.versionId) throw new HttpError(409, '评论文件退役依据无效');
      } else {
        if (!old) throw new HttpError(409, '评论文件尚未发布');
        const version = this.db.prepare('SELECT v.manifest FROM versions v JOIN resources r ON r.id=v.resource_id AND r.workspace_id=v.workspace_id WHERE v.id=? AND v.resource_id=? AND v.workspace_id=? AND v.owner=? AND r.project_id=?').get(text(value.versionId), text(value.resourceId, 500), member.workspace_id, member.id, old.id) as { manifest: string } | undefined;
        if (!version || !(JSON.parse(version.manifest) as Array<{ path: string }>).some(f => f.path === entry)) throw new HttpError(409, '评论文件尚未发布');
      }
      facts.set(id, { sourceFileId: id, sourceFilePath: source, entryPath: entry, retired: file.retired, resourceId: text(receipt.resourceId, 500), versionId: text(receipt.versionId) });
    }
    const paths = new Set<string>();
    for (const fact of facts.values()) if (!fact.retired) { if (paths.has(String(fact.sourceFilePath))) throw new HttpError(409, '评论文件路径冲突'); paths.add(String(fact.sourceFilePath)); }
    return { ...incoming, _commentFiles: { schemaVersion: 1, revision: Number(state.revision) + 1, files: [...facts.values()] } };
  }

  execute(user: User, raw: unknown): unknown {
    const b = object(raw), op = text(b.operation);
    this.personal(user);
    if (op === 'workspace.list') {
      const members = this.db.prepare('SELECT * FROM members WHERE user_id=? ORDER BY workspace_id').all(user.id) as Member[];
      return { workspaces: members.map(member => this.view(member, this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(member.workspace_id) as Workspace)) };
    }
    if (op === 'workspace.create') {
      if (Number((this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id=? AND role='owner'").get(user.id) as { n: number }).n) >= 30) throw new HttpError(409, '工作区数量已达上限');
      const id = `tts_workspace_${randomUUID()}`, memberId = `tts_member_${randomUUID()}`;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("INSERT INTO workspaces(id,name,kind) VALUES(?,?,'team')").run(id, text(b.name));
        this.db.prepare("INSERT INTO members VALUES(?,?,?,?, 'owner')").run(memberId, id, user.id, user.name);
        this.event(id, 'workspace.created', { workspaceId: id }); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return this.view(this.member(user, id), this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Workspace);
    }
    if (op === 'invitation.accept') {
      const token = text(b.token, 100), invitation = this.db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(digest(token)) as { workspace_id: string; role: string; expires_at: number; used_by: string | null } | undefined;
      if (!invitation || invitation.expires_at < Date.now() || invitation.used_by && invitation.used_by !== user.id) throw new HttpError(410, '邀请已失效');
      if (invitation.used_by) {
        const joined = this.db.prepare('SELECT id FROM members WHERE workspace_id=? AND user_id=?').get(invitation.workspace_id, user.id);
        if (!joined) throw new HttpError(410, '邀请已失效');
        return { ok: true, workspaceId: invitation.workspace_id };
      }
      if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM members WHERE workspace_id=?').get(invitation.workspace_id) as { n: number }).n) >= 100) throw new HttpError(409, '工作区成员已达上限');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?,?,?,?)').run(`tts_member_${randomUUID()}`, invitation.workspace_id, user.id, user.name, invitation.role);
        this.db.prepare('UPDATE invitations SET used_by=? WHERE token_hash=?').run(user.id, digest(token));
        this.event(invitation.workspace_id, 'members.changed', {}); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return { ok: true, workspaceId: invitation.workspace_id };
    }
    const member = this.member(user, b.workspaceId);
    const workspace = this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(member.workspace_id) as Workspace;
    if (op === 'workspace.get') return this.view(member, workspace);
    if (op === 'member.list') return { members: (this.db.prepare('SELECT * FROM members WHERE workspace_id=?').all(member.workspace_id) as Member[]).map(m => ({ memberId: m.id, displayName: m.name, role: m.role })) };
    if (op === 'invitation.create') {
      this.member(user, member.workspace_id, true);
      if (workspace.kind !== 'team') throw new HttpError(400, '个人工作区不能邀请成员');
      if (b.role === 'admin' && member.role !== 'owner') throw new HttpError(403, '只有拥有者可以邀请管理员');
      const role = b.role === 'admin' ? 'admin' : 'member', token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO invitations VALUES(?,?,?,?,NULL)').run(digest(token), member.workspace_id, role, Date.now() + 7 * 86400_000);
      return { token, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), url: `${this.origin}/?invite=${token}` };
    }
    if (op === 'member.remove' || op === 'member.role') {
      this.member(user, member.workspace_id, true);
      const target = this.db.prepare('SELECT * FROM members WHERE workspace_id=? AND id=?').get(member.workspace_id, text(b.memberId)) as Member | undefined;
      if (!target || target.role === 'owner' || member.role === 'admin' && target.role === 'admin') throw new HttpError(403, '不能修改此成员');
      if (op === 'member.remove') this.db.prepare('DELETE FROM members WHERE id=?').run(target.id);
      else this.db.prepare('UPDATE members SET role=? WHERE id=?').run(b.role === 'admin' ? 'admin' : 'member', target.id);
      this.event(member.workspace_id, 'members.changed', { memberId: target.id }); return { ok: true };
    }
    if (op === 'project.list') return { workspaceId: member.workspace_id, projects: (this.db.prepare("SELECT * FROM projects WHERE workspace_id=? AND visibility!='deleted' AND (owner=? OR visibility='team') ORDER BY updated_at DESC LIMIT 1000").all(member.workspace_id, member.id) as Project[]).map(p => this.projectView(p, member)) };
    if (op === 'project.upsert') {
      const id = text(b.projectId), now = new Date().toISOString();
      const old = this.db.prepare('SELECT * FROM projects WHERE workspace_id=? AND id=?').get(member.workspace_id, id) as Project | undefined;
      if (old && old.owner !== member.id) throw new HttpError(403, '只有项目拥有者可以修改项目');
      if (old && b.expectedRevision !== undefined && b.expectedRevision !== old.revision) throw new HttpError(409, '项目版本已变化');
      const metadata = b.metadata === undefined ? old?.metadata ?? '{}' : JSON.stringify(this.mergeMetadata(member, old, object(b.metadata)));
      if (metadata.length > 64 * 1024) throw new HttpError(413, '项目资料过大');
      const visibility = b.visibility === undefined ? old?.visibility ?? 'private' : b.visibility === 'team' ? 'team' : 'private';
      if (visibility === 'team' && workspace.kind !== 'team') throw new HttpError(400, '请先选择团队工作区');
      this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,visibility=excluded.visibility,metadata=excluded.metadata,revision=projects.revision+1,updated_at=excluded.updated_at')
        .run(id, member.workspace_id, member.id, b.name === undefined ? old?.name ?? id : text(b.name), visibility, metadata, 1, now, now);
      this.event(member.workspace_id, 'projects.changed', { projectId: id });
      return this.projectView(this.project(member, id), member);
    }
    if (op === 'project.get') return this.projectView(this.project(member, b.projectId), member);
    if (op === 'project.register-resource') {
      const project = this.project(member, b.projectId, true), id = text(b.resourceId, 500);
      const old = this.db.prepare('SELECT owner,project_id FROM resources WHERE workspace_id=? AND id=?').get(member.workspace_id, id) as { owner: string; project_id: string } | undefined;
      if (old && (old.owner !== member.id || old.project_id !== project.id)) throw new HttpError(403, '资源归属不符');
      this.db.prepare("INSERT OR IGNORE INTO resources VALUES(?,?,?,?, 'project','{}')").run(id, member.workspace_id, project.id, member.id);
      return { ...this.projectView(project, member), ok: true, resourceId: id };
    }
    if (op === 'project.remove') {
      const project = this.project(member, b.projectId, true);
      this.db.prepare("UPDATE projects SET visibility='deleted',revision=revision+1 WHERE workspace_id=? AND id=?").run(member.workspace_id, project.id);
      this.event(member.workspace_id, 'projects.changed', { projectId: project.id }); return { ok: true };
    }
    if (op.startsWith('resource.')) return this.resource(member, b, op);
    if (op === 'comment.batch') {
      if (!Array.isArray(b.comments) || b.comments.length > 500) throw new HttpError(400, '评论批次无效');
      return { results: b.comments.map(raw => {
        const item = object(raw), key = text(item.key);
        try { this.comment(member, { projectId: b.projectId, comment: item.comment }, 'comment.push'); return { key, ok: true }; }
        catch (error) { return { key, ok: false, status: error instanceof HttpError ? error.status : 500, error: error instanceof HttpError ? error.message : '评论同步失败', errorCode: 'TOKENTOSEA_COMMENT_REJECTED' }; }
      }) };
    }
    if (op === 'comment.align') return this.align(member, b);
    if (op.startsWith('comment.')) return this.comment(member, b, op);
    if (op.startsWith('presence.')) {
      const project = this.project(member, b.projectId);
      if (op === 'presence.heartbeat') {
        const clientId = text(b.clientId ?? 'default');
        const old = this.db.prepare('SELECT payload FROM presence WHERE workspace_id=? AND project_id=? AND member_id=? AND client_id=? AND expires_at>?').get(member.workspace_id, project.id, member.id, clientId, Date.now()) as { payload: string } | undefined;
        const filePath = typeof b.filePath === 'string' ? b.filePath.slice(0, 500) : null, activity = b.activity ?? null;
        this.db.prepare('INSERT INTO presence VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,project_id,member_id,client_id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at')
          .run(member.workspace_id, project.id, member.id, clientId, JSON.stringify({ memberId: member.id, displayName: member.name, role: member.role, filePath, activity, heartbeatAt: new Date().toISOString() }), Date.now() + 45_000);
        const previous = old ? JSON.parse(old.payload) : null;
        if (!previous || previous.filePath !== filePath || JSON.stringify(previous.activity) !== JSON.stringify(activity)) this.event(member.workspace_id, 'presence.changed', { projectId: project.id });
      }
      else if (op === 'presence.leave') { this.db.prepare('DELETE FROM presence WHERE workspace_id=? AND project_id=? AND member_id=? AND client_id=?').run(member.workspace_id, project.id, member.id, text(b.clientId ?? 'default')); this.event(member.workspace_id, 'presence.changed', { projectId: project.id }); }
      else if (op !== 'presence.list') throw new HttpError(400, '未知在线状态操作');
      return { viewers: (this.db.prepare('SELECT payload FROM presence WHERE workspace_id=? AND project_id=? AND expires_at>?').all(member.workspace_id, project.id, Date.now()) as Array<{ payload: string }>).map(row => JSON.parse(row.payload)) };
    }
    if (op === 'events.list') {
      const after = Number(b.after ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '事件游标无效');
      const events = this.db.prepare('SELECT * FROM events WHERE workspace_id=? AND seq>? ORDER BY seq LIMIT 200').all(member.workspace_id, after) as Array<{ seq: number; type: string; payload: string; created_at: string }>;
      return { events: events.map(e => ({ seq: e.seq, type: e.type, payload: JSON.parse(e.payload), createdAt: e.created_at })), cursor: events.at(-1)?.seq ?? after };
    }
    throw new HttpError(400, '未知协作操作');
  }

  private resource(member: Member, b: RecordValue, op: string): unknown {
    if (op === 'resource.list') {
      const resources = this.db.prepare("SELECT r.* FROM resources r JOIN projects p ON p.id=r.project_id AND p.workspace_id=r.workspace_id WHERE r.workspace_id=? AND p.visibility!='deleted' AND (p.owner=? OR p.visibility='team')").all(member.workspace_id, member.id) as Array<RecordValue>;
      return { resources: resources.map(r => {
        const head = this.db.prepare("SELECT v.id,v.version,v.created_at FROM heads h JOIN versions v ON v.id=h.version_id WHERE h.workspace_id=? AND h.resource_id=? AND h.ref='published'").get(member.workspace_id, String(r.id)) as { id: string; version: number; created_at: string } | undefined;
        return { id: r.id, teamId: member.workspace_id, kind: r.kind, ownerMemberId: r.owner, metadata: JSON.parse(String(r.metadata)), publishedVersion: head ? { id: head.id, version: head.version, createdAt: head.created_at } : null };
      }) };
    }
    const id = text(b.resourceId, 500);
    if (op === 'resource.push') {
      const project = this.project(member, b.projectId, true);
      if (!Array.isArray(b.files) || b.files.length > 1000) throw new HttpError(400, '文件清单无效');
      let size = 0; const names = new Set<string>();
      const blobs = new Map<string, Buffer>();
      const manifest = b.files.map(raw => {
        const file = object(raw), name = text(file.path, 500);
        if (name.startsWith('/') || name.includes('\\') || name.split('/').some(p => !p || p === '..' || p === '.') || names.has(name.normalize('NFC').toLowerCase())) throw new HttpError(400, '文件路径无效');
        names.add(name.normalize('NFC').toLowerCase());
        if (typeof file.contentBase64 !== 'string' || file.contentBase64.length > 28 * 1024 * 1024) throw new HttpError(413, '文件过大');
        const bytes = Buffer.from(file.contentBase64, 'base64'), hash = digest(bytes);
        if (bytes.toString('base64') !== file.contentBase64 || file.sha256 !== hash || (size += bytes.length) > 20 * 1024 * 1024) throw new HttpError(400, '文件内容校验失败');
        blobs.set(hash, bytes);
        return { path: name, sha256: hash, size: bytes.length };
      });
      const ref = text(b.ref ?? 'published'), previous = this.db.prepare('SELECT version_id FROM heads WHERE workspace_id=? AND resource_id=? AND ref=?').get(member.workspace_id, id, ref) as { version_id: string } | undefined;
      if (b.expectedVersion !== undefined && b.expectedVersion !== (previous?.version_id ?? null)) throw new HttpError(409, '资源版本已变化');
      const old = this.db.prepare('SELECT owner,project_id FROM resources WHERE workspace_id=? AND id=?').get(member.workspace_id, id) as { owner: string; project_id: string } | undefined;
      if (old && (old.owner !== member.id || old.project_id !== project.id)) throw new HttpError(403, '资源归属不符');
      const storedVersions = this.db.prepare('SELECT manifest FROM versions WHERE owner=?').all(member.id) as Array<{ manifest: string }>;
      const storedBytes = storedVersions.reduce((sum, row) => sum + (JSON.parse(row.manifest) as Array<{ size: number }>).reduce((total, file) => total + file.size, 0), 0);
      if (storedVersions.length >= 1000 || storedBytes + size > 2 * 1024 * 1024 * 1024) throw new HttpError(413, '协作存储已达上限');
      const version = `tts_version_${randomUUID()}`, now = new Date().toISOString();
      const createdBlobs: string[] = [];
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const locked = this.db.prepare('SELECT owner,project_id FROM resources WHERE workspace_id=? AND id=?').get(member.workspace_id, id) as { owner: string; project_id: string } | undefined;
        if (locked && (locked.owner !== member.id || locked.project_id !== project.id)) throw new HttpError(403, '资源归属不符');
        const lockedHead = this.db.prepare('SELECT version_id FROM heads WHERE workspace_id=? AND resource_id=? AND ref=?').get(member.workspace_id, id, ref) as { version_id: string } | undefined;
        if ((lockedHead?.version_id ?? null) !== (previous?.version_id ?? null)) throw new HttpError(409, '资源版本已变化');
        const lockedVersions = this.db.prepare('SELECT manifest FROM versions WHERE owner=?').all(member.id) as Array<{ manifest: string }>;
        const lockedBytes = lockedVersions.reduce((sum, row) => sum + (JSON.parse(row.manifest) as Array<{ size: number }>).reduce((total, file) => total + file.size, 0), 0);
        if (lockedVersions.length >= 1000 || lockedBytes + size > 2 * 1024 * 1024 * 1024) throw new HttpError(413, '协作存储已达上限');
        for (const [hash, bytes] of blobs) {
          const target = path.join(this.blobs, hash);
          if (!existsSync(target)) { writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' }); createdBlobs.push(target); }
        }
        this.db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET metadata=excluded.metadata').run(id, member.workspace_id, project.id, member.id, text(b.kind ?? 'project'), JSON.stringify(b.metadata ?? {}));
        const number = Number((this.db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM versions WHERE workspace_id=? AND resource_id=?').get(member.workspace_id, id) as { n: number }).n) + 1;
        this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(version, member.workspace_id, id, member.id, JSON.stringify(manifest), now, number);
        this.db.prepare('INSERT INTO heads VALUES(?,?,?,?) ON CONFLICT(workspace_id,resource_id,ref) DO UPDATE SET version_id=excluded.version_id').run(member.workspace_id, id, ref, version);
        this.event(member.workspace_id, 'resource.updated', { resourceId: id, projectId: project.id, versionId: version, version: number, ref, kind: b.kind ?? 'project' }); this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        for (const file of createdBlobs) { try { unlinkSync(file); } catch {} }
        throw error;
      }
      const saved = this.db.prepare('SELECT version FROM versions WHERE id=?').get(version) as { version: number };
      return { resourceId: id, versionId: version, version: saved.version, ref, createdAt: now, manifest };
    }
    const resource = this.db.prepare('SELECT * FROM resources WHERE workspace_id=? AND id=?').get(member.workspace_id, id) as { project_id: string; owner: string; kind: string } | undefined;
    if (!resource) throw new HttpError(404, '资源不存在');
    this.project(member, resource.project_id, op === 'resource.remove');
    // Subscribers route retractions by kind, as for `resource.updated`; without it a plugin/skill/design-system removal is read as a project one.
    if (op === 'resource.remove') { this.db.prepare('DELETE FROM resources WHERE workspace_id=? AND id=?').run(member.workspace_id, id); this.event(member.workspace_id, 'resource.removed', { resourceId: id, kind: resource.kind }); return { ok: true }; }
    const head = this.db.prepare('SELECT version_id FROM heads WHERE workspace_id=? AND resource_id=? AND ref=?').get(member.workspace_id, id, text(b.ref ?? 'published')) as { version_id: string } | undefined;
    if (!head) throw new HttpError(404, '资源版本不存在');
    const version = this.db.prepare('SELECT * FROM versions WHERE workspace_id=? AND resource_id=? AND id=? AND owner=?').get(member.workspace_id, id, head.version_id, resource.owner) as { manifest: string; created_at: string; version: number } | undefined;
    if (!version) throw new HttpError(404, '资源版本不存在');
    if (b.expectedVersion !== undefined && b.expectedVersion !== head.version_id && Number(b.expectedVersion) !== version.version) throw new HttpError(409, '资源版本已变化');
    const manifest = JSON.parse(version.manifest) as Array<{ path: string; sha256: string; size: number }>;
    if (op === 'resource.head') return { resourceId: id, versionId: head.version_id, version: version.version, createdAt: version.created_at, manifest };
    if (op === 'resource.pull') return { resourceId: id, versionId: head.version_id, version: version.version, manifest, files: manifest.map(f => ({ ...f, contentBase64: readFileSync(path.join(this.blobs, f.sha256)).toString('base64') })) };
    throw new HttpError(400, '未知资源操作');
  }

  private comment(member: Member, b: RecordValue, op: string): unknown {
    const project = this.project(member, b.projectId);
    if (op === 'comment.push') {
      const comments = Array.isArray(b.comments) ? b.comments : [b.comment];
      if (comments.length > 100) throw new HttpError(413, '评论批次过大');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const raw of comments) {
          const c = object(raw), requestKey = text(c.id ?? c.requestKey), payload = JSON.stringify({ ...c, memberId: member.id, authorKind: 'member', authorKey: member.user_id, authorDisplayName: member.name, author: { authorKey: member.user_id, displayName: member.name } });
          if (payload.length > 64 * 1024) throw new HttpError(413, '评论过大');
          const existing = this.db.prepare('SELECT author FROM comments WHERE id=?').get(requestKey) as { author: string } | undefined;
          if (existing && existing.author !== member.id) throw new HttpError(403, '不能修改其他人的评论');
          this.db.prepare('DELETE FROM comments WHERE workspace_id=? AND project_id=? AND author=? AND request_key=?').run(member.workspace_id, project.id, member.id, requestKey);
          this.db.prepare('INSERT INTO comments(id,workspace_id,project_id,author,name,payload,request_key) VALUES(?,?,?,?,?,?,?)').run(requestKey, member.workspace_id, project.id, member.id, member.name, payload, requestKey);
        }
        this.event(member.workspace_id, 'comments.changed', { projectId: project.id }); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } else if (op !== 'comment.pull') throw new HttpError(400, '未知评论操作');
    const after = Number(b.after ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '评论游标无效');
    const current = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM comments WHERE workspace_id=? AND project_id=?').get(member.workspace_id, project.id) as { n: number }).n);
    const watermark = b.watermark === undefined ? current : Number(b.watermark);
    const limit = b.limit === undefined ? 500 : Number(b.limit);
    if (!Number.isSafeInteger(watermark) || watermark < 0 || watermark > current || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, '评论分页参数无效');
    const all = this.db.prepare('SELECT seq,payload FROM comments WHERE workspace_id=? AND project_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(member.workspace_id, project.id, after, watermark, limit + 1) as Array<{ seq: number; payload: string }>;
    const rows = all.slice(0, limit);
    return { comments: rows.map(row => ({ ...JSON.parse(row.payload), projectId: project.id, seq: row.seq })), latestSeq: watermark, lastSeq: rows.at(-1)?.seq ?? after, hasMore: all.length > limit };
  }

  private align(member: Member, b: RecordValue): unknown {
    const project = this.project(member, b.projectId);
    const rows = this.db.prepare('SELECT seq,payload FROM comments WHERE workspace_id=? AND project_id=? ORDER BY seq').all(member.workspace_id, project.id) as Array<{ seq: number; payload: string }>;
    const latestSeq = rows.at(-1)?.seq ?? 0;
    if (latestSeq !== b.expectedLatestSeq) return { state: 'unknown', reason: 'snapshot_changed', latestSeq };
    if (!Array.isArray(b.comments) || rows.length > 10_000) return { state: 'unknown', reason: 'unavailable', latestSeq };
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
    const normalize = (value: unknown) => {
      const c = object(value), position = object(c.position);
      if (typeof c.id !== 'string' || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(position[key]))) throw new HttpError(400, '评论比较资料无效');
      const result: RecordValue = { id: c.id, selectionKind: c.selectionKind ?? 'element', status: c.status ?? 'open',
        style: c.style ?? null, memberCount: c.memberCount ?? 0, slideIndex: c.slideIndex ?? 0, authorKind: c.authorKind ?? 'member',
        position: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(Number(position[key]))])),
        attachments: Array.isArray(c.attachments) ? c.attachments.map(item => ({ id: object(item).id })) : [],
      };
      for (const key of ['filePath', 'elementId', 'selector', 'label', 'text', 'htmlHint', 'note']) result[key] = c[key] ?? '';
      return result;
    };
    try {
      const local = b.comments.map(normalize).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const remote = rows.map(row => JSON.parse(row.payload)).filter(c => !c.deleted).map(normalize).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return { state: JSON.stringify(canonical(local)) === JSON.stringify(canonical(remote)) ? 'aligned' : 'diverged', latestSeq };
    } catch { return { state: 'unknown', reason: 'unavailable', latestSeq }; }
  }

  async publication(user: User, raw: unknown, store: ShareStore): Promise<unknown> {
    const b = object(raw), operation = text(b.operation), member = this.member(user, b.workspaceId);
    const project = this.project(member, b.projectId, true);
    type Publication = { slug: string; resource_id: string; version_id: string; source_file_path: string; source_file_id: string | null; entry_path: string };
    const rows = () => this.db.prepare('SELECT * FROM publications WHERE workspace_id=? AND project_id=? AND owner=?').all(member.workspace_id, project.id, member.id) as Publication[];
    const view = (row: Publication) => {
      const share = store.get(row.slug, user);
      const version = this.db.prepare('SELECT version FROM versions WHERE id=? AND workspace_id=? AND resource_id=?').get(row.version_id, member.workspace_id, row.resource_id) as { version: number } | undefined;
      if (!version) throw new HttpError(409, '分享版本不完整');
      return { projectId: project.id, slug: row.slug, resourceId: row.resource_id, versionId: row.version_id,
        sourceFilePath: row.source_file_path, ...(row.source_file_id ? { sourceFileId: row.source_file_id } : {}),
        entryPath: row.entry_path, version: version.version, status: share.status,
        publishedAt: Date.parse(share.updatedAt), url: `${this.origin}/artifact/${encodeURIComponent(project.id)}/${row.slug}` };
    };
    if (operation === 'publication.project-status') {
      const publications = rows().map(view);
      return { projectId: project.id, bindingExists: publications.length > 0, publications };
    }
    const slug = text(b.slug);
    if (!/^[a-f0-9-]{36}$/.test(slug)) throw new HttpError(400, '分享标识无效');
    let row = rows().find(item => item.slug === slug);
    if (operation === 'publication.publish') {
      const resourceId = text(b.resourceId, 500), versionId = text(b.versionId), entryPath = text(b.entryPath, 500), sourceFilePath = text(b.sourceFilePath, 500);
      if (row && (row.source_file_path !== sourceFilePath || row.resource_id !== resourceId)) throw new HttpError(409, '分享归属不符');
      const version = this.db.prepare('SELECT v.manifest FROM versions v JOIN resources r ON r.id=v.resource_id AND r.workspace_id=v.workspace_id WHERE v.id=? AND v.resource_id=? AND v.workspace_id=? AND v.owner=? AND r.project_id=?')
        .get(versionId, resourceId, member.workspace_id, member.id, project.id) as { manifest: string } | undefined;
      if (!version) throw new HttpError(404, '分享版本不存在');
      const manifest = JSON.parse(version.manifest) as Array<{ path: string; sha256: string }>;
      const entry = manifest.find(file => file.path === entryPath);
      if (!entry) throw new HttpError(400, '分享入口不存在');
      const sourceFileId = typeof b.sourceFileId === 'string' ? b.sourceFileId : null;
      if (sourceFileId && !/^[a-f0-9-]{36}$/i.test(sourceFileId)) throw new HttpError(400, '分享文件身份无效');
      const documentKey = `compat:${digest(JSON.stringify([member.workspace_id, project.id, sourceFileId ?? sourceFilePath]))}`;
      const existing = store.list(user).find(share => share.documentKey === documentKey);
      if (existing && existing.id !== slug) throw new HttpError(409, '分享标识已绑定');
      if (existing?.status === 'stopped') throw new HttpError(409, '请先恢复分享，再更新内容');
      const files = manifest.filter(file => file.path !== 'index.html' || entryPath === 'index.html').map(file => ({ path: file.path, sha256: file.sha256, contentBase64: readFileSync(path.join(this.blobs, file.sha256)).toString('base64') }));
      if (entryPath !== 'index.html') files.push({ path: 'index.html', sha256: entry.sha256, contentBase64: readFileSync(path.join(this.blobs, entry.sha256)).toString('base64') });
      const current = existing ? store.get(slug, user) : null;
      await store.publish(user, { documentKey, title: typeof b.name === 'string' ? b.name : project.name, files,
        requestKey: `compat-${digest(JSON.stringify([slug, versionId]))}`, ...(current ? { expectedRevision: current.revision } : {}) }, slug);
      this.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET version_id=excluded.version_id,entry_path=excluded.entry_path')
        .run(slug, member.workspace_id, project.id, member.id, resourceId, versionId, sourceFilePath, sourceFileId, entryPath);
      row = rows().find(item => item.slug === slug)!;
      const result = view(row);
      return { ...result, status: 'published', snapshot: { versionId }, receipt: result };
    }
    if (!row) throw new HttpError(404, '分享不存在');
    if (b.sourceFilePath !== undefined && b.sourceFilePath !== row.source_file_path) throw new HttpError(409, '分享文件不符');
    if (operation === 'publication.bind' || operation === 'publication.resume') {
      const before = view(row);
      if (b.versionId !== row.version_id || b.resourceId !== row.resource_id || Number(b.version) !== before.version) throw new HttpError(409, '分享版本不符');
    }
    if (['publication.stop', 'publication.resume-existing', 'publication.resume'].includes(operation)) {
      const current = store.get(slug, user);
      store.changeState(user, slug, operation === 'publication.stop' ? 'stopped' : 'active', current.revision);
    }
    if (!['publication.status', 'publication.stop', 'publication.resume-existing', 'publication.resume', 'publication.bind'].includes(operation)) throw new HttpError(400, '未知分享操作');
    const result = view(row);
    if (operation === 'publication.bind' || operation === 'publication.resume') {
      if (b.versionId !== row.version_id || b.resourceId !== row.resource_id || Number(b.version) !== result.version) throw new HttpError(409, '分享版本不符');
    }
    return { ...result, verifiedVersion: result.version, verifiedVersionId: row.version_id };
  }

  publishedProjectMatches(projectId: string, slug: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM publications WHERE project_id=? AND slug=?').get(projectId, slug));
  }
  close() { this.db.close(); }
}
